/**
 * Account connection endpoints (§5.1, §9). Gmail OAuth connect is a standard
 * code flow, separate from app sign-in: a signed-in user links N Gmail accounts.
 * The refresh token is handed to the account's SyncEngine (which encrypts it);
 * it never touches the mailbox DB.
 */
import type { RequestEvent } from '@sveltejs/kit';
import { DelightError } from '@delightstack/utilities';
import { listDocs, countDocs, type ListableDb } from './db-list';

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

/** Exchange an authorization code for tokens (OAuth connect callback). */
async function exchangeCode(
	client_id: string,
	client_secret: string,
	code: string,
	redirect_uri: string,
): Promise<{ access_token: string; refresh_token?: string; expires_in: number }> {
	const res = await fetch(GOOGLE_TOKEN_URL, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			client_id,
			client_secret,
			code,
			redirect_uri,
			grant_type: 'authorization_code',
		}),
	});
	if (!res.ok) throw new Error(`Gmail code exchange failed: ${res.status}`);
	return res.json();
}
const SCOPES = [
	'https://www.googleapis.com/auth/gmail.modify',
	'https://www.googleapis.com/auth/gmail.send',
	'openid',
	'email',
	'profile',
];
const ACCOUNT_COLORS = [
	'#d97706',
	'#0891b2',
	'#7c3aed',
	'#16a34a',
	'#db2777',
	'#2563eb',
	'#ca8a04',
];

function env(event: RequestEvent): App.CloudflareEnv | undefined {
	return (event.platform as App.Platform | undefined)?.env;
}

function appUrl(event: RequestEvent): string {
	return env(event)?.PUBLIC_APP_URL ?? event.url.origin;
}

function redirectUri(event: RequestEvent): string {
	return `${appUrl(event)}/api/accounts/google/callback`;
}

/** POST /api/accounts/google/start → returns the Google consent URL. */
export async function handleGoogleStart(event: RequestEvent): Promise<Response> {
	const penv = env(event);
	if (!penv?.GOOGLE_CLIENT_ID) {
		return DelightError.badRequest('Gmail connect is not configured on this instance.').toResponse();
	}
	const org_id = event.locals.org_id;
	if (!org_id || !penv.KV) return DelightError.badRequest('No mailbox').toResponse();

	// CSRF: stash a nonce → org_id in KV, echo the nonce as `state`.
	const nonce = crypto.randomUUID();
	await penv.KV.put(`oauth-state:${nonce}`, org_id, { expirationTtl: 600 });

	const params = new URLSearchParams({
		client_id: penv.GOOGLE_CLIENT_ID,
		redirect_uri: redirectUri(event),
		response_type: 'code',
		scope: SCOPES.join(' '),
		access_type: 'offline',
		prompt: 'consent',
		state: nonce,
	});
	return Response.json({ url: `${GOOGLE_AUTH_URL}?${params}` });
}

/** GET /api/accounts/google/callback?code=&state= */
export async function handleGoogleCallback(event: RequestEvent): Promise<Response> {
	const penv = env(event);
	const code = event.url.searchParams.get('code');
	const state = event.url.searchParams.get('state');
	if (!penv?.GOOGLE_CLIENT_ID || !penv.GOOGLE_CLIENT_SECRET || !penv.KV) {
		return DelightError.badRequest('Gmail connect not configured').toResponse();
	}
	if (!code || !state) return redirectWithToast(event, 'Gmail connect was cancelled.');

	const org_id = await penv.KV.get(`oauth-state:${state}`);
	if (!org_id || org_id !== event.locals.org_id) {
		return redirectWithToast(event, 'Gmail connect failed (bad state).');
	}
	await penv.KV.delete(`oauth-state:${state}`);

	let tokens;
	try {
		tokens = await exchangeCode(
			penv.GOOGLE_CLIENT_ID,
			penv.GOOGLE_CLIENT_SECRET,
			code,
			redirectUri(event),
		);
	} catch (err) {
		return redirectWithToast(event, `Gmail connect failed: ${(err as Error).message}`);
	}
	if (!tokens.refresh_token) {
		return redirectWithToast(
			event,
			'Google did not return a refresh token. Remove the app from your Google account and try again.',
		);
	}

	// Fetch the account email from the id_token / userinfo.
	const email = await fetchGoogleEmail(tokens.access_token);
	const db = event.locals.db;
	if (!db) return DelightError.badRequest('No mailbox').toResponse();

	// Idempotent-ish: reuse an existing account row for this email if present.
	const existing = await findAccountByEmail(db, email);
	const account = existing ?? (await db.create('account', {
		kind: 'gmail',
		email,
		display_name: email,
		color: pickColor(await accountCount(db)),
		status: 'connecting',
		config: { gmail_address: email },
	}));
	const account_id = String((account as { id: string }).id);

	// Ensure a default identity exists.
	await db.create('identity', {
		account_id,
		email,
		name: email.split('@')[0],
		is_default: (await accountCount(db)) <= 1,
	});

	// Hand the refresh token to the account's SyncEngine and start syncing.
	const sync = penv.SYNC.get(penv.SYNC.idFromName(account_id)) as unknown as {
		connectAccount(input: unknown): Promise<{ ok: boolean }>;
	};
	await sync.connectAccount({
		account_id,
		org_id,
		account_email: email,
		kind: 'gmail',
		credentials: { refresh_token: tokens.refresh_token },
	});

	// Map the Gmail address → account_id so the Pub/Sub webhook can route push
	// hints to the right SyncEngine (the notification only carries the address).
	await penv.KV.put(`gmail-route:${email.toLowerCase()}`, account_id);

	return redirectWithToast(event, `Connected ${email}. Backfilling your mail…`, '/settings/accounts');
}

interface ImapBody {
	email: string;
	imap_host: string;
	imap_port?: number;
	smtp_host?: string;
	smtp_port?: number;
	username?: string;
	password: string;
}

/** POST /api/accounts/imap/test — verify IMAP credentials (R1: socket spike). */
export async function handleImapTest(event: RequestEvent): Promise<Response> {
	const body = (await event.request.json().catch(() => null)) as ImapBody | null;
	if (!body?.imap_host || !body.password) {
		return DelightError.badRequest('Host and password are required.').toResponse();
	}
	// The live connection test runs inside the account's SyncEngine (which has the
	// socket + imapflow). Until the R1 spike confirms Workers-socket IMAP, this
	// surfaces the attempt result honestly.
	const penv = env(event);
	if (!penv?.SYNC) return DelightError.badRequest('No sync engine').toResponse();
	const probeId = `imap-probe-${(body.username || body.email).toLowerCase()}`;
	const sync = penv.SYNC.get(penv.SYNC.idFromName(probeId)) as unknown as {
		testImap(cfg: unknown): Promise<{ ok: boolean; error?: string; folders?: string[] }>;
	};
	try {
		const result = await sync.testImap({
			host: body.imap_host,
			port: body.imap_port ?? 993,
			secure: (body.imap_port ?? 993) === 993,
			user: body.username || body.email,
			pass: body.password,
		});
		return Response.json(result);
	} catch (err) {
		return Response.json({ ok: false, error: (err as Error).message });
	}
}

/** POST /api/accounts/imap — add an IMAP/SMTP account. */
export async function handleImapAdd(event: RequestEvent): Promise<Response> {
	const penv = env(event);
	const org_id = event.locals.org_id;
	const db = event.locals.db;
	if (!penv?.SYNC || !org_id || !db) return DelightError.badRequest('No mailbox').toResponse();

	const body = (await event.request.json().catch(() => null)) as ImapBody | null;
	if (!body?.email || !body.imap_host || !body.password) {
		return DelightError.badRequest('Email, IMAP host and password are required.').toResponse();
	}

	const account = (await db.create('account', {
		kind: 'imap',
		email: body.email.toLowerCase(),
		display_name: body.email,
		color: pickColor(await accountCount(db)),
		status: 'connecting',
		config: {
			imap_host: body.imap_host,
			imap_port: body.imap_port ?? 993,
			imap_secure: (body.imap_port ?? 993) === 993,
			smtp_host: body.smtp_host ?? body.imap_host.replace(/^imap/, 'smtp'),
			smtp_port: body.smtp_port ?? 587,
			username: body.username || body.email,
		},
	})) as { id: string };
	await db.create('identity', {
		account_id: account.id,
		email: body.email.toLowerCase(),
		name: body.email.split('@')[0],
		is_default: (await accountCount(db)) <= 1,
	});

	const sync = penv.SYNC.get(penv.SYNC.idFromName(account.id)) as unknown as {
		connectAccount(input: unknown): Promise<{ ok: boolean }>;
	};
	await sync.connectAccount({
		account_id: account.id,
		org_id,
		account_email: body.email.toLowerCase(),
		kind: 'imap',
		credentials: {
			imap: {
				host: body.imap_host,
				port: body.imap_port ?? 993,
				secure: (body.imap_port ?? 993) === 993,
				user: body.username || body.email,
				pass: body.password,
			},
			smtp: {
				host: body.smtp_host ?? body.imap_host.replace(/^imap/, 'smtp'),
				port: body.smtp_port ?? 587,
				user: body.username || body.email,
				pass: body.password,
			},
		},
	});
	return Response.json({ account_id: account.id, email: body.email });
}

/** POST /api/accounts/domain { domain } — register a Cloudflare-routed domain. */
export async function handleDomainRegister(event: RequestEvent): Promise<Response> {
	const penv = env(event);
	const org_id = event.locals.org_id;
	const db = event.locals.db;
	if (!penv?.KV || !org_id || !db) return DelightError.badRequest('No mailbox').toResponse();

	const body = (await event.request.json().catch(() => null)) as { domain?: string } | null;
	const domain = body?.domain?.trim().toLowerCase().replace(/^@/, '');
	if (!domain || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) {
		return DelightError.badRequest('Enter a valid domain (e.g. example.com).').toResponse();
	}

	// Create the account (or reuse) and map the domain → org in KV so the
	// server worker's email() handler can route inbound mail.
	const { account_id } = await (
		db as unknown as { ensureCfDomainAccount(d: string): Promise<{ account_id: string }> }
	).ensureCfDomainAccount(domain);
	await penv.KV.put(`domain:${domain}`, org_id);

	// Register the account's SyncEngine so it can SEND (cf_email / smtp transport).
	const sync = penv.SYNC.get(penv.SYNC.idFromName(account_id)) as unknown as {
		connectAccount(input: unknown): Promise<{ ok: boolean }>;
	};
	await sync.connectAccount({
		account_id,
		org_id,
		account_email: domain,
		kind: 'cf_domain',
	});

	return Response.json({
		account_id,
		domain,
		next_steps:
			'In Cloudflare → Email Routing, enable catch-all → Send to Worker → delightmail-server. ' +
			'For sending, onboard the domain to Email Service (or set SMTP_RELAY_* env).',
	});
}

interface AccountRow {
	id: string;
	email?: string;
	kind?: string;
}
interface SyncLifecycleStub {
	pause(): Promise<void>;
	resume(): Promise<void>;
	resync(): Promise<void>;
	destroyAccount(): Promise<void>;
}

/** POST /api/accounts/:id/(pause|resume|resync) — account lifecycle. */
export async function handleAccountLifecycle(
	event: RequestEvent,
	account_id: string,
	action: 'pause' | 'resume' | 'resync',
): Promise<Response> {
	const penv = env(event);
	const org_id = event.locals.org_id;
	const db = event.locals.db as unknown as {
		get(t: string, id: string): AccountRow;
		update(t: string, id: string, data: Record<string, unknown>): unknown;
	};
	if (!penv?.SYNC || !org_id || !db) return DelightError.badRequest('No mailbox').toResponse();

	// Ownership: the account must live in THIS org's DO. get throws → 404. This is
	// what stops one org pausing/resyncing another org's SyncEngine by id (IDOR).
	let account: AccountRow;
	try {
		account = db.get('account', account_id);
	} catch {
		return DelightError.notFound('Account not found').toResponse();
	}

	const sync = penv.SYNC.get(penv.SYNC.idFromName(account_id)) as unknown as SyncLifecycleStub;
	if (action === 'pause') {
		await sync.pause();
		try {
			db.update('account', account_id, { status: 'paused' });
		} catch {
			/* ignore */
		}
	} else if (action === 'resume') {
		await sync.resume();
		try {
			db.update('account', account_id, { status: 'live' });
		} catch {
			/* ignore */
		}
	} else {
		await sync.resync();
		try {
			db.update('account', account_id, { status: 'backfilling', status_detail: 'Re-syncing…' });
		} catch {
			/* ignore */
		}
	}
	return Response.json({ ok: true, account_id, status: action });
}

/** DELETE /api/accounts/:id — remove an account: purge its SyncEngine + rows. */
export async function handleAccountDelete(event: RequestEvent, account_id: string): Promise<Response> {
	const penv = env(event);
	const org_id = event.locals.org_id;
	const db = event.locals.db as unknown as {
		get(t: string, id: string): AccountRow;
		delete(t: string, id: string): unknown;
	};
	if (!penv?.SYNC || !org_id || !db) return DelightError.badRequest('No mailbox').toResponse();

	let account: AccountRow;
	try {
		account = db.get('account', account_id);
	} catch {
		return DelightError.notFound('Account not found').toResponse();
	}

	// Tear down the protocol head (encrypted creds, sync cursor, job queue).
	try {
		const sync = penv.SYNC.get(penv.SYNC.idFromName(account_id)) as unknown as SyncLifecycleStub;
		await sync.destroyAccount();
	} catch (err) {
		console.error('[accounts] destroyAccount failed:', err);
	}
	// Drop the Gmail push route mapping so stray webhooks stop resolving.
	if (account.kind === 'gmail' && account.email && penv.KV) {
		try {
			await penv.KV.delete(`gmail-route:${account.email.toLowerCase()}`);
		} catch {
			/* ignore */
		}
	}
	// Deleting the account row cascades to its messages + identities (FK CASCADE).
	// (R2 bodies are org-prefixed, not per-account, so any orphaned objects are
	// reclaimed when the whole org is deleted; a per-account R2 sweep is a follow-up.)
	try {
		db.delete('account', account_id);
	} catch (err) {
		console.error('[accounts] account delete failed:', err);
	}
	return Response.json({ ok: true, deleted: account_id });
}

async function fetchGoogleEmail(access_token: string): Promise<string> {
	const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
		headers: { authorization: `Bearer ${access_token}` },
	});
	if (!res.ok) throw new Error('Failed to read Google profile');
	const info = (await res.json()) as { email?: string };
	if (!info.email) throw new Error('Google profile has no email');
	return info.email.toLowerCase();
}

interface DbLite extends ListableDb {
	create(entity_type: string, data: Record<string, unknown>): Promise<unknown> | unknown;
}

async function findAccountByEmail(db: DbLite, email: string): Promise<unknown | undefined> {
	const [account] = await listDocs<unknown>(db, 'account', { where: { email }, limit: 1 });
	return account;
}

async function accountCount(db: DbLite): Promise<number> {
	return countDocs(db, 'account');
}

function pickColor(index: number): string {
	return ACCOUNT_COLORS[index % ACCOUNT_COLORS.length];
}

function redirectWithToast(event: RequestEvent, toast: string, to = '/settings/accounts'): Response {
	const url = new URL(to, appUrl(event));
	url.searchParams.set('toast', toast);
	return new Response(null, { status: 303, headers: { location: url.toString() } });
}
