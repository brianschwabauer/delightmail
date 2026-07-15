/**
 * Maps a UI view name (the `/mail/[view]` param) to a thread search query.
 * Pure — unit-tested in views.test.ts. The `folder` enum values match the schema.
 */
export interface ThreadQuery {
	where?: Record<string, unknown>;
	order?: Array<{ key: string; direction: 'ASC' | 'DESC' }>;
	term?: string;
	limit?: number;
}

const BY_LAST_MESSAGE: ThreadQuery['order'] = [{ key: 'last_message_at', direction: 'DESC' }];

/** Orama enum `where` uses `{ eq }`; string[] fields take a plain string. */
function folderIs(folder: string) {
	return { folder: { eq: folder } };
}

export function viewToQuery(
	view: string,
	opts: { account_id?: string; term?: string } = {},
): ThreadQuery {
	const account = opts.account_id ? { account_ids: opts.account_id } : {};
	const base: ThreadQuery = { order: BY_LAST_MESSAGE, limit: 100 };

	switch (view) {
		case 'inbox':
			return { ...base, where: { ...folderIs('inbox'), ...account } };
		case 'filtered':
			return { ...base, where: { ...folderIs('quarantine'), ...account } };
		case 'starred':
			return { ...base, where: { starred: true, ...account } };
		case 'snoozed':
			// Soonest wake first — the top row is the next thing coming back.
			return {
				where: { ...folderIs('snoozed'), ...account },
				order: [{ key: 'snoozed_until', direction: 'ASC' }],
				limit: 100,
			};
		case 'sent':
			return { ...base, where: { ...folderIs('sent'), ...account } };
		case 'drafts':
			return { ...base, where: { ...folderIs('drafts'), ...account } };
		case 'archive':
			return { ...base, where: { ...folderIs('archive'), ...account } };
		case 'spam':
			return { ...base, where: { ...folderIs('spam'), ...account } };
		case 'trash':
			return { ...base, where: { ...folderIs('trash'), ...account } };
		case 'search':
			return { ...base, term: opts.term, where: account };
		default:
			if (view.startsWith('label/')) {
				const label_id = view.slice('label/'.length);
				return { ...base, where: { label_ids: label_id, ...account } };
			}
			return { ...base, where: { ...folderIs('inbox'), ...account } };
	}
}

/** The folder a view maps to, or undefined for cross-folder views
 *  (starred/search/label). Used to scope message-index searches. */
export function folderOfView(view: string): string | undefined {
	const map: Record<string, string> = {
		inbox: 'inbox',
		filtered: 'quarantine',
		sent: 'sent',
		drafts: 'drafts',
		archive: 'archive',
		spam: 'spam',
		trash: 'trash',
		snoozed: 'snoozed',
	};
	return map[view];
}

/** Human label for a view, used in the list header + document title. */
export function viewTitle(view: string): string {
	const map: Record<string, string> = {
		inbox: 'Inbox',
		filtered: 'AI Filtered',
		starred: 'Starred',
		snoozed: 'Snoozed',
		sent: 'Sent',
		drafts: 'Drafts',
		archive: 'Archive',
		spam: 'Spam',
		trash: 'Trash',
		search: 'Search',
	};
	return map[view] ?? (view.startsWith('label/') ? 'Label' : 'Mail');
}
