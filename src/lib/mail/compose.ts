/**
 * Compose domain helpers: reply/forward recipients, subjects, quoting, and
 * threading (Message-ID / References). Pure + unit-tested in compose.test.ts.
 *
 * The actual MIME serialization (`buildMimeMessage`, which pulls in `mimetext`
 * and node:os) lives in server/src/mime-build.ts so it never reaches the client
 * bundle.
 */
import type { Address } from '../schema';

/** Mint a globally-unique Message-ID for an identity's domain. */
export function mintMessageId(fromEmail: string, unique: string): string {
	const domain = fromEmail.split('@')[1] ?? 'delightmail.local';
	return `<${unique}@${domain}>`;
}

/** Compute the References header for a reply (RFC 5322 §3.6.4). */
export function buildReferences(
	parentReferences: string[] | undefined,
	inReplyTo: string | undefined,
): string[] {
	const refs = [...(parentReferences ?? [])];
	if (inReplyTo && !refs.includes(inReplyTo)) refs.push(inReplyTo);
	return refs;
}

/** Build the quoted-history block for a reply body (plain text). */
export function quoteText(originalText: string, from: Address, date: number): string {
	const when = new Date(date).toUTCString();
	const who = from.name || from.email || 'someone';
	const quoted = originalText
		.split('\n')
		.map((line) => `> ${line}`)
		.join('\n');
	return `\n\nOn ${when}, ${who} wrote:\n${quoted}`;
}

/** Build the quoted-history block for a reply body (HTML). */
export function quoteHtml(originalHtml: string, from: Address, date: number): string {
	const when = new Date(date).toUTCString();
	const who = escapeHtml(from.name || from.email || 'someone');
	return (
		`<br><br><div class="dm-quote">On ${when}, ${who} wrote:` +
		`<blockquote style="margin:0 0 0 0.8ex;border-left:2px solid #ccc;padding-left:1ex">` +
		`${originalHtml}</blockquote></div>`
	);
}

/** The subject line for a reply/forward, avoiding double prefixes. */
export function replySubject(subject: string, kind: 'reply' | 'forward'): string {
	const prefix = kind === 'reply' ? 'Re: ' : 'Fwd: ';
	const stripped = subject.replace(/^\s*(re|fwd?)\s*:\s*/i, '').trim();
	return prefix + stripped;
}

/** Recipients for reply-all: the original from + to + cc, minus self. */
export function replyAllRecipients(
	original: { from?: Address; to?: Address[]; cc?: Address[]; reply_to?: Address[] },
	selfEmails: string[],
): { to: Address[]; cc: Address[] } {
	const self = new Set(selfEmails.map((e) => e.toLowerCase()));
	const primary = original.reply_to?.length ? original.reply_to : original.from ? [original.from] : [];
	const to = dedupe(primary, self);
	const cc = dedupe([...(original.to ?? []), ...(original.cc ?? [])], self, to);
	return { to, cc };
}

function dedupe(list: Address[], exclude: Set<string>, already: Address[] = []): Address[] {
	const seen = new Set([...already.map((a) => (a.email ?? '').toLowerCase()), ...exclude]);
	const out: Address[] = [];
	for (const a of list) {
		const key = (a.email ?? '').toLowerCase();
		if (!key || seen.has(key)) continue;
		seen.add(key);
		out.push(a);
	}
	return out;
}

function escapeHtml(s: string): string {
	return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

// ---------------------------------------------------------------------------
// Editor (ProseMirror) document helpers for compose. Pure + tested.
// ---------------------------------------------------------------------------
export interface ProseNode {
	type: string;
	content?: ProseNode[];
	text?: string;
	attrs?: Record<string, unknown>;
}

const BLOCK_TYPES = new Set([
	'paragraph',
	'heading',
	'blockquote',
	'code_block',
	'list_item',
	'bullet_list',
	'ordered_list',
]);

function asDoc(doc: unknown): ProseNode {
	const d = doc as ProseNode | undefined;
	if (d && d.type === 'doc') return { type: 'doc', content: d.content ?? [] };
	return { type: 'doc', content: [] };
}

/** Plain text → a minimal ProseMirror doc (one paragraph per line). The
 *  inverse of docToText for simple content — used by the signature editor. */
export function textToDoc(text: string): ProseNode {
	const lines = text.replace(/\r\n/g, '\n').split('\n');
	// Trim trailing empty lines so round-trips don't grow the doc.
	while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
	return {
		type: 'doc',
		content: lines.map((line) => ({
			type: 'paragraph',
			content: line ? [{ type: 'text', text: line }] : [],
		})),
	};
}

/** Flatten a ProseMirror doc to plain text (for signature/quote previews). */
export function docToText(node: unknown): string {
	const n = node as ProseNode | undefined;
	if (!n) return '';
	if (typeof n.text === 'string') return n.text;
	const inner = (n.content ?? []).map(docToText).join('');
	return BLOCK_TYPES.has(n.type) ? `${inner}\n` : inner;
}

/**
 * Append an identity's signature (below a `--` marker) to the compose doc at send
 * time, leaving what the user wrote untouched. Null signature is a no-op.
 */
export function mergeSignatureDoc(editorDoc: unknown, signatureDoc: unknown): ProseNode {
	const base = asDoc(editorDoc);
	if (!signatureDoc) return base;
	const sig = asDoc(signatureDoc);
	const marker: ProseNode = { type: 'paragraph', content: [{ type: 'text', text: '-- ' }] };
	return { type: 'doc', content: [...(base.content ?? []), marker, ...(sig.content ?? [])] };
}

/**
 * Build the quoted-history doc for a reply: an empty paragraph to type into,
 * then a blockquote with the attribution line and the original text.
 */
export function buildQuoteDoc(original: { from?: Address; date?: number; text?: string }): ProseNode {
	const when = original.date ? new Date(original.date).toUTCString() : '';
	const who = original.from?.name || original.from?.email || 'someone';
	const attribution: ProseNode = {
		type: 'paragraph',
		content: [{ type: 'text', text: `On ${when}, ${who} wrote:` }],
	};
	const quotedParas: ProseNode[] = (original.text ?? '').split('\n').map((line) => ({
		type: 'paragraph',
		content: line ? [{ type: 'text', text: line }] : [],
	}));
	return {
		type: 'doc',
		content: [{ type: 'paragraph' }, { type: 'blockquote', content: [attribution, ...quotedParas] }],
	};
}
