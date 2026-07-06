/**
 * Cloudflare Email Routing inbound handler (§5.2). Golden rule (R8): capture the
 * raw bytes to R2 FIRST so mail is never lost, then parse + route. On any
 * internal error we keep the R2 copy for the replay_r2 job and never bounce.
 *
 * Full org resolution + alias auto-identity + ingest lands in P4; for now we
 * durably capture and record a pending-ingest marker.
 */
import type { Env } from './index';

export async function handleInboundEmail(
	message: ForwardableEmailMessage,
	env: Env,
	_ctx: ExecutionContext,
): Promise<void> {
	const to = message.to;
	const from = message.from;
	const raw_key = `inbound/${Date.now()}-${crypto.randomUUID()}.eml`;

	try {
		// 1. Durable capture — stream raw bytes to R2 before anything can fail.
		const buf = await streamToArrayBuffer(message.raw, message.rawSize);
		await env.R2.put(raw_key, buf, {
			httpMetadata: { contentType: 'message/rfc822' },
			customMetadata: { to, from },
		});
	} catch (err) {
		console.error('[email] R2 capture failed:', err);
		// Do not reject — let Cloudflare retry delivery.
		return;
	}

	// 2. Route to the owning cf_domain account's org. Implemented in P4:
	//    resolve org by matching `to` domain against registered cf_domain
	//    accounts, auto-create identities for first-seen aliases, ingest, then
	//    delete the pending marker. Unknown domains → message.setReject().
	const domain = to.split('@')[1]?.toLowerCase();
	console.log(`[email] captured ${raw_key} for ${to} (domain ${domain}) — pending ingest (P4)`);

	// Record the capture for the replay job so P4 can backfill anything received
	// before routing was wired.
	await env.KV.put(`pending-email:${raw_key}`, JSON.stringify({ to, from, domain }), {
		expirationTtl: 60 * 60 * 24 * 14,
	});
}

async function streamToArrayBuffer(
	stream: ReadableStream<Uint8Array>,
	size: number,
): Promise<Uint8Array> {
	const reader = stream.getReader();
	const out = new Uint8Array(size);
	let offset = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		out.set(value, offset);
		offset += value.length;
	}
	return out;
}
