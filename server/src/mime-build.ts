/**
 * RFC-822 MIME serialization (§6). Server-only: `mimetext` pulls in node:os,
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

function addr(a: Address): { addr: string; name?: string } {
	return { addr: a.email ?? '', name: a.name };
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
	msg.setSubject(payload.subject || '(no subject)');
	msg.setHeader('Message-ID', message_id);

	const references = buildReferences(payload.references, payload.in_reply_to);
	if (payload.in_reply_to) msg.setHeader('In-Reply-To', payload.in_reply_to);
	if (references.length) msg.setHeader('References', references.join(' '));
	msg.setHeader('X-Mailer', 'DelightMail');

	// multipart/alternative: text first, then html (clients prefer the last part).
	if (payload.text !== undefined) msg.addMessage({ contentType: 'text/plain', data: payload.text });
	if (payload.html !== undefined) msg.addMessage({ contentType: 'text/html', data: payload.html });
	if (payload.text === undefined && payload.html === undefined) {
		msg.addMessage({ contentType: 'text/plain', data: '' });
	}

	for (const att of payload.attachments ?? []) {
		msg.addAttachment({ filename: att.filename, contentType: att.mime_type, data: att.base64 });
	}

	return { raw: msg.asRaw(), message_id, references };
}
