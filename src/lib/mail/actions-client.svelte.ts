/**
 * Client-side optimistic action manager (§10.2, §11 "optimistic everything").
 * Actions apply to the local view within one frame, fire the authoritative
 * /api/threads/actions endpoint (which updates messages + provider write-back),
 * and are reversible via the undo stack (z).
 *
 * Optimism model:
 * - Folder-out actions (archive/trash/spam/move/delete) HIDE the thread from the
 *   current view immediately (a `removed` set).
 * - Flag actions (star/unstar/read/unread) apply a local `patch` overlay.
 * The overlay is cleared once the server broadcast reconciles the mirror (or after
 * a short fallback timeout), so the two never disagree for long.
 */
import { getContext, setContext } from 'svelte';
import { toast } from '@delightstack/components';
import type { Thread } from '$lib/schema';
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
	#fetch: typeof globalThis.fetch;

	constructor(fetchFn: typeof globalThis.fetch = fetch) {
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

		// Snapshot previous state for undo.
		const prev = new Map(threads.map((t) => [String(t.id), snapshot(t)]));

		// Optimistic overlay.
		const patch = computeThreadPatch(
			action,
			stateOf(threads[0]),
			{ folder: opts.folder as never, label_id: opts.label_id },
		);
		this.#applyOverlay(ids, action, patch);

		// Authoritative call.
		try {
			await this.#post(ids, action, opts);
		} catch (err) {
			// Roll back the overlay on failure — and register NO undo entry, so a
			// later `z` can't fire an inverse action for something that never happened.
			this.#clearOverlay(ids);
			toast(`Couldn't ${action}: ${(err as Error).message}`);
			return;
		}

		// Register undo only after the action actually succeeded (§10.2), and show
		// the undo toast the plan requires where undo is possible.
		if (isUndoable(action)) {
			const restore = async () => {
				this.#clearOverlay(ids);
				await this.#post(ids, inverseAction(action), { folder: prev.get(ids[0])?.folder });
			};
			this.#pushUndo({ thread_ids: ids, label: undoLabel(action, ids.length), restore });
			toast(`${capitalize(undoLabel(action, ids.length))} · press z to undo`);
		}

		// Clear the overlay after reconciliation.
		setTimeout(() => this.#clearOverlay(ids), OVERLAY_TTL);
	}

	async undo(): Promise<void> {
		const entry = this.#undoStack.pop();
		if (!entry) return;
		try {
			await entry.restore();
			toast('Undone');
		} catch (err) {
			toast(`Undo failed: ${(err as Error).message}`);
		}
	}

	#applyOverlay(ids: string[], action: ThreadActionName, patch: ReturnType<typeof computeThreadPatch>): void {
		const removed = new Set(this.#removed);
		const patches = new Map(this.#patches);
		for (const id of ids) {
			if (patch.hard_delete || (patch.folder && patch.provider_op !== 'read' && patch.provider_op !== 'unread')) {
				removed.add(id);
			} else {
				patches.set(id, {
					...(patches.get(id) ?? {}),
					...(patch.starred !== undefined ? { starred: patch.starred } : {}),
					...(patch.unread_count !== undefined ? { unread_count: patch.unread_count } : {}),
				});
			}
		}
		this.#removed = removed;
		this.#patches = patches;
	}

	#clearOverlay(ids: string[]): void {
		const removed = new Set(this.#removed);
		const patches = new Map(this.#patches);
		for (const id of ids) {
			removed.delete(id);
			patches.delete(id);
		}
		this.#removed = removed;
		this.#patches = patches;
	}

	#pushUndo(entry: UndoEntry): void {
		this.#undoStack.push(entry);
		if (this.#undoStack.length > 20) this.#undoStack.shift();
	}

	async #post(ids: string[], action: string, opts: { folder?: string; label_id?: string }): Promise<void> {
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
 * can't be locally restored, so it never enters the undo stack (§10.2).
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
export function provideActions(fetchFn?: typeof globalThis.fetch): ActionManager {
	const mgr = new ActionManager(fetchFn);
	setContext(KEY, mgr);
	return mgr;
}
export function useActions(): ActionManager {
	return getContext<ActionManager>(KEY);
}
