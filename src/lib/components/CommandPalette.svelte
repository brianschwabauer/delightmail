<script lang="ts">
	import { goto } from '$app/navigation';
	import { CommandPalette as DSCommandPalette } from '@delightstack/components';
	import type { CommandOption } from '@delightstack/components';
	import { useKeyboard } from '$lib/keyboard/keyboard.svelte';

	const kb = useKeyboard();

	interface Props {
		/** Two-way bound so the palette's own Ctrl/Cmd+K toggle stays in sync with
		 *  the layout's overlay gating. */
		open?: boolean;
	}
	let { open = $bindable(false) }: Props = $props();

	// The palette is the discoverability layer for the keyboard: every actionable
	// binding (archive, snooze, go-to folder, search, undo…) is listed straight
	// from the live registry — new bindings appear here for free, user key
	// overrides included. Pure-motion groups (j/k, pane hops, selection sweeps)
	// stay out; they make no sense as one-shot commands.
	const ACTION_GROUPS: Record<string, string> = {
		Actions: 'Actions',
		'Go to': 'Navigate',
		Global: 'Actions',
		Find: 'Find',
		Scope: 'Scope',
	};
	const EXCLUDE_KEYS = new Set(['Ctrl+k', 'Escape']);

	const SETTINGS: CommandOption[] = [
		{ id: 'settings-accounts', title: 'Settings: Accounts', category: 'Settings', onselect: () => goto('/settings/accounts') },
		{ id: 'settings-identities', title: 'Settings: Identities & signatures', category: 'Settings', onselect: () => goto('/settings/identities') },
		{ id: 'settings-ai', title: 'Settings: AI Triage', category: 'Settings', onselect: () => goto('/settings/ai') },
		{ id: 'settings-appearance', title: 'Settings: Appearance', category: 'Settings', onselect: () => goto('/settings/appearance') },
		{ id: 'settings-keyboard', title: 'Settings: Keyboard', category: 'Settings', onselect: () => goto('/settings/keyboard') },
		{ id: 'settings-subscriptions', title: 'Settings: Subscriptions', category: 'Settings', onselect: () => goto('/settings/subscriptions') },
		{ id: 'settings-rules', title: 'Settings: Rules', category: 'Settings', onselect: () => goto('/settings/rules') },
	];

	const commands = $derived.by((): CommandOption[] => {
		if (!open) return SETTINGS;
		const seen = new Set<string>();
		const dynamic: CommandOption[] = [];
		for (const b of kb.activeBindings()) {
			const category = ACTION_GROUPS[b.group];
			if (!category || EXCLUDE_KEYS.has(b.keys)) continue;
			const dedupe = `${b.group}:${b.description}`;
			if (seen.has(dedupe)) continue; // n and c are both Compose — list once
			seen.add(dedupe);
			dynamic.push({
				id: `kb:${b.keys}`,
				title: b.description,
				category,
				shortcut: b.keys.split(' '),
				onselect: () => {
					// Close first so the layout's overlay gating releases the keyboard,
					// then run the binding's handler exactly as the key would have.
					open = false;
					setTimeout(() => b.handler(new KeyboardEvent('keydown', { key: '' })), 0);
				},
			});
		}
		return [...dynamic, ...SETTINGS];
	});
</script>

<DSCommandPalette bind:open {commands} placeholder="Type a command…" />
