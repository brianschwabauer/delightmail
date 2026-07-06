/**
 * Gmail Pub/Sub push webhook (§5.1). A push subscription POSTs here with an OIDC
 * bearer token; we verify the JWT (issuer accounts.google.com, audience =
 * GMAIL_PUSH_AUDIENCE, service-account email match) and route the notification
 * to the right SyncEngine by the email address in the payload.
 *
 * The notification only carries a new historyId — a hint. SyncEngine then runs
 * an incremental history.list from its stored cursor, so missed/duplicated
 * pushes are harmless. Full history sync dispatch lands in P1.
 */
import type { Env } from './index';
import { verifyGoogleOidc } from './google-oidc';

export async function handleGmailWebhook(request: Request, env: Env): Promise<Response> {
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

	// Route to the SyncEngine for this account. account_id is the DO name; we
	// address by the gmail address (SyncEngine keyed by account_id === address
	// hash in P1). For now, ack — history sync dispatch lands in P1.
	console.log(`[gmail-webhook] verified push for ${emailAddress} — history sync pending (P1)`);
	return new Response('OK', { status: 200 });
}
