/**
 * Gmail Pub/Sub push webhook. A push subscription POSTs here with an OIDC
 * bearer token; we verify the JWT (issuer accounts.google.com, audience =
 * GMAIL_PUSH_AUDIENCE, service-account email match) and route the notification
 * to the right SyncEngine by the email address in the payload.
 *
 * The notification only carries a new historyId — a hint. SyncEngine then runs
 * an incremental history.list from its stored cursor, so missed/duplicated
 * pushes are harmless.
 */
import type { Env } from './index';
import { verifyGoogleOidc } from './google-oidc';

interface SyncEngineStub {
	onPushHint(): Promise<void>;
}

export async function handleGmailWebhook(request: Request, env: Env): Promise<Response> {
	// Fail CLOSED: without the audience + service-account bindings, OIDC
	// verification would degrade to "any JWT signed by Google" — obtainable by
	// any Google/GCP caller — letting an unauthenticated request force syncs and
	// burn Gmail quota. If push isn't configured with both, refuse to act;
	// the account falls back to polling. (Set GMAIL_PUSH_AUDIENCE +
	// GMAIL_PUSH_SA_EMAIL to enable push — see docs/providers/gmail.md.)
	if (!env.GMAIL_PUSH_AUDIENCE || !env.GMAIL_PUSH_SA_EMAIL) {
		console.warn('[gmail-webhook] rejected: GMAIL_PUSH_AUDIENCE/SA_EMAIL not configured');
		return new Response('Push not configured', { status: 403 });
	}

	const auth = request.headers.get('authorization') ?? '';
	const token = auth.replace(/^Bearer\s+/i, '');
	if (!token) return new Response('Missing token', { status: 401 });

	const verified = await verifyGoogleOidc(token, {
		audience: env.GMAIL_PUSH_AUDIENCE,
		serviceAccount: env.GMAIL_PUSH_SA_EMAIL,
	});
	if (!verified.ok) {
		return new Response(`Invalid OIDC token: ${verified.reason}`, { status: 403 });
	}

	let emailAddress: string | undefined;
	try {
		const body = (await request.json()) as { message?: { data?: string } };
		const dataB64 = body.message?.data;
		if (dataB64) {
			const decoded = JSON.parse(atob(dataB64)) as {
				emailAddress?: string;
				historyId?: string;
			};
			emailAddress = decoded.emailAddress;
		}
	} catch (err) {
		console.error('[gmail-webhook] bad payload:', err);
	}

	if (!emailAddress) {
		// Ack anyway so Pub/Sub doesn't retry a malformed notification forever.
		return new Response('OK (no address)', { status: 200 });
	}

	// Route to the owning SyncEngine (keyed by account_id). The address→account_id
	// map is written to KV when the Gmail account is connected (see accounts.ts).
	const account_id = await env.KV.get(`gmail-route:${emailAddress.toLowerCase()}`);
	if (!account_id) {
		// Unknown address (account removed / not connected here) — ack so Pub/Sub
		// stops retrying; a stale watch will expire on its own.
		console.warn(`[gmail-webhook] no account mapping for ${emailAddress}`);
		return new Response('OK (no account)', { status: 200 });
	}
	try {
		const stub = env.SYNC.get(env.SYNC.idFromName(account_id)) as unknown as SyncEngineStub;
		await stub.onPushHint();
	} catch (err) {
		// Push is only a hint; the polling fallback / next watch will catch up.
		console.error('[gmail-webhook] onPushHint dispatch failed:', err);
	}
	return new Response('OK', { status: 200 });
}
