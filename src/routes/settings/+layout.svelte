<script lang="ts">
	import { page } from '$app/state';
	import { List, ListItem } from '@delightstack/components';

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
		<List type="button" dense class="settings-nav">
			{#each TABS as t (t.id)}
				<ListItem href="/settings/{t.id}" active={current === t.id}>{t.label}</ListItem>
			{/each}
		</List>
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
		padding: var(--space-4);
		border-right: 1px solid var(--color-border);
		background: var(--color-bg-2);
	}
	.back {
		display: inline-block;
		font-size: var(--font-size-0);
		color: var(--color-text-disabled);
		text-decoration: none;
	}
	.back:hover {
		color: var(--color-text);
	}
	h1 {
		font-size: var(--font-size-3);
		font-weight: var(--font-weight-semibold, 600);
		letter-spacing: -0.01em;
		margin: var(--space-3) 0 var(--space-4);
	}
	:global(.settings-nav) {
		font-size: var(--font-size-0);
	}
	:global(.settings-nav .list-item) {
		min-height: 0;
	}
	:global(.settings-nav .list-item > a) {
		padding: 7px var(--space-3);
		border-radius: var(--radius-md);
		color: var(--color-text-muted, var(--color-text));
	}
	:global(.settings-nav .list-item.active > a) {
		background: var(--dm-accent-soft);
		color: var(--color-text);
		font-weight: var(--font-weight-semibold, 600);
		box-shadow: inset 2px 0 0 var(--color-primary);
	}
	main {
		padding: var(--space-6) var(--space-8);
		max-width: 760px;
	}
</style>
