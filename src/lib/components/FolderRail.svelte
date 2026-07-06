<script lang="ts">
	import type { AuthClient } from '@delightstack/auth/client';
	import type { MailDatabaseClient } from '$lib/clients';
	import { goto } from '$app/navigation';

	interface Props {
		db: MailDatabaseClient;
		view: string;
		auth: AuthClient;
	}
	const { db, view, auth }: Props = $props();

	const FOLDERS = [
		{ id: 'inbox', label: 'Inbox' },
		{ id: 'filtered', label: 'AI Filtered' },
		{ id: 'starred', label: 'Starred' },
		{ id: 'sent', label: 'Sent' },
		{ id: 'drafts', label: 'Drafts' },
		{ id: 'archive', label: 'Archive' },
		{ id: 'spam', label: 'Spam' },
		{ id: 'trash', label: 'Trash' },
	];

	// Live account list drives the per-account scope switcher (§10.1).
	const accounts = db.search('account', { limit: 20 });

	// Unread inbox count (live). Kept cheap — a where-filtered search.
	const inboxUnread = db.search('thread', {
		where: { folder: { eq: 'inbox' } },
		limit: 200,
	});
	const unreadCount = $derived(
		inboxUnread.docs.reduce((n, t) => n + (t.unread_count > 0 ? 1 : 0), 0),
	);
</script>

<nav class="rail" aria-label="Folders">
	<div class="brand">Mail</div>
	<ul class="folders">
		{#each FOLDERS as f (f.id)}
			<li>
				<a
					href="/mail/{f.id}"
					class="item"
					class:active={view === f.id}
					aria-current={view === f.id ? 'page' : undefined}>
					<span>{f.label}</span>
					{#if f.id === 'inbox' && unreadCount > 0}
						<span class="count">{unreadCount}</span>
					{/if}
				</a>
			</li>
		{/each}
	</ul>

	<div class="section">Accounts</div>
	<ul class="folders">
		<li>
			<a href="/mail/inbox" class="item" class:active={view === 'inbox'}>
				<span>All</span>
			</a>
		</li>
		{#each accounts.docs as a (a.id)}
			<li>
				<div class="item static">
					<span class="dot" style:background={a.color || 'var(--color-primary)'}></span>
					<span class="acct">{a.display_name || a.email}</span>
				</div>
			</li>
		{/each}
	</ul>

	<div class="spacer"></div>
	<a href="/settings/accounts" class="item settings">Settings</a>
	<button
		class="item settings"
		onclick={() => auth.signOut().then(() => (window.location.href = '/signin'))}>
		Sign out
	</button>
</nav>

<style>
	.rail {
		display: flex;
		flex-direction: column;
		gap: 2px;
		padding: var(--size-2) var(--size-2);
		background: var(--color-bg-2);
		border-right: 1px solid var(--color-outline);
		overflow-y: auto;
	}
	.brand {
		font-weight: 800;
		letter-spacing: -0.02em;
		padding: var(--size-2) var(--size-2) var(--size-3);
		font-size: var(--font-size-2);
	}
	.folders {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.item {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--size-2);
		padding: 5px var(--size-2);
		border-radius: var(--radius-2);
		color: var(--color-text);
		text-decoration: none;
		font-size: var(--font-size-0);
		width: 100%;
		background: none;
		border: none;
		cursor: pointer;
		text-align: left;
	}
	.item:hover {
		background: var(--color-bg-3, var(--color-bg-1));
	}
	.item.active {
		background: var(--color-primary);
		color: white;
		font-weight: 600;
	}
	.item.static {
		cursor: default;
	}
	.count {
		font-variant-numeric: tabular-nums;
		font-size: var(--font-size-00, 0.72rem);
		opacity: 0.9;
	}
	.section {
		margin-top: var(--size-3);
		padding: 0 var(--size-2);
		font-size: var(--font-size-00, 0.7rem);
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--color-text-disabled);
	}
	.dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		flex-shrink: 0;
	}
	.acct {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.spacer {
		flex: 1;
	}
	.settings {
		color: var(--color-text-disabled);
	}
</style>
