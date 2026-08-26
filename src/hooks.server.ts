import type { Handle, HandleServerError, RequestEvent } from '@sveltejs/kit';
import { sequence } from '@sveltejs/kit/hooks';
import {
	createAuthHandle,
	defineAuthConfig,
	type AuthServer,
	type AuthLocals,
} from '@delightstack/auth/server';
import { serializeSessionCookie } from '@delightstack/auth/sveltekit';
import { createWebsocketHandle } from '@delightstack/websocket/server';
import { createDatabaseHandle } from '@delightstack/database/server';
import { createAiHandle } from '@delightstack/ai/server';
import { DelightError, createDevHandle } from '@delightstack/utilities';
import { env } from '$env/dynamic/private';
import { env as public_env } from '$env/dynamic/public';
import { building, dev } from '$app/environment';
import { tables } from '$lib/schema';
import { sendTransactionalEmail } from '$lib/server/email';
import { createMailHandle } from '$lib/server/mail-handle';
import { reportEnvOnce } from '$lib/server/env-check';
import { isDevEnv } from '$lib/server/is-dev';
import { limitMagicLink, type RateLimiterNamespace } from '$lib/server/rate-limit';

// A valid 64-char hex secret for dev only; production MUST set JWT_KEY_SECRET.
const DEV_SECRET = '00000000000000000000000000000000000000000000000000000000deadbeef';

/**
 * The session-signing secret, resolved once at module load and FAILING CLOSED in
 * production. The app worker verifies session cookies statelessly (HMAC, no
 * round-trip to the AuthServer), so if a real deploy fell back to the published
 * DEV_SECRET, anyone could forge a signed-in session for any user/org. The
 * server worker's resolveJwtSecret() enforces the same rule; the two MUST agree.
 * `dev` is a build-time constant, so this throw only ever fires on a misconfigured
 * production build — where refusing to boot is the correct outcome.
 */
function resolveAuthSecret(): string {
	if (env.JWT_KEY_SECRET) return env.JWT_KEY_SECRET;
	if (isDevEnv()) return DEV_SECRET;
	throw new Error(
		'JWT_KEY_SECRET is not set. Set it to a 64-char hex value (openssl rand -hex 32) on ' +
			'BOTH workers: `pnpm run secrets secrets.env` or `wrangler secret put JWT_KEY_SECRET`.',
	);
}

/**
 * The canonical origin of this deployment, or undefined when none is pinned.
 *
 * PUBLIC_APP_URL must be read from `$env/dynamic/public`: SvelteKit filters the
 * public prefix *out* of `$env/dynamic/private`, so `env.PUBLIC_APP_URL` there is
 * always undefined — even in production with the var set. Reading it from the
 * wrong module is what pointed every deployed magic link at localhost.
 *
 * Undefined is a meaningful return: it makes the auth library fall back to the
 * origin of the incoming request, which is correct for a deployment that has not
 * pinned a canonical URL. Never guess localhost here.
 */
function appOrigin(): string | undefined {
	return public_env.PUBLIC_APP_URL || undefined;
}

function rpId(): string | undefined {
	const origin = appOrigin();
	if (!origin) return undefined; // → library defaults to the request hostname
	try {
		return new URL(origin).hostname;
	} catch {
		return undefined;
	}
}

/** Whether a given email is allowed to create an account. */
function signupAllowed(email: string): boolean {
	if (env.SIGNUPS_ENABLED === 'true') return true;
	const owners = (env.OWNER_EMAIL ?? '')
		.split(/[,\s]+/)
		.map((e) => e.trim().toLowerCase())
		.filter(Boolean);
	if (owners.length === 0) return isDevEnv(); // dev: allow anyone; prod: locked until OWNER_EMAIL set
	return owners.includes(email.trim().toLowerCase());
}

function clientIp(event: RequestEvent): string {
	try {
		return event.getClientAddress();
	} catch {
		return event.request.headers.get('cf-connecting-ip') ?? '';
	}
}

/**
 * First contact — create the account for an address that has never signed in.
 *
 * The library's magic-link route only mails an address that already has a user
 * (`createEmailSignInToken` throws "Couldn't find user with given email"), so a
 * brand-new address needs a user row before the link can be sent. We make it here,
 * server-side, and drop the session `signUpWithEmail` returns on the floor.
 *
 * That discarded session is the entire point. `POST /api/auth/signup` answers with
 * a live session cookie, so anything that calls it signs the browser in for an
 * address it has never proven it controls. Creating the user out-of-band leaves the
 * emailed link and code as the only ways to get a session.
 */
async function ensureUserExists(
	penv: App.CloudflareEnv | undefined,
	event: RequestEvent,
	email: string,
): Promise<void> {
	const ns = penv?.AUTH;
	if (!ns) return;
	const auth = ns.get(ns.idFromName('main')) as unknown as AuthServer;
	try {
		await auth.signUpWithEmail(
			{ name: email.split('@')[0] || email, email },
			{
				ip_address: clientIp(event) || undefined,
				user_agent: event.request.headers.get('user-agent') ?? undefined,
			},
		);
	} catch {
		// Already registered — `checkEmailAvailability` throws. Nothing to do; the
		// magic-link route below will find the user and mail them.
	}
}

// ---------------------------------------------------------------------------
// 0. Signup gate — the ONLY way into this instance is a magic link or code that
//    was mailed to the address being claimed. `/api/auth/signup` hands out a
//    session without any such proof, so it is sealed off entirely and sign-up
//    happens as a side effect of the first sign-in request (ensureUserExists).
// ---------------------------------------------------------------------------
const signupGateHandle: Handle = async ({ event, resolve }) => {
	// Capture platform env for the auth sendEmail closure (env is
	// deployment-constant, so caching the first non-empty value is safe).
	const penv = (event.platform as App.Platform | undefined)?.env;
	if (penv) {
		_last_env = penv;
		reportEnvOnce(penv as unknown as Record<string, string | undefined>, { dev: isDevEnv() });
	}

	const p = event.url.pathname;

	// No unverified path to a session, for anyone, ever.
	if (p.startsWith('/api/auth/signup')) {
		return DelightError.forbidden(
			'Accounts are created by requesting a sign-in link. Enter your email to get one.',
		).toResponse();
	}

	if (event.request.method !== 'POST' || p !== '/api/auth/signin/email/magic') {
		return resolve(event);
	}

	// Peek the email without consuming the body (clone).
	let email = '';
	try {
		const body = (await event.request.clone().json()) as { email?: string };
		email = typeof body?.email === 'string' ? body.email : '';
	} catch {
		/* not JSON — let auth handle validation */
	}
	if (email && !signupAllowed(email)) {
		// Only OWNER_EMAIL addresses (or anyone, when SIGNUPS_ENABLED) may hold an
		// account here, and an address with no account can never sign in, so gating
		// the sign-in request gates account creation too.
		return DelightError.forbidden(
			'This instance is not accepting new sign-ups. Ask the owner for access.',
		).toResponse();
	}

	// Rate-limit the (allowed) request so a known address can't be email-bombed via
	// unlimited magic-link POSTs. Fails open on a limiter outage.
	const rl = penv?.RATE_LIMITER as unknown as RateLimiterNamespace | undefined;
	if (rl) {
		const { allowed, reset_in_ms } = await limitMagicLink(rl, email, clientIp(event));
		if (!allowed) {
			const retry = Math.max(1, Math.ceil((reset_in_ms || 60_000) / 1000));
			return new Response(
				JSON.stringify({ message: 'Too many sign-in requests. Please try again shortly.' }),
				{
					status: 429,
					headers: { 'content-type': 'application/json', 'retry-after': String(retry) },
				},
			);
		}
	}

	if (email) await ensureUserExists(penv, event, email);
	return resolve(event);
};

// ---------------------------------------------------------------------------
// 0b. Email links — the two auth routes a user reaches by clicking a link in an
//     email. createAuthHandle answers both with `{ jwt, decoded_jwt, redirect }`
//     JSON plus a Set-Cookie, which is right for the AuthClient's fetch() but
//     dumps raw JSON in the face of anyone arriving by navigation. Rewrite the
//     JSON into a real redirect, carrying the session cookie across.
// ---------------------------------------------------------------------------
const EMAIL_LINK_ROUTES = new Set([
	'/api/auth/signin/email/verify', // magic-link sign-in
	'/api/auth/email/verify/confirm', // address verification after signup
]);

/** Never let `?redirect=` bounce the user off-origin. */
function safeRedirect(target: unknown): string {
	if (typeof target !== 'string') return '/';
	if (!target.startsWith('/') || target.startsWith('//')) return '/';
	return target;
}

const emailLinkHandle: Handle = async ({ event, resolve }) => {
	const navigated =
		event.request.method === 'GET' &&
		EMAIL_LINK_ROUTES.has(event.url.pathname) &&
		(event.request.headers.get('accept') ?? '').includes('text/html');
	if (!navigated) return resolve(event);

	const response = await resolve(event);
	const body = (await response
		.clone()
		.json()
		.catch(() => ({}))) as {
		redirect?: string;
		message?: string;
	};

	// Carry Set-Cookie over by hand: `new Headers(res.headers)` is not guaranteed
	// to preserve multiple set-cookie entries, and the session cookie is the whole
	// point of the round trip.
	const headers = new Headers({ 'cache-control': 'no-store' });
	for (const cookie of response.headers.getSetCookie()) headers.append('set-cookie', cookie);

	if (response.ok) {
		headers.set('location', safeRedirect(body.redirect));
		return new Response(null, { status: 303, headers });
	}

	// Send them back to sign in with the reason rather than a JSON error blob. Only
	// a 4xx carries a message meant for the user (expired or already-used link); a
	// 5xx is an infrastructure failure whose text has no business in the URL bar.
	const client_error = response.status >= 400 && response.status < 500;
	const reason =
		client_error && typeof body.message === 'string' && body.message.length <= 200
			? body.message
			: 'That sign-in link is no longer valid. Request a new one.';
	headers.set('location', `/signin?error=${encodeURIComponent(reason)}`);
	return new Response(null, { status: 303, headers });
};

type SessionOrgs = { org?: Record<string, { p?: number }> } | null;

/**
 * Which org this request acts on, chosen from the ones carried in the session JWT.
 *
 * Must be **stable**: the mailbox DO is keyed by org_id, so a resolver that returned
 * a different org from one request to the next would silently hand out a different
 * (empty) mailbox. Sorting the ids gives the same answer every time. Orgs where the
 * user actually holds a permission win over ones where they hold none, so an account
 * carrying junk orgs from the duplicate-org bug lands on a properly-owned one.
 */
function pickOrg(event: RequestEvent, session: SessionOrgs): string | null {
	const orgs = session?.org ?? {};
	const ids = Object.keys(orgs);
	if (!ids.length) return null;

	// An explicit choice still wins — but only if the session actually grants it.
	// (No route in this app carries an :org_id param, so there's nothing to read there.)
	const explicit = event.url.searchParams.get('org') || event.request.headers.get('Org-ID');
	if (explicit && explicit !== 'null' && ids.includes(explicit)) return explicit;

	const owned = ids.filter((id) => (orgs[id]?.p ?? 0) !== 0);
	return (owned.length ? owned : ids).sort()[0];
}

// ---------------------------------------------------------------------------
// 1. Auth — magic link + passkeys + sessions + /api/auth/*
// ---------------------------------------------------------------------------
const auth_config = defineAuthConfig({
	secret: resolveAuthSecret(),
	issuer: 'delightmail',
	permissions: ['owner', 'admin', 'member'] as const,
	oauth_scopes: [] as const,
	entitlements: ['ai', 'push', 'domains'] as const,
	dev: isDevEnv(),
	// The library defaults this to 'org:admin', which is not one of our permissions,
	// so the owner of a new org was encoded with a permission bitfield of 0 — no
	// permissions at all in their own mailbox.
	org_admin_permission: 'owner',
	// The library's default resolver auto-selects an org only when the user has
	// EXACTLY ONE, and returns null otherwise. Null org_id means "no mailbox", so a
	// user who somehow acquired a second personal org could never reach their mail
	// again — and the old client-side createOrg reacted to that by making yet another
	// org on every page load, which is how one account ended up with ten of them.
	// Resolving deterministically makes a duplicate org merely untidy instead of fatal.
	resolveOrgId: (event, session) => pickOrg(event, session as SessionOrgs),
	session: { expires_in: 60 * 60 * 24 * 30 }, // 30-day rolling sessions
	email: {
		link: true,
		code: true,
		// Undefined → the library builds links against the request origin.
		base_url: appOrigin(),
		sendEmail: async ({ to, subject, html, text }) => {
			await sendTransactionalEmail(event_env(), { to, subject, html, text }, { dev: isDevEnv() });
		},
	},
	// `passkeys`, not `passkey` — the singular key was silently ignored, so every
	// field below was dead config. Each falls back to the request's own host /
	// origin when PUBLIC_APP_URL is unset.
	passkeys: {
		rp_id: rpId(),
		rp_name: 'Mail',
		origins: appOrigin() ? [appOrigin() as string] : undefined,
	},
});

/** The AuthServer DO stub (one instance, named 'main') — the auth database. */
function authServer(event: RequestEvent): AuthServer | undefined {
	const ns = (event.platform as App.Platform | undefined)?.env?.AUTH;
	if (!ns) return undefined;
	return ns.get(ns.idFromName('main')) as unknown as AuthServer;
}

// ---------------------------------------------------------------------------
// 0c. Dev sign-in — `POST /api/dev/signin` mints a session for OWNER_EMAIL (or any
//     address when SIGNUPS_ENABLED) without the magic-link round trip, so
//     `pnpm dev:seed` can sign in headlessly. Only exists in local dev (isDevEnv)
//     and only answers a localhost origin — belt and braces, since the DEV flag
//     that enables it is itself refused on non-local deployments (env-check).
// ---------------------------------------------------------------------------
const devSigninHandle: Handle = async ({ event, resolve }) => {
	if (event.url.pathname !== '/api/dev/signin' || event.request.method !== 'POST') {
		return resolve(event);
	}
	const local = event.url.hostname === 'localhost' || event.url.hostname === '127.0.0.1';
	if (!isDevEnv() || !local) return new Response('Not found', { status: 404 });

	const body = (await event.request.json().catch(() => ({}))) as { email?: string };
	// Under `vite dev` the private env comes from `.env`, not `.dev.vars` — the
	// platform env (getPlatformProxy) is where OWNER_EMAIL actually lives there.
	const owner = env.OWNER_EMAIL || (event.platform as App.Platform | undefined)?.env?.OWNER_EMAIL;
	const email = (body.email ?? owner?.split(/[,\s]+/)[0] ?? '').trim().toLowerCase();
	if (!email) return DelightError.badRequest('No email (set OWNER_EMAIL or pass one)').toResponse();
	if (!signupAllowed(email)) return DelightError.forbidden('Not an allowed address').toResponse();
	const auth = authServer(event);
	if (!auth) return DelightError.badRequest('No AUTH binding').toResponse();

	const meta = {
		ip_address: clientIp(event) || undefined,
		user_agent: event.request.headers.get('user-agent') ?? undefined,
	};
	let jwt: string;
	try {
		// First contact: signing up returns a live session directly.
		jwt = (await auth.signUpWithEmail({ name: email.split('@')[0] || email, email }, meta)).jwt;
	} catch {
		// Already registered: mint a sign-in token and trade it for a session — the
		// exact exchange a clicked magic link performs, minus the email.
		const token = await auth.createEmailSignInToken(email, meta);
		jwt = (await auth.signInWithEmailToken({ email_signin_token: token.jwt }, meta)).jwt;
	}
	return new Response(JSON.stringify({ ok: true, email }), {
		status: 200,
		headers: {
			'content-type': 'application/json',
			'set-cookie': serializeSessionCookie(auth_config, jwt),
			'cache-control': 'no-store',
		},
	});
};

const authHandle = createAuthHandle({
	config: auth_config,
	getAuthServer: (event) => authServer(event) as AuthServer,
	building,
});

// `sendEmail` closes over the request env; expose the last-seen platform env.
let _last_env: App.CloudflareEnv | undefined;
function event_env(): App.CloudflareEnv | undefined {
	return _last_env;
}

// ---------------------------------------------------------------------------
// 1b. Mailbox org — every session must own an org, because the mailbox DO is
//     keyed by org_id (appHandle, below). A session without one has nowhere to
//     put mail, which is what surfaced as "No mailbox for this session".
//
//     This used to be done in the browser: the mail and settings layout loads
//     called auth.createOrg() when they noticed a missing org_id. That made a
//     session's mailbox depend on client-side code running AND succeeding — and
//     when it didn't (silently, in production), the account was left permanently
//     unusable with no way to recover from the UI. Provision it server-side
//     instead, on the first authenticated request, before any route can ask for
//     locals.db.
// ---------------------------------------------------------------------------
function personalOrgName(name?: string): string {
	return `${name || 'Personal'}'s Mail`;
}

/**
 * Give the signed-in user an org if they lack one, and re-mint their session so
 * it carries it. Returns the new JWT, or null if nothing was done.
 *
 * The org lives *inside* the JWT (`session.org`), so creating the row is not
 * enough — the session has to be refreshed or the very next request looks just
 * as org-less as this one did.
 */
async function provisionOrg(
	event: RequestEvent,
	session: { uid: string; jti: string; name?: string },
): Promise<{ org_id: string; jwt: string } | null> {
	// The generated DO stub types blow the TS instantiation depth on the org query,
	// and `createOrg` types created_at/updated_at as required even though the DO
	// stamps them on insert. Narrow the three methods we need by hand.
	const auth = authServer(event) as unknown as
		| {
				listOrgs(query: unknown): Promise<{ id: string }[]>;
				createOrg(org: Record<string, unknown>): Promise<{ id: string }>;
				refreshSession(
					jti: string,
					meta: Record<string, unknown>,
				): Promise<{ jwt: string; decoded_jwt: { org?: Record<string, unknown> } }>;
		  }
		| undefined;
	if (!auth) return null;

	// Find-or-create. A previous attempt may have created the org and then failed
	// to land the refreshed cookie, so never blindly create a second one.
	const owned = await auth.listOrgs({
		where: { key: 'owner_id', is: '=', value: session.uid },
		limit: 1,
	});
	const existing = Array.isArray(owned) ? owned[0] : undefined;

	const org = existing
		? existing
		: await auth.createOrg({
				id: crypto.randomUUID(),
				name: personalOrgName(session.name),
				owner_id: session.uid,
				db_id: '',
				plan: 0,
				json: '{}',
			});

	const refreshed = await auth.refreshSession(session.jti, {
		ip_address: clientIp(event) || undefined,
		user_agent: event.request.headers.get('user-agent') ?? undefined,
	});

	// Never hand back a session that still can't see an org: the caller redirects on
	// success, and redirecting to a request that will provision all over again is an
	// infinite loop — which is exactly what shipped when org resolution could return
	// null for a user who *did* have orgs.
	if (!Object.keys(refreshed.decoded_jwt.org ?? {}).length) {
		throw new Error(`refreshed session for ${session.uid} still carries no org`);
	}
	return { org_id: org.id, jwt: refreshed.jwt };
}

const orgHandle: Handle = async ({ event, resolve }) => {
	const locals = event.locals as AuthLocals & App.Locals;
	if (!locals.session || locals.org_id) return resolve(event);

	let provisioned: { org_id: string; jwt: string } | null = null;
	try {
		provisioned = await provisionOrg(event, locals.session);
	} catch (err) {
		// Leave org_id unset: the route guards below answer with a clear error rather
		// than handing out a half-provisioned mailbox.
		console.error('[org] could not provision a mailbox for this session:', err);
	}
	if (!provisioned) return resolve(event);

	const cookie = serializeSessionCookie(auth_config, provisioned.jwt);

	// A page load: bounce through the same URL once so the auth handle re-runs against
	// the new cookie and rebuilds `locals` — including the auth_client_data the browser
	// uses to namespace its local database. Patching those by hand here would mean
	// reaching into the library's session shape and getting it subtly wrong.
	if (!event.url.pathname.startsWith('/api/')) {
		return new Response(null, {
			status: 303,
			headers: {
				location: event.url.pathname + event.url.search,
				'set-cookie': cookie,
				'cache-control': 'no-store',
			},
		});
	}

	// An API call: no document to rebuild, so patch the org onto locals in place.
	// appHandle runs after this and derives locals.db from locals.org_id.
	locals.org_id = provisioned.org_id;
	const response = await resolve(event);
	response.headers.append('set-cookie', cookie);
	return response;
};

// ---------------------------------------------------------------------------
// 2. App — platform bindings, mailbox DO, sync engine accessor
// ---------------------------------------------------------------------------
const appHandle: Handle = async ({ event, resolve }) => {
	const platform = event.platform as App.Platform | undefined;
	const penv = platform?.env;
	_last_env = penv;
	if (!penv) return resolve(event);

	const locals = event.locals as AuthLocals & App.Locals;
	event.locals.kv = penv.KV;
	event.locals.r2 = penv.R2;

	const org_id = locals.org_id;
	let _cached_db: App.Locals['db'];
	Object.defineProperty(event.locals, 'db', {
		configurable: true,
		get() {
			if (!_cached_db) {
				if (!org_id || !penv.MAILBOX) return undefined;
				_cached_db = penv.MAILBOX.get(
					penv.MAILBOX.idFromName(org_id),
				) as unknown as App.Locals['db'];
			}
			return _cached_db;
		},
	});

	event.locals.syncEngineFor = (account_id: string) => {
		if (!penv.SYNC) return undefined;
		return penv.SYNC.get(penv.SYNC.idFromName(account_id));
	};

	return resolve(event);
};

// ---------------------------------------------------------------------------
// 3. WebSocket — upgrade /api/websocket to the per-user WS DO
// ---------------------------------------------------------------------------
const websocketHandle = createWebsocketHandle({
	getWebsocket: (event) => {
		const locals = event.locals as AuthLocals & App.Locals;
		if (!locals.org_id) return undefined;
		const penv = (event.platform as App.Platform | undefined)?.env;
		if (!penv?.WS) return undefined;
		return penv.WS.get(penv.WS.idFromName(locals.org_id));
	},
});

// ---------------------------------------------------------------------------
// 4. Database — generated CRUD + /api/sync, with domain-rule hooks
// ---------------------------------------------------------------------------
// R2 pointers are server-managed. If a client could set message.body_keys /
// attachment.r2_key, it could aim a body/attachment read at another org's R2
// object (IDOR). Strip them from every client write; the server sets them
// directly on the DO (ingest / send), which bypasses this handle.
// body_keys is the IDOR vector (a client-aimed R2 read); provider_ids is the
// two-way-sync mapping. Both are server-set. rfc822_message_id is intentionally
// NOT stripped — it's a required field a client-side draft must supply, and a
// forged value only affects that client's own per-account ingest dedupe (harmless).
const MESSAGE_SERVER_FIELDS = ['body_keys', 'provider_ids'];
const ATTACHMENT_SERVER_FIELDS = ['r2_key', 'image_id'];

/** Delete server-managed fields from a client CRUD payload, in place. */
function strip<T extends Record<string, unknown>>(data: T, fields: string[]): T {
	const clean = { ...data } as Record<string, unknown>;
	for (const f of fields) delete clean[f];
	return clean as T;
}

const databaseHandle = createDatabaseHandle({
	getDatabase: (event) => event.locals.db as never,
	tables,
	sync: true,
	hooks: {
		ai_review: { beforeCreate: rejectClientWrite, beforeUpdate: rejectClientWrite },
		outbox: { beforeCreate: rejectClientWrite, beforeUpdate: rejectClientWrite },
		// An identity's `email` is the From on outbound mail. On the SMTP-relay
		// transport the relay authenticates the connection, not the envelope, so a
		// client-forged identity would let a user send as any address through the
		// deployer's reputation. Identities are created server-side only (OAuth
		// connect / cf_domain register / inbound catch-all) and email is immutable —
		// but display name, signature, and the default flag belong to the user.
		identity: {
			beforeCreate: rejectClientWrite,
			beforeUpdate: ({ data }) => {
				const allowed: Record<string, unknown> = {};
				for (const f of ['name', 'signature_doc', 'is_default'] as const) {
					if (f in (data as Record<string, unknown>))
						allowed[f] = (data as Record<string, unknown>)[f];
				}
				if (!Object.keys(allowed).length) rejectClientWrite();
				return allowed as never;
			},
		},
		message: {
			beforeCreate: ({ data }) => strip(data, MESSAGE_SERVER_FIELDS),
			beforeUpdate: ({ data }) => strip(data, MESSAGE_SERVER_FIELDS),
		},
		attachment: {
			beforeCreate: ({ data }) => strip(data, ATTACHMENT_SERVER_FIELDS),
			beforeUpdate: ({ data }) => strip(data, ATTACHMENT_SERVER_FIELDS),
		},
		settings: {
			// Settings is a singleton keyed 'main'.
			beforeCreate: ({ data }) => ({ ...data, id: 'main' }),
		},
	},
});

function rejectClientWrite(): never {
	throw new DelightError({ message: 'This table is managed by the server.', status: 403 });
}

// ---------------------------------------------------------------------------
// 5. AI — /api/ai/* (streaming summaries / smart replies), org-authorized
// ---------------------------------------------------------------------------
const aiHandle = createAiHandle({
	// The handle's event is typed as the library's minimal RequestEventLike
	// (locals: { session?: unknown }), so reach for db through a cast.
	getAi: (event) => (event.locals as { db?: { ai?: never } }).db?.ai,
	authorize: (event) => !!event.locals.session,
});

// ---------------------------------------------------------------------------
// 6. Mail — custom endpoints (accounts, send, body, unsubscribe, push…)
// ---------------------------------------------------------------------------
const mailHandle = createMailHandle();

// Settings singleton: the generic CRUD get throws before the row exists, and
// the DO's 404 loses its status across the RPC boundary — so a fresh mailbox
// answered EVERY app load's GET /api/settings/main with a 500. Route the read
// through ensureSettings (creates the row on first use) ahead of the generic
// database handle.
const settingsHandle: Handle = async ({ event, resolve }) => {
	if (event.url.pathname !== '/api/settings/main' || event.request.method !== 'GET') {
		return resolve(event);
	}
	if (!event.locals.session) return DelightError.unauthorized('Sign in required').toResponse();
	if (!event.locals.db) {
		return DelightError.badRequest('No mailbox for this session').toResponse();
	}
	try {
		return Response.json(await event.locals.db.ensureSettings());
	} catch (err) {
		return DelightError.from(err).toResponse();
	}
};

// The delightstack factory handles are typed against their own bundled
// @sveltejs/kit; cast to the local Handle so sequence() accepts them (they are
// structurally identical at runtime).
export const handle = sequence(
	// `vite dev` only: the Durable Objects live in the server worker (`pnpm dev`
	// starts it on :8710), reached over delightstack's HTTP RPC bridge. `override`
	// is REQUIRED for cross-script DOs — without it the stubs wrangler's dev registry
	// hands out are used instead, and those are miniflare ProxyClient stubs that
	// turn every error thrown inside a DO method into an opaque 500
	// (`typeHeader === "Promise"`). The bridge relays the real DelightError.
	...((dev
		? [
				createDevHandle({
					url: env.DEV_WORKER_URL || 'http://localhost:8710',
					bindings: ['AUTH', 'MAILBOX', 'SYNC', 'WS', 'RATE_LIMITER'],
					override: true,
				}),
			]
		: []) as unknown as Handle[]),
	signupGateHandle,
	emailLinkHandle,
	devSigninHandle,
	authHandle as unknown as Handle,
	orgHandle,
	appHandle,
	websocketHandle as unknown as Handle,
	settingsHandle,
	databaseHandle as unknown as Handle,
	aiHandle as unknown as Handle,
	mailHandle,
);

export const handleError: HandleServerError = ({ error }) => {
	const err = DelightError.from(error);
	return { message: err.message, status: err.status };
};
