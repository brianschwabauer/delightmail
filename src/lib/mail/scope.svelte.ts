/**
 * Account scope switcher: a persistent All / per-account filter applied
 * client-side across every view. `Ctrl+1..9` switches scope (1 = All), and the
 * folder rail's account rows set it. It's a shared reactive singleton provided
 * via context, like the keyboard/action managers.
 */
import { getContext, setContext } from 'svelte';

export interface ScopeAccount {
	id: string;
	label: string;
	color?: string;
}

export class ScopeState {
	/** 'all' or an account id. */
	current = $state<'all' | string>('all');
	/** Populated by the folder rail from the live account list (drives Ctrl+1..9). */
	accounts = $state<ScopeAccount[]>([]);
	/** Every address the user owns — lets a thread row list the *other* people. */
	selfEmails = $state<string[]>([]);
	/** Domains the user owns; every address at them is theirs (catch-all aliases). */
	selfDomains = $state<string[]>([]);

	set(scope: 'all' | string): void {
		this.current = scope;
	}

	/** Ctrl+1 → All, Ctrl+2 → first account, … (index is 0-based: 0 = All). */
	setByIndex(index: number): void {
		if (index <= 0) {
			this.current = 'all';
			return;
		}
		const account = this.accounts[index - 1];
		if (account) this.current = account.id;
	}

	/** True when a thread (by its contributing account ids) is in scope. */
	includes(account_ids: string[] | undefined): boolean {
		if (this.current === 'all') return true;
		return !!account_ids?.includes(this.current);
	}
}

const KEY = Symbol('mail:scope');
export function provideScope(): ScopeState {
	const s = new ScopeState();
	setContext(KEY, s);
	return s;
}
export function useScope(): ScopeState {
	return getContext<ScopeState>(KEY);
}
