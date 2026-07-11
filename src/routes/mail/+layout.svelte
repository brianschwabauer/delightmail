<script lang="ts">
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { onMount, setContext, untrack } from 'svelte';
	import { toast } from '@delightstack/components';
	import Icon from '$lib/components/Icon.svelte';
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
	const actions = provideActions(data.db);
	const scope = provideScope();
	const focus = provideFocus();
	let helpOpen = $state(false);
	let paletteOpen = $state(false);
	let composeInit = $state<ComposeInit | null>(null);

	// Mobile: the folder rail lives in a slide-in drawer (opened by the list
	// header's ☰). On desktop the drawer state is inert — the rail is a fixed column.
	let drawerOpen = $state(false);
	setContext('mail:drawer', { open: () => (drawerOpen = true) });
	// Close on any pick: folder navigation or account-scope change. (The rail's
	// onNavigate callback can't cover the folder links — delightstack's href
	// ListItems don't forward onclick — so watch the outcomes instead.)
	$effect(() => {
		void view;
		void scope.current;
		untrack(() => (drawerOpen = false));
	});

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
			// The mobile folder drawer closes on Escape before anything beneath it.
			if (drawerOpen && e.key === 'Escape') {
				drawerOpen = false;
				e.preventDefault();
				return;
			}
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
	<div class="rail-host" class:open={drawerOpen}>
		<!-- svelte-ignore a11y_click_events_have_key_events -->
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div class="drawer-backdrop" onclick={() => (drawerOpen = false)}></div>
		<FolderRail {db} {view} {auth} onNavigate={() => (drawerOpen = false)} />
	</div>
	<main class="content">
		{@render children()}
	</main>
</div>
<button class="fab" onclick={() => openCompose()} aria-label="Compose">
	<Icon name="pencil" size={22} />
</button>
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
	/* Desktop: the host is invisible — the rail participates in the grid directly. */
	.rail-host {
		display: contents;
	}
	.drawer-backdrop {
		display: none;
	}
	.content {
		min-width: 0;
		min-height: 0;
		overflow: hidden;
		display: flex;
	}
	/* Compose FAB — the touch entry point for `n`/`c`. Desktop keeps the keyboard. */
	.fab {
		display: none;
	}
	@media (max-width: 767px) {
		.app {
			grid-template-columns: 1fr;
			/* The status bar is hidden on mobile — reclaim its 28px. */
			height: 100dvh;
		}
		/* The rail becomes a left drawer: fixed, off-canvas, slid in by .open.
		   `visibility` keeps it out of the tab order while closed but still lets
		   the transform transition play both ways. */
		.rail-host {
			display: block;
			position: fixed;
			inset: 0;
			z-index: 400;
			visibility: hidden;
			transition: visibility 0s 200ms;
		}
		.rail-host.open {
			visibility: visible;
			transition: visibility 0s;
		}
		.drawer-backdrop {
			display: block;
			position: absolute;
			inset: 0;
			background: color-mix(in oklab, black 40%, transparent);
			opacity: 0;
			transition: opacity 200ms var(--ease-out, ease);
		}
		.rail-host.open .drawer-backdrop {
			opacity: 1;
		}
		.rail-host :global(.rail) {
			position: absolute;
			inset: 0 auto 0 0;
			width: min(80vw, 300px);
			border-right: none;
			box-shadow: var(--shadow-4, 0 8px 32px rgba(0, 0, 0, 0.35));
			padding-top: calc(var(--space-2) + env(safe-area-inset-top));
			padding-bottom: calc(var(--space-2) + env(safe-area-inset-bottom));
			padding-left: calc(var(--space-2) + env(safe-area-inset-left));
			transform: translateX(-100%);
			transition: transform 200ms var(--ease-out, ease);
		}
		.rail-host.open :global(.rail) {
			transform: translateX(0);
		}
		.fab {
			display: grid;
			place-items: center;
			position: fixed;
			right: calc(var(--space-4) + env(safe-area-inset-right));
			bottom: calc(var(--space-4) + env(safe-area-inset-bottom));
			z-index: 90;
			width: 56px;
			height: 56px;
			border: none;
			border-radius: var(--radius-lg, 16px);
			background: var(--color-primary);
			color: var(--color-primary-contrast, #fff);
			box-shadow: var(--shadow-3, 0 4px 16px rgba(0, 0, 0, 0.3));
			cursor: pointer;
		}
		.fab:active {
			transform: scale(0.94);
		}
	}
</style>
