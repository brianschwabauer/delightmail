/**
 * IMAP folder ↔ DelightMail folder mapping (§5.3). Pure + unit-tested. Uses the
 * IMAP special-use flags where present, else common folder-name heuristics.
 */
export function imapToLocalFolder(
	name: string,
	specialUse?: string,
): 'inbox' | 'sent' | 'trash' | 'spam' | 'archive' | null {
	const su = (specialUse ?? '').toLowerCase();
	if (su.includes('\\sent')) return 'sent';
	if (su.includes('\\trash')) return 'trash';
	if (su.includes('\\junk')) return 'spam';
	if (su.includes('\\archive') || su.includes('\\all')) return 'archive';

	const n = name.toLowerCase().replace(/^inbox[./]/, '');
	if (n === 'inbox') return 'inbox';
	if (/(^|[./])sent( items| mail)?$/.test(n) || n === 'sent') return 'sent';
	if (/(^|[./])(trash|deleted items|bin)$/.test(n)) return 'trash';
	if (/(^|[./])(junk|spam)$/.test(n)) return 'spam';
	if (/(^|[./])(archive|all mail)$/.test(n)) return 'archive';
	return null; // other folders become labels, not primary locations
}

/** The IMAP folders worth polling for a two-way mirror. */
export const POLLED_SPECIAL_USE = ['\\Inbox', '\\Sent', '\\Archive', '\\Junk', '\\Trash', '\\All'];
