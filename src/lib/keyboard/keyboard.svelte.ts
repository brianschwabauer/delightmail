/**
 * Keyboard engine (§10.2). A single manager owns all bindings: a context stack
 * (global → pane → overlay), chord support with a 1.2s timeout + on-screen hint,
 * and a registry that feeds both the `?` help overlay and the command palette.
 *
 * Rules:
 * - Bindings never fire while an input/editor has focus, except Esc and bindings
 *   explicitly marked `global`.
 * - The most recently pushed context wins; a binding in a higher context shadows
 *   the same key in a lower one.
 */
import { getContext, setContext } from 'svelte';

export interface Binding {
	/** e.g. 'a', 'Ctrl+k', 'Shift+j', 'g i' (chord). */
	keys: string;
	description: string;
	group: string;
	context: string;
	handler: (event: KeyboardEvent) => void;
	/** When false, the binding is skipped (still listed in help). */
	when?: () => boolean;
	/** Fire even while an input/editor is focused. */
	global?: boolean;
	/** The originally-registered key, before any user override (set internally). */
	defaultKeys?: string;
}

const CHORD_TIMEOUT = 1200;

export class Keyboard {
	#bindings = new Set<Binding>();
	#overrides: Record<string, string> = {};
	contextStack = $state<string[]>(['global']);
	pendingChord = $state<string | null>(null);
	#chordTimer: ReturnType<typeof setTimeout> | null = null;

	/** Register a binding; returns an unregister function. */
	register(binding: Binding): () => void {
		binding.defaultKeys = binding.keys;
		const override = this.#overrides[binding.keys];
		if (override) binding.keys = override;
		this.#bindings.add(binding);
		return () => this.#bindings.delete(binding);
	}

	/**
	 * Apply user key overrides (settings.keyboard_overrides), a map of
	 * default-key → replacement-key. Retroactively re-keys already-registered
	 * bindings so it can be called after the mail view has mounted (§10.2).
	 */
	setOverrides(map: Record<string, string>): void {
		this.#overrides = map ?? {};
		for (const b of this.#bindings) {
			const def = b.defaultKeys ?? b.keys;
			b.keys = this.#overrides[def] ?? def;
		}
	}

	registerAll(bindings: Binding[]): () => void {
		const offs = bindings.map((b) => this.register(b));
		return () => offs.forEach((o) => o());
	}

	pushContext(name: string): void {
		this.contextStack = [...this.contextStack, name];
	}

	popContext(name: string): void {
		const i = this.contextStack.lastIndexOf(name);
		if (i > 0) this.contextStack = this.contextStack.filter((_, idx) => idx !== i);
	}

	/** All active bindings, most-specific context first (for the help overlay). */
	activeBindings(): Binding[] {
		const order = [...this.contextStack].reverse();
		return [...this.#bindings]
			.filter((b) => this.contextStack.includes(b.context))
			.sort((a, b) => order.indexOf(a.context) - order.indexOf(b.context));
	}

	handle(event: KeyboardEvent): void {
		const token = tokenize(event);
		if (!token) return;

		const editing = isEditingTarget(event.target);
		// While editing, only Escape and explicitly-global chords are allowed.
		if (editing && token !== 'Escape') {
			const globalMatch = this.#findBinding(this.pendingChord ? `${this.pendingChord} ${token}` : token, true);
			if (!globalMatch) return;
		}

		// Resolve a pending chord.
		if (this.pendingChord) {
			const combined = `${this.pendingChord} ${token}`;
			this.#clearChord();
			const match = this.#findBinding(combined, editing);
			if (match) {
				event.preventDefault();
				match.handler(event);
			}
			return;
		}

		// Is this token a chord prefix?
		if (this.#isChordPrefix(token)) {
			event.preventDefault();
			this.pendingChord = token;
			this.#chordTimer = setTimeout(() => this.#clearChord(), CHORD_TIMEOUT);
			return;
		}

		const match = this.#findBinding(token, editing);
		if (match) {
			event.preventDefault();
			match.handler(event);
		}
	}

	#findBinding(keys: string, requireGlobal: boolean): Binding | undefined {
		const order = [...this.contextStack].reverse();
		const candidates = [...this.#bindings]
			.filter((b) => b.keys === keys && this.contextStack.includes(b.context))
			.filter((b) => (requireGlobal ? b.global : true))
			.filter((b) => (b.when ? b.when() : true))
			.sort((a, b) => order.indexOf(a.context) - order.indexOf(b.context));
		return candidates[0];
	}

	#isChordPrefix(token: string): boolean {
		for (const b of this.#bindings) {
			if (!this.contextStack.includes(b.context)) continue;
			if (b.keys.startsWith(`${token} `)) return true;
		}
		return false;
	}

	#clearChord(): void {
		this.pendingChord = null;
		if (this.#chordTimer) {
			clearTimeout(this.#chordTimer);
			this.#chordTimer = null;
		}
	}

	/** Chord options shown in the on-screen hint (yazi-style). */
	chordOptions(): Array<{ key: string; description: string }> {
		if (!this.pendingChord) return [];
		const prefix = `${this.pendingChord} `;
		return [...this.#bindings]
			.filter((b) => this.contextStack.includes(b.context) && b.keys.startsWith(prefix))
			.map((b) => ({ key: b.keys.slice(prefix.length), description: b.description }));
	}
}

const KEY = Symbol('keyboard');
export function provideKeyboard(): Keyboard {
	const kb = new Keyboard();
	setContext(KEY, kb);
	return kb;
}
export function useKeyboard(): Keyboard {
	return getContext<Keyboard>(KEY);
}

/** Normalize a KeyboardEvent to a binding token (e.g. 'Ctrl+k', 'Shift+j', 'g'). */
export function tokenize(event: KeyboardEvent): string | null {
	const key = event.key;
	if (key === 'Control' || key === 'Shift' || key === 'Alt' || key === 'Meta') return null;

	const mods: string[] = [];
	if (event.ctrlKey || event.metaKey) mods.push('Ctrl');
	if (event.altKey) mods.push('Alt');

	// Single printable keys keep their case; Shift is implied by an uppercase key
	// or an explicit Shift+ for non-letters (arrows etc.).
	let base = key;
	if (key === ' ') base = 'Space';
	if (key.length === 1) {
		if (mods.length) base = key.toLowerCase();
	} else if (event.shiftKey && !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(key)) {
		mods.push('Shift');
	}
	return mods.length ? `${mods.join('+')}+${base}` : base;
}

function isEditingTarget(target: EventTarget | null): boolean {
	const el = target as HTMLElement | null;
	if (!el) return false;
	const tag = el.tagName;
	return (
		tag === 'INPUT' ||
		tag === 'TEXTAREA' ||
		tag === 'SELECT' ||
		el.isContentEditable === true
	);
}
