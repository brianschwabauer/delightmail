<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { List, ListItem } from '@delightstack/components';
	import type { AuthClient } from '@delightstack/auth/client';
	import type { MailDatabaseClient } from '$lib/clients';
	import { useScope } from '$lib/mail/scope.svelte';
	import { useFocus } from '$lib/mail/focus.svelte';
	import { useKeyboard } from '$lib/keyboard/keyboard.svelte';

	interface Props {
		db: MailDatabaseClient;
		view: string;
		auth: AuthClient;
	}
	const { db, view, auth }: Props = $props();

	const scope = useScope();
	const focus = useFocus();
	const kb = useKeyboard();

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
		{ id: 'inbox', label: 'Inbox', glyph: '📥' },
		{ id: 'filtered', label: 'AI Filtered', glyph: '🧯' },
		{ id: 'starred', label: 'Starred', glyph: '★' },
		{ id: 'sent', label: 'Sent', glyph: '➤' },
		{ id: 'drafts', label: 'Drafts', glyph: '✎' },
		{ id: 'archive', label: 'Archive', glyph: '🗄' },
		{ id: 'spam', label: 'Spam', glyph: '⦸' },
		{ id: 'trash', label: 'Trash', glyph: '🗑' },
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

	// --- keyboard folder navigation (yazi's leftmost / "parent" column) ---
	let hi = $state(0);
	// Entering the folders pane starts the highlight on the current folder.
	$effect(() => {
		if (focus.is('folders')) {
			untrack(() => {
				const i = FOLDERS.findIndex((f) => f.id === view);
				hi = i >= 0 ? i : 0;
			});
		}
	});
	function moveHi(delta: number) {
		hi = Math.min(FOLDERS.length - 1, Math.max(0, hi + delta));
	}
	function openFolder(id: string) {
		void goto(`/mail/${id}`);
		focus.set('list');
	}

	const inFolders = () => focus.is('folders');
	onMount(() => {
		kb.pushContext('folders');
		const off = kb.registerAll([
			{ keys: 'j', description: 'Next folder', group: 'Folders', context: 'folders', when: inFolders, handler: () => moveHi(1) },
			{ keys: 'k', description: 'Previous folder', group: 'Folders', context: 'folders', when: inFolders, handler: () => moveHi(-1) },
			{ keys: 'ArrowDown', description: 'Next folder', group: 'Folders', context: 'folders', when: inFolders, handler: () => moveHi(1) },
			{ keys: 'ArrowUp', description: 'Previous folder', group: 'Folders', context: 'folders', when: inFolders, handler: () => moveHi(-1) },
			{ keys: 'Home', description: 'First folder', group: 'Folders', context: 'folders', when: inFolders, handler: () => (hi = 0) },
			{ keys: 'End', description: 'Last folder', group: 'Folders', context: 'folders', when: inFolders, handler: () => (hi = FOLDERS.length - 1) },
			{ keys: 'l', description: 'Open folder → list', group: 'Folders', context: 'folders', when: inFolders, handler: () => openFolder(FOLDERS[hi].id) },
			{ keys: 'ArrowRight', description: 'Open folder → list', group: 'Folders', context: 'folders', when: inFolders, handler: () => openFolder(FOLDERS[hi].id) },
			{ keys: 'Enter', description: 'Open folder → list', group: 'Folders', context: 'folders', when: inFolders, handler: () => openFolder(FOLDERS[hi].id) },
		]);
		return () => {
			off();
			kb.popContext('folders');
		};
	});
</script>

<nav
	class="rail"
	class:focused={focus.is('folders')}
	aria-label="Folders"
	onmousedowncapture={() => focus.set('folders')}>
	<div class="brand"><span class="brand-mark"></span>Mail</div>

	<List type="button" dense class="rail-list">
		{#each FOLDERS as f, i (f.id)}
			<ListItem
				href="/mail/{f.id}"
				active={view === f.id}
				class={focus.is('folders') && i === hi ? 'khl' : ''}
				onclick={() => focus.set('list')}>
				<span class="glyph" aria-hidden="true">{f.glyph}</span>
				<span class="label">{f.label}</span>
				{#if f.id === 'inbox' && unreadCount > 0}
					<span class="count">{unreadCount}</span>
				{/if}
			</ListItem>
		{/each}
	</List>

	<div class="section">Accounts</div>
	<List type="button" dense class="rail-list">
		<ListItem active={scope.current === 'all'} onclick={() => scope.set('all')}>
			<span class="dot all" aria-hidden="true"></span>
			<span class="label">All accounts</span>
		</ListItem>
		{#each scope.accounts as a (a.id)}
			<ListItem active={scope.current === a.id} onclick={() => scope.set(a.id)}>
				<span class="dot" style:background={a.color || 'var(--color-primary)'}></span>
				<span class="label">{a.label}</span>
			</ListItem>
		{/each}
	</List>

	<div class="spacer"></div>
	<List type="button" dense class="rail-list">
		<ListItem href="/settings/accounts" class="quiet">
			<span class="glyph" aria-hidden="true">⚙</span><span class="label">Settings</span>
		</ListItem>
		<ListItem class="quiet" onclick={signOut}>
			<span class="glyph" aria-hidden="true">⏻</span><span class="label">Sign out</span>
		</ListItem>
	</List>
</nav>

<style>
	.rail {
		position: relative;
		display: flex;
		flex-direction: column;
		gap: 1px;
		padding: var(--space-2);
		background: var(--color-bg-2);
		border-right: 1px solid var(--color-border);
		overflow-y: auto;
	}
	.rail.focused {
		background: var(--dm-focus-tint);
	}
	.rail.focused::before {
		content: '';
		position: absolute;
		inset: 0 0 auto 0;
		height: 2px;
		background: var(--color-primary);
	}
	.brand {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		font-weight: var(--font-weight-bold, 800);
		letter-spacing: -0.02em;
		padding: var(--space-2) var(--space-2) var(--space-3);
		font-size: var(--font-size-2);
	}
	.brand-mark {
		width: 10px;
		height: 10px;
		border-radius: var(--radius-sm);
		background: var(--color-primary);
		box-shadow: 0 0 0 3px var(--dm-accent-soft);
	}
	/* The rail's folder/account/footer lists are delightstack <List>s. Tighten
	   their spacing to the rail and lay each row's content out as an icon + label
	   (+ optional count) row. Children live in this component's scope, so these
	   class rules reach into the ListItem slots; the ListItem chrome (hover,
	   active, ripple) is styled globally below. */
	:global(.rail-list) {
		font-size: var(--font-size-0);
	}
	:global(.rail-list .list-item) {
		min-height: 0;
	}
	:global(.rail-list .list-item > a),
	:global(.rail-list .list-item > button) {
		gap: var(--space-2);
		padding: 7px var(--space-2);
		border-radius: var(--radius-md);
	}
	:global(.rail-list .list-item.active > a),
	:global(.rail-list .list-item.active > button) {
		background: var(--dm-accent-soft);
		color: var(--color-text-active, var(--color-text));
		font-weight: var(--font-weight-semibold, 600);
	}
	/* Keyboard highlight ring when the folders pane owns focus. */
	:global(.rail-list .list-item.khl > a),
	:global(.rail-list .list-item.khl > button) {
		box-shadow: inset 0 0 0 1px var(--dm-focus-ring);
	}
	:global(.rail-list .list-item.quiet) {
		color: var(--color-text-disabled);
	}
	.glyph {
		width: 1.25em;
		text-align: center;
		font-size: 0.95em;
		opacity: 0.85;
		flex-shrink: 0;
	}
	.label {
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.count {
		font-variant-numeric: tabular-nums;
		font-size: var(--font-size-00);
		font-weight: var(--font-weight-semibold, 600);
		color: var(--color-primary);
		background: var(--dm-accent-soft);
		padding: 0 7px;
		border-radius: var(--radius-cap, 99px);
	}
	.section {
		margin-top: var(--space-3);
		padding: 0 var(--space-2) 4px;
		font-size: var(--font-size-00);
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--color-text-disabled);
	}
	.dot {
		width: 9px;
		height: 9px;
		border-radius: 50%;
		flex-shrink: 0;
	}
	.dot.all {
		background: linear-gradient(135deg, var(--dm-account-a), var(--dm-account-b));
	}
	.spacer {
		flex: 1;
		min-height: var(--space-4);
	}
</style>
