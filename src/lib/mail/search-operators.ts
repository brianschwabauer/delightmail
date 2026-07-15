/**
 * Search operator parsing for the `/` search bar. Pure — unit-tested in
 * search-operators.test.ts.
 *
 * Supported operators (everything else stays in the free-text term):
 *   from:alice@x.com | from:alice    sender match (message-scope)
 *   has:attachment                   thread has attachments
 *   is:unread                        thread has unread messages
 *   is:starred                       thread is starred
 *   in:archive / in:trash / …        limit to a folder (all-mail scope)
 */
export interface ParsedSearch {
	/** The free-text term with all operators removed. */
	term: string;
	/** Sender filter (matches the message index's from_text). */
	from?: string;
	hasAttachment?: boolean;
	unread?: boolean;
	starred?: boolean;
	/** Folder restriction from in:<folder>. */
	folder?: string;
}

const FOLDER_VALUES = new Set([
	'inbox',
	'quarantine',
	'sent',
	'drafts',
	'archive',
	'spam',
	'trash',
	'snoozed',
]);

export function parseSearchInput(input: string): ParsedSearch {
	const out: ParsedSearch = { term: '' };
	const words: string[] = [];
	for (const token of input.trim().split(/\s+/)) {
		const m = token.match(/^(from|has|is|in):(.+)$/i);
		if (!m) {
			if (token) words.push(token);
			continue;
		}
		const op = m[1].toLowerCase();
		const value = m[2].toLowerCase();
		if (op === 'from' && value) out.from = value;
		else if (op === 'has' && (value === 'attachment' || value === 'attachments'))
			out.hasAttachment = true;
		else if (op === 'is' && value === 'unread') out.unread = true;
		else if (op === 'is' && value === 'starred') out.starred = true;
		else if (op === 'in' && FOLDER_VALUES.has(value)) out.folder = value;
		// Unknown operator values fall back to plain text so typos still search.
		else words.push(token);
	}
	out.term = words.join(' ');
	return out;
}

/** Whether the parsed input has any effect beyond a free-text term. */
export function hasOperators(p: ParsedSearch): boolean {
	return !!(p.from || p.hasAttachment || p.unread || p.starred || p.folder);
}
