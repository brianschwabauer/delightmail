/**
 * RFC-822 MIME serialization. Server-only: `mimetext` pulls in node:os,
 * so this must never reach the client bundle. The pure compose helpers
 * (threading, subjects, recipients) live in src/lib/mail/compose.ts.
 */
import { createMimeMessage } from 'mimetext';
import { mintMessageId, buildReferences } from '../../src/lib/mail/compose';
import type { Address } from '../../src/lib/schema';

export interface ComposePayload {
	from: Address;
	to: Address[];
	cc?: Address[];
	bcc?: Address[];
	subject: string;
	html?: string;
	text?: string;
	in_reply_to?: string;
	references?: string[];
	message_id?: string;
	attachments?: Array<{ filename: string; mime_type: string; base64: string }>;
}

export interface BuiltMessage {
	raw: string;
	message_id: string;
	references: string[];
}

/** Strip CR/LF and other control chars from a header value so user-supplied
 *  fields (recipients, subject, In-Reply-To/References) can't inject extra
 * headers — mimetext does not sanitize setHeader/addr inputs. */
function headerSafe(v: string): string {
	return v.replace(/[\r\n]+/g, ' ').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}

function addr(a: Address): { addr: string; name?: string } {
	return { addr: headerSafe(a.email ?? ''), name: a.name ? headerSafe(a.name) : undefined };
}

/** Remove the Bcc header (and any folded continuation) from a raw MIME message.
 *  Blind-copy recipients are delivered via the SMTP/Email-Service envelope, never
 *  a header — leaving Bcc in the transmitted copy discloses them to every
 * recipient. Gmail's API strips Bcc itself, so this is applied only on the
 *  raw-relay transports. */
export function stripBccHeader(raw: string): string {
	// Header/body boundary is the first blank line (handle CRLF and bare LF).
	const idx = raw.search(/\r?\n\r?\n/);
	const headerEnd = idx === -1 ? raw.length : idx;
	const rest = raw.slice(headerEnd);
	const eol = raw.includes('\r\n') ? '\r\n' : '\n';
	const kept: string[] = [];
	let dropping = false;
	for (const line of raw.slice(0, headerEnd).split(/\r?\n/)) {
		if (dropping) {
			if (/^[ \t]/.test(line)) continue; // folded continuation of Bcc — drop it too
			dropping = false;
		}
		if (/^bcc:/i.test(line)) {
			dropping = true;
			continue;
		}
		kept.push(line);
	}
	return kept.join(eol) + rest;
}

function randomId(): string {
	const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
	return c?.randomUUID?.().replace(/-/g, '').slice(0, 16) ?? Date.now().toString(16);
}

export function buildMimeMessage(payload: ComposePayload): BuiltMessage {
	const msg = createMimeMessage();
	const message_id = payload.message_id ?? mintMessageId(payload.from.email ?? '', randomId());

	msg.setSender(addr(payload.from));
	if (payload.to.length) msg.setTo(payload.to.map(addr));
	if (payload.cc?.length) msg.setCc(payload.cc.map(addr));
	if (payload.bcc?.length) msg.setBcc(payload.bcc.map(addr));
	msg.setSubject(headerSafe(payload.subject || '(no subject)'));
	msg.setHeader('Message-ID', headerSafe(message_id));

	const references = buildReferences(payload.references, payload.in_reply_to);
	if (payload.in_reply_to) msg.setHeader('In-Reply-To', headerSafe(payload.in_reply_to));
	if (references.length) msg.setHeader('References', headerSafe(references.join(' ')));
	msg.setHeader('X-Mailer', 'DelightMail');

	// multipart/alternative: text first, then html (clients prefer the last part).
	if (payload.text !== undefined) msg.addMessage({ contentType: 'text/plain', data: payload.text });
	if (payload.html !== undefined) msg.addMessage({ contentType: 'text/html', data: payload.html });
	if (payload.text === undefined && payload.html === undefined) {
		msg.addMessage({ contentType: 'text/plain', data: '' });
	}

	for (const att of payload.attachments ?? []) {
		// filename and mime_type are user-supplied and, like every other header value,
		// mimetext does not sanitize them — an un-neutered CR/LF here injects part
		// headers and can forge a MIME boundary. Strip control chars (headerSafe) and
		// the quote/backslash that would break out of the quoted filename, and accept
		// only a well-formed type/subtype (else fall back to a safe default).
		const filename = headerSafe(att.filename ?? '').replace(/["\\]/g, '_');
		const rawType = headerSafe(att.mime_type ?? '');
		const contentType = /^[\w.+-]+\/[\w.+-]+$/.test(rawType) ? rawType : 'application/octet-stream';
		msg.addAttachment({ filename, contentType, data: att.base64 });
	}

	return { raw: msg.asRaw(), message_id, references };
}
