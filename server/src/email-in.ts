/**
 * Cloudflare Email Routing inbound handler. Golden rule (R8): capture the
 * raw bytes to R2 FIRST so mail is never lost, then parse + route. On any
 * internal error we keep the R2 copy for the replay job and never bounce.
 *
 * Routing: the recipient domain is looked up in KV (`domain:{domain}` → org_id),
 * written when a cf_domain account is registered. First-seen aliases auto-create
 * a `cf_domain` identity (catch-all ⇒ infinite aliases).
 */
import type { Env } from './index';
import { parseEmail } from '../../src/lib/mail/mime';
import { sanitizeEmailHtml } from '../../src/lib/mail/sanitize';
import { messagePrefix, writeBodies, writeAttachments } from './body-store';
import type { NormalizedMessage } from './ingest';

interface CfDomainMailbox {
	ingestMessages(batch: unknown[]): Promise<{ ingested: number; skipped: number }>;
	ensureCfDomainAccount(domain: string): Promise<{ account_id: string }>;
	ensureIdentity(account_id: string, email: string): Promise<void>;
	scheduleJob(type: string, payload: unknown, delay_ms: number): Promise<void>;
}

export async function handleInboundEmail(
	message: ForwardableEmailMessage,
	env: Env,
	_ctx: ExecutionContext,
): Promise<void> {
	const to = message.to;
	const from = message.from;
	const raw_key = `inbound/${Date.now()}-${crypto.randomUUID()}.eml`;
	let rawBytes: Uint8Array;

	// 1. Durable capture — stream raw bytes to R2 before anything can fail.
	try {
		rawBytes = await streamToArrayBuffer(message.raw, message.rawSize);
		await env.R2.put(raw_key, rawBytes, {
			httpMetadata: { contentType: 'message/rfc822' },
			customMetadata: { to, from },
		});
	} catch (err) {
		console.error('[email] R2 capture failed:', err);
		// MUST throw: Email Workers only signal a transient failure (so the
		// sending server retries delivery) when the handler throws. A clean
		// return ACKs and consumes the message — a transient R2 blip would
		// silently and permanently lose the mail, with no R2 copy, no DB row,
		// and no replay job.
		throw err;
	}

	// 2. Resolve the owning org by recipient domain.
	const domain = to.split('@')[1]?.toLowerCase() ?? '';
	const org_id = await env.KV.get(`domain:${domain}`);
	if (!org_id) {
		// Unknown domain — reject so the sender gets a bounce.
		try {
			message.setReject('Address does not exist');
		} catch {
			/* setReject may be unavailable in some contexts */
		}
		return;
	}

	// 3. Parse, sanitize, write bodies, ingest. Keep the raw copy for replay if
	//    anything after capture throws (a replay_r2 job reprocesses it).
	try {
		const mailbox = env.MAILBOX.get(
			env.MAILBOX.idFromName(org_id),
		) as unknown as CfDomainMailbox;

		const { account_id } = await mailbox.ensureCfDomainAccount(domain);
		await mailbox.ensureIdentity(account_id, to.toLowerCase());

		const parsed = await parseEmail(rawBytes);
		const html = parsed.html
			? sanitizeEmailHtml(parsed.html, { cidBase: '/api/attachments' })
			: '';
		const prefix = await messagePrefix(org_id, parsed.rfc822_message_id);
		const body_keys = await writeBodies(env.R2, prefix, {
			raw: rawBytes,
			html: html || undefined,
			text: parsed.text || undefined,
		});
		const attachments = await writeAttachments(
			env.R2,
			prefix,
			parsed.attachments.map((a) => ({
				filename: a.filename,
				mime_type: a.mime_type,
				content: a.content,
				content_id: a.content_id,
				size_bytes: a.size_bytes,
			})),
		);

		const normalized: NormalizedMessage = {
			rfc822_message_id: parsed.rfc822_message_id,
			account_id,
			identity_email: to.toLowerCase(),
			in_reply_to: parsed.in_reply_to,
			references: parsed.references,
			from: parsed.from,
			to: parsed.to,
			cc: parsed.cc,
			bcc: parsed.bcc,
			reply_to: parsed.reply_to,
			subject: parsed.subject,
			snippet: parsed.snippet,
			text_excerpt: parsed.text_excerpt,
			body_keys,
			date: parsed.date,
			is_read: false,
			is_outbound: false,
			folder: 'inbox',
			headers_subset: parsed.headers_subset as Record<string, unknown>,
			attachments,
			attachment_count: parsed.attachments.length,
			size_bytes: parsed.size_bytes,
		};

		await mailbox.ingestMessages([normalized]);

		// Optional transition forwarding (config: account.config.forward_to).
		// Left to a per-account setting read in a follow-up; the raw copy remains.

		// Ingested successfully — the pending marker (if any) can be dropped.
		await env.KV.delete(`pending-email:${raw_key}`).catch(() => {});
	} catch (err) {
		console.error('[email] ingest failed, keeping R2 copy for replay:', err);
		// Keep a KV marker AND enqueue a replay job so the message is actually
		// re-ingested from R2 later rather than sitting captured-but-lost.
		await env.KV.put(`pending-email:${raw_key}`, JSON.stringify({ to, from, domain, org_id }), {
			expirationTtl: 60 * 60 * 24 * 14,
		});
		try {
			const mailbox = env.MAILBOX.get(
				env.MAILBOX.idFromName(org_id),
			) as unknown as CfDomainMailbox;
			await mailbox.scheduleJob('replay_r2', { raw_key, to: to.toLowerCase() }, 30_000);
		} catch (scheduleErr) {
			console.error('[email] could not schedule replay_r2:', scheduleErr);
		}
	}
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
