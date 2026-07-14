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
}

export function applyThreadActionLocal(db: DbLike, req: ThreadActionRequest): string[] {
	const affected: string[] = [];
	const action = req.action as ThreadActionName;

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
		});

		const threadUpdate: Record<string, unknown> = {};
		if (patch.folder !== undefined) threadUpdate.folder = patch.folder;
		if (patch.starred !== undefined) threadUpdate.starred = patch.starred;
		if (patch.unread_count !== undefined) threadUpdate.unread_count = patch.unread_count;
		if (patch.label_ids !== undefined) threadUpdate.label_ids = patch.label_ids;

		if (Object.keys(threadUpdate).length) {
			db.update('thread', thread_id, threadUpdate);
		}

		// Propagate to message rows where the change is per-message.
		if (patch.folder !== undefined && patch.provider_op !== 'read' && patch.provider_op !== 'unread') {
			db.exec(`UPDATE message SET folder = ? WHERE thread_id = ?`, patch.folder, thread_id);
		}
		if (patch.mark_read) {
			db.exec(`UPDATE message SET is_read = 1 WHERE thread_id = ?`, thread_id);
		}
		if (patch.mark_unread) {
			db.exec(`UPDATE message SET is_read = 0 WHERE thread_id = ?`, thread_id);
		}
		if (patch.starred !== undefined) {
			db.exec(
				`UPDATE message SET is_starred = ? WHERE thread_id = ?`,
				patch.starred ? 1 : 0,
				thread_id,
			);
		}

		// Delete-forever hard-deletes locally after moving to trash on the provider.
		if (patch.hard_delete) {
			db.exec(`DELETE FROM message WHERE thread_id = ?`, thread_id);
			db.exec(`DELETE FROM thread WHERE id = ?`, thread_id);
		}

		affected.push(thread_id);
	}

	return affected;
}
