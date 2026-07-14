/**
 * Pure mapping from a user/AI action to the field changes it makes on a thread
 * (and its messages). Unit-tested in actions.test.ts. The DB write + provider
 * job fan-out lives in server/src/actions.ts.
 */
export type ThreadActionName =
	| 'archive'
	| 'trash'
	| 'delete'
	| 'spam'
	| 'read'
	| 'unread'
	| 'star'
	| 'unstar'
	| 'move'
	| 'label';

export type Folder =
	| 'inbox'
	| 'archive'
	| 'trash'
	| 'spam'
	| 'sent'
	| 'drafts'
	| 'snoozed'
	| 'quarantine';

export interface ThreadStateForAction {
	folder: Folder;
	starred: boolean;
	unread_count: number;
	message_count: number;
	label_ids?: string[];
}

export interface ThreadPatch {
	folder?: Folder;
	starred?: boolean;
	unread_count?: number;
	label_ids?: string[];
	/** True when the message rows also need is_read flipped. */
	mark_read?: boolean;
	mark_unread?: boolean;
	/** True when this action hard-deletes locally (delete forever). */
	hard_delete?: boolean;
	/** The provider operation this maps to (for two-way sync). */
	provider_op:
		| 'archive'
		| 'trash'
		| 'delete_forever'
		| 'spam'
		| 'read'
		| 'unread'
		| 'star'
		| 'unstar'
		| 'move'
		| 'label'
		| 'none';
}

export function computeThreadPatch(
	action: ThreadActionName,
	state: ThreadStateForAction,
	opts: { folder?: Folder; label_id?: string } = {},
): ThreadPatch {
	switch (action) {
		case 'archive':
			return { folder: 'archive', provider_op: 'archive' };
		case 'trash':
			return { folder: 'trash', provider_op: 'trash' };
		case 'delete':
			// Delete forever — Gmail scope caveat handled at the provider layer.
			return { folder: 'trash', hard_delete: true, provider_op: 'delete_forever' };
		case 'spam':
			return { folder: 'spam', provider_op: 'spam' };
		case 'read':
			return { unread_count: 0, mark_read: true, provider_op: 'read' };
		case 'unread':
			return {
				unread_count: Math.max(1, state.message_count),
				mark_unread: true,
				provider_op: 'unread',
			};
		case 'star':
			return { starred: true, provider_op: 'star' };
		case 'unstar':
			return { starred: false, provider_op: 'unstar' };
		case 'move':
			return { folder: (opts.folder ?? 'inbox') as Folder, provider_op: 'move' };
		case 'label': {
			const set = new Set(state.label_ids ?? []);
			if (opts.label_id) set.add(opts.label_id);
			return { label_ids: [...set], provider_op: 'label' };
		}
		default:
			return { provider_op: 'none' };
	}
}

/** The inverse patch for undo (z). */
export function invertPatch(before: ThreadStateForAction, patch: ThreadPatch): ThreadPatch {
	return {
		folder: patch.folder !== undefined ? before.folder : undefined,
		starred: patch.starred !== undefined ? before.starred : undefined,
		unread_count: patch.unread_count !== undefined ? before.unread_count : undefined,
		label_ids: patch.label_ids !== undefined ? before.label_ids : undefined,
		mark_read: patch.mark_unread,
		mark_unread: patch.mark_read,
		provider_op: 'none',
	};
}
