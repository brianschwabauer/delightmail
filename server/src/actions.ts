/**
 * DB-integrated thread actions (outbound). Applies the pure patch
 * from src/lib/mail/actions.ts to the thread + its messages, optimistically.
 * MailboxServer fans out provider write-back jobs after this returns.
 */
import {
	computeThreadPatch,
	type ThreadActionName,
	type ThreadStateForAction,
	type Folder,
} from '../../src/lib/mail/actions';
import type { DbLike } from './ingest';

export interface ThreadActionRequest {
	thread_ids: string[];
	action: string;
	folder?: string;
	label_id?: string;
	snooze_until?: number;
}

/** One create/update/delete for the DO's declarative transaction API. */
type TxOp =
	| { update: { type: string; id: string | number; data: Record<string, unknown> } }
	| { delete: { type: string; id: string | number } };

// Stay safely under the transaction API's 5000-op ceiling; flushing at a
// thread boundary keeps each thread's changes atomic.
const MAX_OPS_PER_TRANSACTION = 1000;

export function applyThreadActionLocal(db: DbLike, req: ThreadActionRequest): string[] {
	const affected: string[] = [];
	const action = req.action as ThreadActionName;

	// Every write goes through the declarative transaction API — NEVER raw SQL.
	// Raw UPDATE/DELETE bypasses the Orama search index, delete tombstones, and
	// websocket broadcasts: a raw-deleted thread stayed in the index forever
	// (reappearing on every device as an unopenable ghost that still matched
	// searches), and raw flag updates were invisible to other devices. Batching
	// all ops into one transaction also means each entity's index serializes
	// once per flush instead of once per row.
	let ops: TxOp[] = [];
	const flush = () => {
		if (!ops.length) return;
		db.transaction(ops);
		ops = [];
	};

	for (const thread_id of req.thread_ids) {
		let thread: Record<string, unknown>;
		try {
			thread = db.get('thread', thread_id);
		} catch {
			continue;
		}

		const state: ThreadStateForAction = {
			folder: (thread.folder as Folder) ?? 'inbox',
			starred: !!thread.starred,
			unread_count: (thread.unread_count as number) ?? 0,
			message_count: (thread.message_count as number) ?? 0,
			label_ids: (thread.label_ids as string[]) ?? [],
		};

		const patch = computeThreadPatch(action, state, {
			folder: req.folder as Folder | undefined,
			label_id: req.label_id,
			snooze_until: req.snooze_until,
		});

		const message_ids = (
			db.exec(`SELECT id FROM message WHERE thread_id = ?`, thread_id) as Array<{
				id: string;
			}>
		).map((r) => r.id);

		if (patch.hard_delete) {
			// Delete-forever hard-deletes locally after moving to trash on the
			// provider. Tombstoned deletes so every device drops the rows too.
			for (const id of message_ids) ops.push({ delete: { type: 'message', id } });
			ops.push({ delete: { type: 'thread', id: thread_id } });
		} else {
			const threadUpdate: Record<string, unknown> = {};
			if (patch.folder !== undefined) threadUpdate.folder = patch.folder;
			if (patch.starred !== undefined) threadUpdate.starred = patch.starred;
			if (patch.unread_count !== undefined)
				threadUpdate.unread_count = patch.unread_count;
			if (patch.label_ids !== undefined) threadUpdate.label_ids = patch.label_ids;
			if (patch.snoozed_until !== undefined)
				threadUpdate.snoozed_until = patch.snoozed_until;
			if (Object.keys(threadUpdate).length) {
				ops.push({ update: { type: 'thread', id: thread_id, data: threadUpdate } });
			}

			// Propagate to message rows where the change is per-message.
			const messageUpdate: Record<string, unknown> = {};
			if (
				patch.folder !== undefined &&
				patch.provider_op !== 'read' &&
				patch.provider_op !== 'unread'
			) {
				messageUpdate.folder = patch.folder;
			}
			if (patch.mark_read) messageUpdate.is_read = true;
			if (patch.mark_unread) messageUpdate.is_read = false;
			if (patch.starred !== undefined) messageUpdate.is_starred = patch.starred;
			if (Object.keys(messageUpdate).length) {
				for (const id of message_ids) {
					ops.push({ update: { type: 'message', id, data: messageUpdate } });
				}
			}
		}

		if (ops.length >= MAX_OPS_PER_TRANSACTION) flush();
		affected.push(thread_id);
	}

	flush();
	return affected;
}
