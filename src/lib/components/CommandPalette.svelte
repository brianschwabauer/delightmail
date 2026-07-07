<script lang="ts">
	import { getContext } from 'svelte';
	import { goto } from '$app/navigation';
	import { CommandPalette as DSCommandPalette } from '@delightstack/components';
	import type { CommandOption } from '@delightstack/components';
	import type { ComposeInit } from './Compose.svelte';

	const compose = getContext<{ open: (init?: ComposeInit) => void }>('mail:compose');

	interface Props {
		/** Two-way bound so the palette's own Ctrl/Cmd+K toggle stays in sync with
		 *  the layout's overlay gating. */
		open?: boolean;
	}
	let { open = $bindable(false) }: Props = $props();

	const commands: CommandOption[] = [
		{ id: 'inbox', title: 'Go to Inbox', category: 'Navigate', shortcut: ['g', 'i'], onselect: () => goto('/mail/inbox') },
		{ id: 'filtered', title: 'Go to AI Filtered', category: 'Navigate', shortcut: ['g', 'f'], onselect: () => goto('/mail/filtered') },
		{ id: 'starred', title: 'Go to Starred', category: 'Navigate', shortcut: ['g', 's'], onselect: () => goto('/mail/starred') },
		{ id: 'sent', title: 'Go to Sent', category: 'Navigate', shortcut: ['g', 't'], onselect: () => goto('/mail/sent') },
		{ id: 'drafts', title: 'Go to Drafts', category: 'Navigate', shortcut: ['g', 'd'], onselect: () => goto('/mail/drafts') },
		{ id: 'archive', title: 'Go to Archive', category: 'Navigate', shortcut: ['g', 'a'], onselect: () => goto('/mail/archive') },
		{ id: 'spam', title: 'Go to Spam', category: 'Navigate', onselect: () => goto('/mail/spam') },
		{ id: 'trash', title: 'Go to Trash', category: 'Navigate', onselect: () => goto('/mail/trash') },
		{ id: 'compose', title: 'Compose new message', category: 'Actions', shortcut: ['n'], keywords: ['new', 'write', 'email'], onselect: () => compose.open() },
		{ id: 'settings-accounts', title: 'Settings: Accounts', category: 'Settings', onselect: () => goto('/settings/accounts') },
		{ id: 'settings-ai', title: 'Settings: AI Triage', category: 'Settings', onselect: () => goto('/settings/ai') },
		{ id: 'settings-appearance', title: 'Settings: Appearance', category: 'Settings', onselect: () => goto('/settings/appearance') },
		{ id: 'settings-keyboard', title: 'Settings: Keyboard', category: 'Settings', onselect: () => goto('/settings/keyboard') },
		{ id: 'settings-subscriptions', title: 'Settings: Subscriptions', category: 'Settings', onselect: () => goto('/settings/subscriptions') },
		{ id: 'settings-rules', title: 'Settings: Rules', category: 'Settings', onselect: () => goto('/settings/rules') },
	];
</script>

<DSCommandPalette bind:open {commands} placeholder="Type a command…" />
