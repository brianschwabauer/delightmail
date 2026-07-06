<script lang="ts">
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { onMount, setContext } from 'svelte';
	import { toast } from '@delightstack/components';
	import FolderRail from '$lib/components/FolderRail.svelte';
	import StatusBar from '$lib/components/StatusBar.svelte';
	import PasskeyPrompt from '$lib/components/PasskeyPrompt.svelte';
	import KeyboardHelp from '$lib/components/KeyboardHelp.svelte';
	import ChordHint from '$lib/components/ChordHint.svelte';
	import CommandPalette from '$lib/components/CommandPalette.svelte';
	import { provideKeyboard } from '$lib/keyboard/keyboard.svelte';
	import { provideActions } from '$lib/mail/actions-client.svelte';

	const { data, children } = $props();
	const { auth, db, ws } = $derived(data);

	const view = $derived(page.params.view ?? 'inbox');

	const kb = provideKeyboard();
	const actions = provideActions();
	let helpOpen = $state(false);
	let paletteOpen = $state(false);
	setContext('mail:compose', { open: () => toast('Compose lands in P3.') });

	onMount(() => {
		const onKey = (e: KeyboardEvent) => {
			if (helpOpen && e.key === 'Escape') {
				helpOpen = false;
				e.preventDefault();
				return;
			}
			kb.handle(e);
		};
		window.addEventListener('keydown', onKey);

		const off = kb.registerAll([
			{ keys: '?', description: 'Keyboard help', group: 'Global', context: 'global', handler: () => (helpOpen = !helpOpen) },
			{ keys: 'Ctrl+k', description: 'Command palette', group: 'Global', context: 'global', global: true, handler: () => (paletteOpen = true) },
			{ keys: 'z', description: 'Undo last action', group: 'Global', context: 'global', handler: () => actions.undo() },
			{ keys: 'n', description: 'Compose', group: 'Global', context: 'global', handler: () => toast('Compose lands in P3.') },
			{ keys: 'c', description: 'Compose', group: 'Global', context: 'global', handler: () => toast('Compose lands in P3.') },
			{ keys: 'g i', description: 'Go to Inbox', group: 'Go to', context: 'global', handler: () => goto('/mail/inbox') },
			{ keys: 'g f', description: 'Go to AI Filtered', group: 'Go to', context: 'global', handler: () => goto('/mail/filtered') },
			{ keys: 'g s', description: 'Go to Starred', group: 'Go to', context: 'global', handler: () => goto('/mail/starred') },
			{ keys: 'g t', description: 'Go to Sent', group: 'Go to', context: 'global', handler: () => goto('/mail/sent') },
			{ keys: 'g d', description: 'Go to Drafts', group: 'Go to', context: 'global', handler: () => goto('/mail/drafts') },
			{ keys: 'g a', description: 'Go to Archive', group: 'Go to', context: 'global', handler: () => goto('/mail/archive') },
		]);

		return () => {
			window.removeEventListener('keydown', onKey);
			off();
		};
	});
</script>

<div class="app">
	<FolderRail {db} {view} {auth} />
	<main class="content">
		{@render children()}
	</main>
</div>
<StatusBar {auth} {ws} />
<PasskeyPrompt {auth} />
<ChordHint {kb} />
<KeyboardHelp {kb} open={helpOpen} onClose={() => (helpOpen = false)} />
<CommandPalette {db} open={paletteOpen} onClose={() => (paletteOpen = false)} />

<style>
	.app {
		display: grid;
		grid-template-columns: 220px minmax(0, 1fr);
		height: calc(100dvh - 28px);
	}
	.content {
		min-width: 0;
		min-height: 0;
		overflow: hidden;
		display: flex;
	}
	@media (max-width: 767px) {
		.app {
			grid-template-columns: 1fr;
		}
	}
</style>
