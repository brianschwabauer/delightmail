/**
 * Pane focus (§10.2, yazi-style navigation). Tracks which of the three panes —
 * folders (parent) → list (current) → reading (child/preview) — currently owns
 * the keyboard. `h`/`←` moves toward the parent, `l`/`→` toward the child, and
 * `j/k/↑/↓` act inside the focused pane. It's a shared reactive singleton
 * provided via context, like the keyboard/scope managers.
 *
 * The store stays deliberately dumb: it only holds the focused pane. Each pane's
 * own component owns its left/right transitions (so side effects like "open the
 * thread when moving into the reader" live next to the state they touch).
 */
import { getContext, setContext } from 'svelte';

export type Pane = 'folders' | 'list' | 'reading';

export class PaneFocus {
	pane = $state<Pane>('list');

	set(p: Pane): void {
		this.pane = p;
	}
	is(p: Pane): boolean {
		return this.pane === p;
	}
}

const KEY = Symbol('mail:focus');
export function provideFocus(): PaneFocus {
	const f = new PaneFocus();
	setContext(KEY, f);
	return f;
}
export function useFocus(): PaneFocus {
	return getContext<PaneFocus>(KEY);
}
