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
	| 'label'
	| 'snooze';

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
	/** Epoch-ms wake time (snooze); 0 clears it (any move out of snoozed). */
	snoozed_until?: number;
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
	opts: { folder?: Folder; label_id?: string; snooze_until?: number } = {},
): ThreadPatch {
	switch (action) {
		case 'archive':
			return { folder: 'archive', snoozed_until: 0, provider_op: 'archive' };
		case 'trash':
			return { folder: 'trash', snoozed_until: 0, provider_op: 'trash' };
		case 'delete':
			// Delete forever — Gmail scope caveat handled at the provider layer.
			return { folder: 'trash', hard_delete: true, provider_op: 'delete_forever' };
		case 'spam':
			return { folder: 'spam', snoozed_until: 0, provider_op: 'spam' };
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
			return { folder: (opts.folder ?? 'inbox') as Folder, snoozed_until: 0, provider_op: 'move' };
		case 'snooze':
			// The thread hides in `snoozed` until snoozed_until; the MailboxServer's
			// wake job moves it back to the inbox. Gmail's copy archives while
			// snoozed (so other clients quiet down too) and returns on wake.
			return {
				folder: 'snoozed',
				snoozed_until: opts.snooze_until ?? Date.now() + 60 * 60_000,
				provider_op: 'archive',
			};
		case 'label': {
			const set = new Set(state.label_ids ?? []);
			if (opts.label_id) set.add(opts.label_id);
			return { label_ids: [...set], provider_op: 'label' };
		}
		default:
			return { provider_op: 'none' };
	}
}

/** The inverse patch for undo (Ctrl+z). */
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
