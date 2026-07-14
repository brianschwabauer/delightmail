/**
 * Client-side optimistic action manager ("optimistic everything").
 * Actions apply to the local view within one frame, fire the authoritative
 * /api/threads/actions endpoint (which updates messages + provider write-back),
 * and are reversible via the undo stack (z).
 *
 * Optimism model:
 * - Folder MOVES (archive/trash/spam/move) relocate the thread IN THE LOCAL
 *   MIRROR immediately (`db.update` reindexes it), so it leaves its old folder
 *   AND shows up in the new one without waiting on the websocket round-trip —
 *   which the old "just hide it" overlay never did, so an archived mail was
 *   missing from the Archive folder until a full reload.
 * - Hard delete HIDES the thread (a `removed` set) until the delete broadcast
 *   lands (the row is gone server-side, so there's nothing to reindex to).
 * - Flag actions (star/unstar/read/unread) apply a local `patch` overlay.
 * Overlays clear once the server broadcast reconciles the mirror (or after a
 * short fallback timeout), so the two never disagree for long.
 */
import { getContext, setContext } from 'svelte';
import { toast } from '@delightstack/components';
import type { Thread } from '$lib/schema';
import type { MailDatabaseClient } from '$lib/clients';
import { computeThreadPatch, type ThreadActionName, type ThreadStateForAction } from './actions';

const OVERLAY_TTL = 4000;

interface UndoEntry {
	thread_ids: string[];
	label: string;
	restore: () => Promise<void>;
}

export class ActionManager {
	#removed = $state<Set<string>>(new Set());
	#patches = $state<Map<string, Partial<Thread>>>(new Map());
	#undoStack: UndoEntry[] = [];
	#db: MailDatabaseClient;
	#fetch: typeof globalThis.fetch;

	constructor(db: MailDatabaseClient, fetchFn: typeof globalThis.fetch = fetch) {
		this.#db = db;
		this.#fetch = fetchFn;
	}

	isRemoved(id: string): boolean {
		return this.#removed.has(id);
	}
	patchFor(id: string): Partial<Thread> | undefined {
		return this.#patches.get(id);
	}

	/** Apply an action to one or more threads with instant optimistic feedback. */
	async apply(
		threads: Thread[],
		action: ThreadActionName,
		opts: { folder?: string; label_id?: string } = {},
	): Promise<void> {
		if (!threads.length) return;
		const ids = threads.map((t) => String(t.id));

		// Snapshot previous state for undo / rollback.
		const prev = new Map(threads.map((t) => [String(t.id), snapshot(t)]));

		const patch = computeThreadPatch(action, stateOf(threads[0]), {
			folder: opts.folder as never,
			label_id: opts.label_id,
		});

		// A folder MOVE (archive/trash/spam/move) relocates the thread; a hard
		// delete removes it; everything else is a flag toggle. Read vs unread carry
		// a folder in the patch but must stay put, so exclude them explicitly.
		const movesFolder =
			patch.folder !== undefined &&
			!patch.hard_delete &&
			patch.provider_op !== 'read' &&
			patch.provider_op !== 'unread';

		// Optimistic local update.
		if (patch.hard_delete) this.#hide(ids);
		else if (movesFolder) this.#moveLocal(ids, patch.folder as string);
		else this.#patchFlags(ids, patch);

		// Authoritative call (provider write-back + per-message fields).
		try {
			await this.#post(ids, action, opts);
		} catch (err) {
			// Roll back the optimistic change — and register NO undo entry, so a
			// later `z` can't fire an inverse action for something that never happened.
			if (patch.hard_delete) this.#unhide(ids);
			else if (movesFolder) for (const [id, s] of prev) this.#moveLocal([id], s.folder);
			else this.#clearPatch(ids);
			toast(`Couldn't ${action}: ${(err as Error).message}`);
			return;
		}

		// Register undo only after the action actually succeeded, and show
		// the undo toast the plan requires where undo is possible. The toast's Undo
		// button reverses THIS entry (not whatever is on top of the stack) — it's
		// the only undo affordance on touch, where `z` doesn't exist.
		if (isUndoable(action)) {
			const restore = async () => {
				if (movesFolder) for (const [id, s] of prev) this.#moveLocal([id], s.folder);
				else this.#clearPatch(ids);
				await this.#post(ids, inverseAction(action), { folder: prev.get(ids[0])?.folder });
			};
			const entry: UndoEntry = { thread_ids: ids, label: undoLabel(action, ids.length), restore };
			this.#pushUndo(entry);
			toast(capitalize(undoLabel(action, ids.length)), {
				action: { label: 'Undo', onclick: () => void this.#undoEntry(entry) },
			});
		}

		// Folder moves are already real in the mirror (nothing to clear). Flag
		// overlays + the delete hide are dropped once the broadcast reconciles.
		if (patch.hard_delete) setTimeout(() => this.#unhide(ids), OVERLAY_TTL);
		else if (!movesFolder) setTimeout(() => this.#clearPatch(ids), OVERLAY_TTL);
	}

	async undo(): Promise<void> {
		const entry = this.#undoStack.pop();
		if (!entry) return;
		await this.#runUndo(entry);
	}

	/** Undo a specific entry (a toast's Undo button), wherever it sits in the stack. */
	async #undoEntry(entry: UndoEntry): Promise<void> {
		const i = this.#undoStack.indexOf(entry);
		if (i < 0) return; // already undone (z, or a second tap)
		this.#undoStack.splice(i, 1);
		await this.#runUndo(entry);
	}

	async #runUndo(entry: UndoEntry): Promise<void> {
		try {
			await entry.restore();
			toast('Undone');
		} catch (err) {
			toast(`Undo failed: ${(err as Error).message}`);
		}
	}

	/** Move threads to a folder in the LOCAL MIRROR (optimistic reindex + server
	 *  sync via the generic entity endpoint). This is what makes them leave the
	 *  current folder and show up in the target folder without a reload; the
	 *  authoritative `/api/threads/actions` call still drives provider write-back
	 *  and per-message fields. */
	#moveLocal(ids: string[], folder: string): void {
		for (const id of ids) {
			void this.#db.update('thread', id, { folder } as never).catch(() => {});
		}
	}

	#hide(ids: string[]): void {
		const removed = new Set(this.#removed);
		for (const id of ids) removed.add(id);
		this.#removed = removed;
	}

	#unhide(ids: string[]): void {
		const removed = new Set(this.#removed);
		for (const id of ids) removed.delete(id);
		this.#removed = removed;
	}

	#patchFlags(ids: string[], patch: ReturnType<typeof computeThreadPatch>): void {
		const patches = new Map(this.#patches);
		for (const id of ids) {
			patches.set(id, {
				...(patches.get(id) ?? {}),
				...(patch.starred !== undefined ? { starred: patch.starred } : {}),
				...(patch.unread_count !== undefined ? { unread_count: patch.unread_count } : {}),
			});
		}
		this.#patches = patches;
	}

	#clearPatch(ids: string[]): void {
		const patches = new Map(this.#patches);
		for (const id of ids) patches.delete(id);
		this.#patches = patches;
	}

	#pushUndo(entry: UndoEntry): void {
		this.#undoStack.push(entry);
		if (this.#undoStack.length > 20) this.#undoStack.shift();
	}

	async #post(
		ids: string[],
		action: string,
		opts: { folder?: string; label_id?: string },
	): Promise<void> {
		const res = await this.#fetch('/api/threads/actions', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ thread_ids: ids, action, ...opts }),
		});
		if (!res.ok) {
			const body = (await res.json().catch(() => ({}))) as { message?: string };
			throw new Error(body.message || `${res.status}`);
		}
	}
}

function snapshot(t: Thread): { folder: string; starred: boolean; unread_count: number } {
	return { folder: t.folder as string, starred: !!t.starred, unread_count: t.unread_count ?? 0 };
}
function stateOf(t: Thread): ThreadStateForAction {
	return {
		folder: t.folder as never,
		starred: !!t.starred,
		unread_count: t.unread_count ?? 0,
		message_count: t.message_count ?? 1,
		label_ids: (t.label_ids as string[]) ?? [],
	};
}

/**
 * Whether `z` can meaningfully reverse this action. delete (hard delete forever)
 * can't be locally restored, so it never enters the undo stack.
 */
function isUndoable(action: ThreadActionName): boolean {
	return action !== 'delete';
}

function capitalize(s: string): string {
	return s.charAt(0).toUpperCase() + s.slice(1);
}

/** The action that reverses a given action (for undo). */
function inverseAction(action: ThreadActionName): ThreadActionName {
	switch (action) {
		case 'archive':
		case 'trash':
		case 'spam':
		case 'delete':
		case 'move':
			return 'move'; // move back to the previous folder
		case 'star':
			return 'unstar';
		case 'unstar':
			return 'star';
		case 'read':
			return 'unread';
		case 'unread':
			return 'read';
		default:
			return action;
	}
}

function undoLabel(action: ThreadActionName, n: number): string {
	const noun = n === 1 ? 'conversation' : `${n} conversations`;
	return `${action} ${noun}`;
}

const KEY = Symbol('actions');
export function provideActions(
	db: MailDatabaseClient,
	fetchFn?: typeof globalThis.fetch,
): ActionManager {
	const mgr = new ActionManager(db, fetchFn);
	setContext(KEY, mgr);
	return mgr;
}
export function useActions(): ActionManager {
	return getContext<ActionManager>(KEY);
}
