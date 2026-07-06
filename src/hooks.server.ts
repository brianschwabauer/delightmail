import type { Handle, HandleServerError } from '@sveltejs/kit';
import { sequence } from '@sveltejs/kit/hooks';
import { createAuthHandle, type AuthServer, type AuthLocals } from '@delightstack/auth/server';
import { createWebsocketHandle } from '@delightstack/websocket/server';
import { createDatabaseHandle } from '@delightstack/database/server';
import { createAiHandle } from '@delightstack/ai/server';
import { DelightError, createDevHandle } from '@delightstack/utilities';
import { env } from '$env/dynamic/private';
import { building, dev } from '$app/environment';
import { tables } from '$lib/schema';
import { sendTransactionalEmail } from '$lib/server/email';
import { createMailHandle } from '$lib/server/mail-handle';

const DEV_SECRET = 'dev-secret-change-me-in-production-min-64-chars-long-0123456789abcdef';

function appOrigin(): string {
	return env.PUBLIC_APP_URL ?? 'http://localhost:5174';
}

function rpId(): string {
	try {
		return new URL(appOrigin()).hostname;
	} catch {
		return 'localhost';
	}
}

/** Whether a given email is allowed to create an account (§8). */
function signupAllowed(email: string): boolean {
	if (env.SIGNUPS_ENABLED === 'true') return true;
	const owners = (env.OWNER_EMAIL ?? '')
		.split(/[,\s]+/)
		.map((e) => e.trim().toLowerCase())
		.filter(Boolean);
	if (owners.length === 0) return dev; // dev: allow anyone; prod: locked until OWNER_EMAIL set
	return owners.includes(email.trim().toLowerCase());
}

// ---------------------------------------------------------------------------
// 0. Signup gate — reject magic-link / signup requests from disallowed emails
//    BEFORE they reach the auth handler (which auto-creates users).
// ---------------------------------------------------------------------------
const signupGateHandle: Handle = async ({ event, resolve }) => {
	// Capture platform env for the auth sendEmail closure (env is
	// deployment-constant, so caching the first non-empty value is safe).
	const penv = (event.platform as App.Platform | undefined)?.env;
	if (penv) _last_env = penv;

	const p = event.url.pathname;
	const gated =
		event.request.method === 'POST' &&
		(p === '/api/auth/signin/email/magic' || p.startsWith('/api/auth/signup'));
	if (!gated) return resolve(event);

	// Peek the email without consuming the body (clone).
	let email = '';
	try {
		const body = (await event.request.clone().json()) as { email?: string };
		email = typeof body?.email === 'string' ? body.email : '';
	} catch {
		/* not JSON — let auth handle validation */
	}
	if (email && !signupAllowed(email)) {
		// If the user already exists, magic-link sign-in is fine; only block NEW accounts.
		// We can't cheaply check existence here, so we allow known owners only when the
		// instance is closed. Return a friendly closed-signups error.
		return DelightError.forbidden(
			'This instance is not accepting new sign-ups. Ask the owner for access.',
		).toResponse();
	}
	return resolve(event);
};

// ---------------------------------------------------------------------------
// 1. Auth — magic link + passkeys + sessions + /api/auth/*
// ---------------------------------------------------------------------------
const authHandle = createAuthHandle({
	config: {
		secret: env.JWT_KEY_SECRET ?? DEV_SECRET,
		issuer: 'delightmail',
		permissions: ['owner', 'admin', 'member'] as const,
		oauth_scopes: [] as const,
		entitlements: ['ai', 'push', 'domains'] as const,
		dev,
		session: { expires_in: 60 * 60 * 24 * 30 }, // 30-day rolling sessions (§8)
		email: {
			link: true,
			code: true,
			base_url: appOrigin(),
			sendEmail: async ({ to, subject, html, text }) => {
				await sendTransactionalEmail(event_env(), { to, subject, html, text }, { dev });
			},
		},
		passkey: {
			rp_id: rpId(),
			rp_name: 'Mail',
			origins: [appOrigin()],
		},
	},
	getAuthServer: (event) => {
		const auth = (event.platform as App.Platform | undefined)?.env?.AUTH;
		if (!auth) return undefined as unknown as AuthServer;
		return auth.get(auth.idFromName('main')) as unknown as AuthServer;
	},
	building,
});

// `sendEmail` closes over the request env; expose the last-seen platform env.
let _last_env: App.CloudflareEnv | undefined;
function event_env(): App.CloudflareEnv | undefined {
	return _last_env;
}

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
// 4. Database — generated CRUD + /api/sync, with domain-rule hooks (§9)
// ---------------------------------------------------------------------------
const SERVER_ONLY_TABLES = new Set(['ai_review', 'outbox']);
const databaseHandle = createDatabaseHandle({
	getDatabase: (event) => event.locals.db as never,
	tables,
	sync: true,
	hooks: {
		ai_review: { beforeCreate: rejectClientWrite, beforeUpdate: rejectClientWrite },
		outbox: { beforeCreate: rejectClientWrite, beforeUpdate: rejectClientWrite },
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
	getAi: (event) => (event.locals.db as unknown as { ai?: never })?.ai,
	authorize: (event) => !!event.locals.session,
});

// ---------------------------------------------------------------------------
// 6. Mail — custom endpoints (accounts, send, body, unsubscribe, push…)
// ---------------------------------------------------------------------------
const mailHandle = createMailHandle();

// The delightstack factory handles are typed against their own bundled
// @sveltejs/kit; cast to the local Handle so sequence() accepts them (they are
// structurally identical at runtime).
export const handle = sequence(
	...((dev ? [createDevHandle()] : []) as unknown as Handle[]),
	signupGateHandle,
	authHandle as unknown as Handle,
	appHandle,
	websocketHandle as unknown as Handle,
	databaseHandle as unknown as Handle,
	aiHandle as unknown as Handle,
	mailHandle,
);

export const handleError: HandleServerError = ({ error }) => {
	const err = DelightError.from(error);
	return { message: err.message, status: err.status };
};
