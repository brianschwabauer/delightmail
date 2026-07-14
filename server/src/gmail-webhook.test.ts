import { describe, it, expect } from 'vitest';
import { handleGmailWebhook } from './gmail-webhook';
import type { Env } from './index';

function req(headers: Record<string, string> = {}): Request {
	return new Request('https://server.example/webhooks/gmail', {
		method: 'POST',
		headers: { 'content-type': 'application/json', ...headers },
		body: JSON.stringify({ message: { data: btoa(JSON.stringify({ emailAddress: 'x@y.z' })) } }),
	});
}

/** Minimal Env for the auth-gate paths (KV/SYNC are only reached after verify). */
function env(over: Partial<Env> = {}): Env {
	return { KV: {}, SYNC: {}, ...over } as unknown as Env;
}

describe('gmail-webhook — OIDC fail-closed', () => {
	it('rejects with 403 when GMAIL_PUSH_AUDIENCE / SA_EMAIL are unset', async () => {
		const res = await handleGmailWebhook(req({ authorization: 'Bearer whatever' }), env());
		expect(res.status).toBe(403);
		expect(await res.text()).toMatch(/not configured/i);
	});

	it('rejects with 403 when only the audience is set (SA missing)', async () => {
		const res = await handleGmailWebhook(
			req({ authorization: 'Bearer whatever' }),
			env({ GMAIL_PUSH_AUDIENCE: 'https://server.example/webhooks/gmail' }),
		);
		expect(res.status).toBe(403);
	});

	it('once configured, still enforces token presence and validity (no fail-open)', async () => {
		const configured = env({
			GMAIL_PUSH_AUDIENCE: 'https://server.example/webhooks/gmail',
			GMAIL_PUSH_SA_EMAIL: 'pusher@project.iam.gserviceaccount.com',
		});
		// Missing token → 401.
		expect((await handleGmailWebhook(req(), configured)).status).toBe(401);
		// Malformed token → 403 (verification runs; it is not skipped).
		const bad = await handleGmailWebhook(req({ authorization: 'Bearer not.a.jwt' }), configured);
		expect(bad.status).toBe(403);
		expect(await bad.text()).toMatch(/Invalid OIDC token/i);
	});
});
