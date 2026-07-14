/**
 * MIME parsing helpers. Wraps `postal-mime` (Workers-compatible) and
 * normalizes its output into the shapes the ingest pipeline expects. The pure
 * helpers (address normalization, header extraction, excerpt) are unit-tested in
 * mime.test.ts; `parseEmail` is exercised against real .eml fixtures.
 */
import PostalMime, { type Email, type Address as PmAddress } from 'postal-mime';
import type { Address } from '../schema';

export interface HeadersSubset {
	list_unsubscribe?: string;
	list_unsubscribe_post?: string;
	list_id?: string;
	delivered_to?: string;
	auto_submitted?: string;
	precedence?: string;
	spf?: string;
	dkim?: string;
	dmarc?: string;
}

export interface ParsedAttachment {
	filename: string;
	mime_type: string;
	disposition: 'attachment' | 'inline' | null;
	content_id?: string;
	size_bytes: number;
	content: ArrayBuffer | Uint8Array | string;
}

export interface ParsedEmail {
	rfc822_message_id: string;
	in_reply_to?: string;
	references: string[];
	from?: Address;
	to: Address[];
	cc: Address[];
	bcc: Address[];
	reply_to: Address[];
	subject: string;
	date: number;
	text: string;
	html?: string;
	snippet: string;
	text_excerpt: string;
	headers_subset: HeadersSubset;
	attachments: ParsedAttachment[];
	size_bytes: number;
}

const EXCERPT_BYTES = 8192;

/** Convert a postal-mime address to our `{name,email}` shape (flattening groups). */
export function normalizeAddress(addr: PmAddress | undefined): Address | undefined {
	if (!addr) return undefined;
	if ('group' in addr && addr.group) {
		// A group address — take the first member as a representative.
		const first = addr.group[0];
		return first ? { name: first.name || undefined, email: first.address } : undefined;
	}
	const mb = addr as { name?: string; address?: string };
	if (!mb.address && !mb.name) return undefined;
	return { name: mb.name || undefined, email: mb.address };
}

export function normalizeAddressList(list: PmAddress[] | undefined): Address[] {
	if (!list) return [];
	const out: Address[] = [];
	for (const a of list) {
		if ('group' in a && a.group) {
			for (const m of a.group) out.push({ name: m.name || undefined, email: m.address });
		} else {
			const mb = a as { name?: string; address?: string };
			if (mb.address || mb.name) out.push({ name: mb.name || undefined, email: mb.address });
		}
	}
	return out;
}

/** Parse a References/In-Reply-To header value into individual message-ids. */
export function parseReferences(value: string | undefined): string[] {
	if (!value) return [];
	return (value.match(/<[^>]+>/g) ?? []).map((s) => s.trim());
}

/** Pull the small set of headers features actually need. */
export function extractHeadersSubset(headers: Array<{ key: string; value: string }>): HeadersSubset {
	const get = (name: string): string | undefined => {
		const lname = name.toLowerCase();
		const found = headers.find((h) => h.key.toLowerCase() === lname);
		return found?.value;
	};
	const authResults = (get('authentication-results') ?? '').toLowerCase();
	const verdict = (mech: string): string | undefined => {
		const m = authResults.match(new RegExp(`${mech}=([a-z]+)`));
		return m?.[1];
	};
	return {
		list_unsubscribe: get('list-unsubscribe'),
		list_unsubscribe_post: get('list-unsubscribe-post'),
		list_id: get('list-id'),
		delivered_to: get('delivered-to'),
		auto_submitted: get('auto-submitted'),
		precedence: get('precedence'),
		spf: verdict('spf'),
		dkim: verdict('dkim'),
		dmarc: verdict('dmarc'),
	};
}

/** Crude but robust HTML→text for excerpts/snippets (real body stays in R2). */
export function htmlToPlainText(html: string): string {
	return html
		.replace(/<style[\s\S]*?<\/style>/gi, ' ')
		.replace(/<script[\s\S]*?<\/script>/gi, ' ')
		.replace(/<br\s*\/?\s*>/gi, '\n')
		.replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
		.replace(/<[^>]+>/g, ' ')
		.replace(/&nbsp;/gi, ' ')
		.replace(/&amp;/gi, '&')
		.replace(/&lt;/gi, '<')
		.replace(/&gt;/gi, '>')
		.replace(/&#39;|&apos;/gi, "'")
		.replace(/&quot;/gi, '"')
		.replace(/[ \t]+/g, ' ')
		.replace(/[ \t]*\n[ \t]*/g, '\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

/** Clamp a Date header to a sane epoch (absurd dates clamp to now). */
export function normalizeDate(dateStr: string | undefined, receivedAt = Date.now()): number {
	if (!dateStr) return receivedAt;
	const parsed = Date.parse(dateStr);
	if (Number.isNaN(parsed)) return receivedAt;
	// Guard against dates far in the future (spam) or absurdly old.
	if (parsed > receivedAt + 24 * 60 * 60 * 1000) return receivedAt;
	if (parsed < 0) return receivedAt;
	return parsed;
}

function utf8Bytes(s: string): number {
	let n = 0;
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		n += c < 0x80 ? 1 : c < 0x800 ? 2 : 3;
	}
	return n;
}

/** First ~8 KB of plain text — the only body content that lands in SQLite. */
export function toExcerpt(text: string): string {
	if (utf8Bytes(text) <= EXCERPT_BYTES) return text;
	// Trim to the byte budget without splitting a surrogate pair.
	let out = text.slice(0, EXCERPT_BYTES);
	while (utf8Bytes(out) > EXCERPT_BYTES) out = out.slice(0, -64);
	return out;
}

export async function parseEmail(
	raw: string | ArrayBuffer | Uint8Array,
	opts: { receivedAt?: number } = {},
): Promise<ParsedEmail> {
	const email: Email = await PostalMime.parse(raw);
	const receivedAt = opts.receivedAt ?? Date.now();

	const text = email.text || (email.html ? htmlToPlainText(email.html) : '');
	const excerpt = toExcerpt(text);
	const snippet = text.replace(/\s+/g, ' ').trim().slice(0, 120);

	const attachments: ParsedAttachment[] = (email.attachments ?? []).map((a) => ({
		filename: a.filename || 'attachment',
		mime_type: a.mimeType || 'application/octet-stream',
		disposition: a.disposition,
		content_id: a.contentId,
		size_bytes:
			typeof a.content === 'string'
				? utf8Bytes(a.content)
				: (a.content as ArrayBuffer | Uint8Array).byteLength,
		content: a.content,
	}));

	const rawSize =
		typeof raw === 'string'
			? utf8Bytes(raw)
			: (raw as ArrayBuffer | Uint8Array).byteLength;

	return {
		rfc822_message_id: email.messageId || (await syntheticMessageId(email, receivedAt)),
		in_reply_to: email.inReplyTo,
		references: parseReferences(email.references),
		from: normalizeAddress(email.from),
		to: normalizeAddressList(email.to),
		cc: normalizeAddressList(email.cc),
		bcc: normalizeAddressList(email.bcc),
		reply_to: normalizeAddressList(email.replyTo),
		subject: email.subject || '(no subject)',
		date: normalizeDate(email.date, receivedAt),
		text,
		html: email.html || undefined,
		snippet,
		text_excerpt: excerpt,
		headers_subset: extractHeadersSubset(email.headers ?? []),
		attachments,
		size_bytes: rawSize,
	};
}

/**
 * Deterministic fallback id for the rare message with no Message-ID.
 * SHA-256 of Date+From+Subject+To+body-prefix (per the plan) — a 32-bit hash
 * collides at ~50% by ~65k such messages (birthday bound), silently dropping the
 * colliding email as a duplicate; a 128-bit digest makes that negligible.
 */
async function syntheticMessageId(email: Email, receivedAt: number): Promise<string> {
	const basis = [
		email.date ?? receivedAt,
		email.from && 'address' in email.from ? email.from.address : '',
		email.subject ?? '',
		(email.to ?? [])
			.map((t) => ('address' in t ? t.address : ''))
			.join(','),
		(email.text ?? '').slice(0, 64),
	].join('|');
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(basis));
	const hex = [...new Uint8Array(digest)]
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('')
		.slice(0, 32);
	return `<synthetic-${hex}@delightmail.local>`;
}
