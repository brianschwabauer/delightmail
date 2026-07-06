/**
 * Compose domain helpers (§6): reply/forward recipients, subjects, quoting, and
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
