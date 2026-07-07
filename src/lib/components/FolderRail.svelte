<script lang="ts">
	import type { AuthClient } from '@delightstack/auth/client';
	import type { MailDatabaseClient } from '$lib/clients';
	import { useScope } from '$lib/mail/scope.svelte';

	interface Props {
		db: MailDatabaseClient;
		view: string;
		auth: AuthClient;
	}
	const { db, view, auth }: Props = $props();

	const scope = useScope();

	/** Sign out, first telling the service worker to drop this device's cached
	 *  private mail so it can't be served to the next user who signs in (§H5). */
	async function signOut() {
		try {
			const reg = await navigator.serviceWorker?.ready;
			reg?.active?.postMessage({ type: 'clear-caches' });
		} catch {
			/* SW not controlling this page — nothing cached to clear */
		}
		await auth.signOut();
		window.location.href = '/signin';
	}

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

	// Feed the live account list into the scope switcher so Ctrl+1..9 maps to them.
	$effect(() => {
		scope.accounts = accounts.docs.map((a) => ({
			id: String(a.id),
			label: (a.display_name || a.email) as string,
			color: a.color as string | undefined,
		}));
	});
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
			<button class="item" class:active={scope.current === 'all'} onclick={() => scope.set('all')}>
				<span>All</span>
			</button>
		</li>
		{#each scope.accounts as a (a.id)}
			<li>
				<button
					class="item"
					class:active={scope.current === a.id}
					onclick={() => scope.set(a.id)}
					title="Scope to {a.label}">
					<span class="dot" style:background={a.color || 'var(--color-primary)'}></span>
					<span class="acct">{a.label}</span>
				</button>
			</li>
		{/each}
	</ul>

	<div class="spacer"></div>
	<a href="/settings/accounts" class="item settings">Settings</a>
	<button class="item settings" onclick={signOut}> Sign out </button>
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
