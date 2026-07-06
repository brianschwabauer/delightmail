<script lang="ts">
	import { page } from '$app/state';

	const { children } = $props();

	const TABS = [
		{ id: 'accounts', label: 'Accounts' },
		{ id: 'identities', label: 'Identities' },
		{ id: 'ai', label: 'AI Triage' },
		{ id: 'subscriptions', label: 'Subscriptions' },
		{ id: 'rules', label: 'Rules' },
		{ id: 'keyboard', label: 'Keyboard' },
		{ id: 'appearance', label: 'Appearance' },
	];
	const current = $derived(page.url.pathname.split('/')[2] ?? 'accounts');
</script>

<div class="settings">
	<aside>
		<a href="/mail/inbox" class="back">← Back to mail</a>
		<h1>Settings</h1>
		<nav>
			{#each TABS as t (t.id)}
				<a href="/settings/{t.id}" class:active={current === t.id}>{t.label}</a>
			{/each}
		</nav>
	</aside>
	<main>{@render children()}</main>
</div>

<style>
	.settings {
		display: grid;
		grid-template-columns: 220px minmax(0, 1fr);
		min-height: 100dvh;
	}
	aside {
		padding: var(--size-4);
		border-right: 1px solid var(--color-outline);
		background: var(--color-bg-2);
	}
	.back {
		font-size: var(--font-size-0);
		color: var(--color-text-disabled);
		text-decoration: none;
	}
	h1 {
		font-size: var(--font-size-3);
		margin: var(--size-3) 0;
	}
	nav {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	nav a {
		padding: 6px var(--size-2);
		border-radius: var(--radius-2);
		color: var(--color-text);
		text-decoration: none;
		font-size: var(--font-size-0);
	}
	nav a.active {
		background: var(--color-primary);
		color: white;
	}
	main {
		padding: var(--size-5);
		max-width: 720px;
	}
</style>
