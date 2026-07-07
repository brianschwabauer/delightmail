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
	import Compose from '$lib/components/Compose.svelte';
	import type { ComposeInit } from '$lib/components/Compose.svelte';
	import { provideKeyboard } from '$lib/keyboard/keyboard.svelte';
	import { provideActions } from '$lib/mail/actions-client.svelte';
	import { provideScope } from '$lib/mail/scope.svelte';
	import { provideFocus } from '$lib/mail/focus.svelte';

	const { data, children } = $props();
	const { auth, db, ws } = $derived(data);

	const view = $derived(page.params.view ?? 'inbox');

	const kb = provideKeyboard();
	const actions = provideActions();
	const scope = provideScope();
	const focus = provideFocus();
	let helpOpen = $state(false);
	let paletteOpen = $state(false);
	let composeInit = $state<ComposeInit | null>(null);

	// While any modal overlay is up it owns the keyboard: its own focused DOM
	// handlers run, and the global binding engine is held back so list/global
	// shortcuts (e.g. the list's Escape, Ctrl+K, scope keys) can't leak beneath it.
	const overlayOpen = $derived(helpOpen || paletteOpen || composeInit != null);

	function openCompose(init: ComposeInit = {}) {
		composeInit = init;
	}
	setContext('mail:compose', { open: openCompose });

	// mailto: / share-target land on /compose which redirects here with ?compose=1
	// (+ to/subject/body). Open the overlay and strip the params from the URL.
	function composeFromUrl() {
		const p = page.url.searchParams;
		if (p.get('compose') !== '1') return;
		const to = p.get('to');
		const cc = p.get('cc');
		openCompose({
			to: to ? to.split(/[,;]/).map((e) => ({ email: e.trim() })).filter((a) => a.email) : undefined,
			cc: cc ? cc.split(/[,;]/).map((e) => ({ email: e.trim() })).filter((a) => a.email) : undefined,
			subject: p.get('subject') ?? undefined,
		});
		const url = new URL(location.href);
		for (const k of ['compose', 'to', 'cc', 'subject', 'body']) url.searchParams.delete(k);
		history.replaceState(history.state, '', url);
	}

	// Apply user key overrides (settings.keyboard_overrides) once settings load.
	async function applyKeyboardOverrides() {
		try {
			const e = db.entity('settings', 'main');
			await e.load();
			const raw = (e.loaded ? (e.value as { keyboard_overrides?: string }).keyboard_overrides : '') ?? '';
			if (raw) kb.setOverrides(JSON.parse(raw) as Record<string, string>);
		} catch {
			/* keep defaults */
		}
	}

	onMount(() => {
		composeFromUrl();
		void applyKeyboardOverrides();
		const onKey = (e: KeyboardEvent) => {
			// Help closes on Esc; every other key is swallowed while it's open.
			if (helpOpen) {
				if (e.key === 'Escape') {
					helpOpen = false;
					e.preventDefault();
				}
				return;
			}
			// Compose / palette own the keyboard via their own focused handlers.
			if (paletteOpen || composeInit) return;
			kb.handle(e);
		};
		window.addEventListener('keydown', onKey);

		const free = () => !overlayOpen;
		const off = kb.registerAll([
			{ keys: '?', description: 'Keyboard help', group: 'Global', context: 'global', when: free, handler: () => (helpOpen = !helpOpen) },
			// Ctrl/Cmd+K is owned by the delightstack CommandPalette itself (it binds
			// a global listener and toggles `paletteOpen`); we only list it for the help
			// overlay + command palette registry — no handler, so it can't double-fire.
			{ keys: 'Ctrl+k', description: 'Command palette', group: 'Global', context: 'global', when: () => false, handler: () => {} },
			{ keys: 'z', description: 'Undo last action', group: 'Global', context: 'global', when: free, handler: () => actions.undo() },
			{ keys: 'n', description: 'Compose', group: 'Global', context: 'global', when: free, handler: () => openCompose() },
			{ keys: 'c', description: 'Compose', group: 'Global', context: 'global', when: free, handler: () => openCompose() },
			{ keys: 'g i', description: 'Go to Inbox', group: 'Go to', context: 'global', when: free, handler: () => goto('/mail/inbox') },
			{ keys: 'g f', description: 'Go to AI Filtered', group: 'Go to', context: 'global', when: free, handler: () => goto('/mail/filtered') },
			{ keys: 'g s', description: 'Go to Starred', group: 'Go to', context: 'global', when: free, handler: () => goto('/mail/starred') },
			{ keys: 'g t', description: 'Go to Sent', group: 'Go to', context: 'global', when: free, handler: () => goto('/mail/sent') },
			{ keys: 'g d', description: 'Go to Drafts', group: 'Go to', context: 'global', when: free, handler: () => goto('/mail/drafts') },
			{ keys: 'g a', description: 'Go to Archive', group: 'Go to', context: 'global', when: free, handler: () => goto('/mail/archive') },
			// Account scope: Ctrl+1 = All, Ctrl+2..9 = accounts in order (§10.1).
			...Array.from({ length: 9 }, (_, i) => ({
				keys: `Ctrl+${i + 1}`,
				description: i === 0 ? 'Scope: all accounts' : `Scope: account ${i}`,
				group: 'Scope',
				context: 'global',
				global: true,
				when: free,
				handler: () => scope.setByIndex(i),
			})),
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
<CommandPalette bind:open={paletteOpen} />
{#if composeInit}
	<Compose {db} init={composeInit} onClose={() => (composeInit = null)} />
{/if}

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
