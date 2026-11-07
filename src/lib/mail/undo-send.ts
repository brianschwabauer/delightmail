/**
 * The one send that can still be called back. Compose arms it when a message
 * enters the outbox; the toast's Undo button and the global Ctrl+Z both take
 * it, so whichever the user reaches first wins and the other finds nothing.
 */
let pending: { until: number; undo: () => void } | null = null;

export function armUndoSend(seconds: number, undo: () => void): void {
	pending = { until: Date.now() + seconds * 1000, undo };
}

/** The pending undo, if its window is still open — consumed by the call. */
export function takeUndoSend(): (() => void) | null {
	const p = pending;
	pending = null;
	if (!p || Date.now() >= p.until) return null;
	return p.undo;
}
