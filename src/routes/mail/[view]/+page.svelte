<script lang="ts">
	import { tick, onMount, untrack, getContext } from 'svelte';
	import { viewToQuery, viewTitle } from '$lib/mail/views';
	import { currentDensity, type Density } from '$lib/theme';
	import { useKeyboard } from '$lib/keyboard/keyboard.svelte';
	import { useActions } from '$lib/mail/actions-client.svelte';
	import { replySubject, replyAllRecipients } from '$lib/mail/compose';
	import ThreadList from '$lib/components/ThreadList.svelte';
	import ReadingPane from '$lib/components/ReadingPane.svelte';
	import type { ComposeInit } from '$lib/components/Compose.svelte';
	import type { Thread, Message } from '$lib/schema';
	import type { ThreadActionName } from '$lib/mail/actions';

	const compose = getContext<{ open: (init?: ComposeInit) => void }>('mail:compose');

	const { data } = $props();
	const { db, view } = $derived(data);

	const kb = useKeyboard();
	const actions = useActions();

	// --- search (/) and filter (f) state ---
	let searching = $state(false);
	let searchScope = $state<'folder' | 'all'>('folder');
	let searchTerm = $state('');
	let filtering = $state(false);
	let filterText = $state('');
	let searchInput = $state<HTMLInputElement>();
	let filterInput = $state<HTMLInputElement>();

	// Pass a REACTIVE query function — the search class re-queries automatically
	// when its reactive deps (view / search state) change. (Recreating the search
	// or setting `.query` in an effect fights the class's own reactivity.)
	const results = db.search('thread', () =>
		searching && searchTerm
			? { ...viewToQuery(searchScope === 'all' ? 'search' : view), term: searchTerm, limit: 200 }
			: viewToQuery(view),
	);

	// Apply the optimistic action overlay (hidden threads + flag patches), then
	// the client-only yazi filter over the loaded docs.
	const docs = $derived.by(() => {
		let all = (results.docs ?? []) as Thread[];
		all = all
			.filter((t) => !actions.isRemoved(t.id))
			.map((t) => {
				const patch = actions.patchFor(t.id);
				return patch ? ({ ...t, ...patch } as Thread) : t;
			});
		if (!filtering || !filterText.trim()) return all;
		const q = filterText.toLowerCase();
		return all.filter(
			(t) =>
				(t.subject ?? '').toLowerCase().includes(q) ||
				(t.participant_text ?? '').toLowerCase().includes(q),
		);
	});

	// --- selection / cursor / open ---
	let cursor = $state(0);
	let selected = $state<Set<string>>(new Set());
	let openId = $state<string | null>(null);
	let density = $state<Density>('comfortable');
	onMount(() => (density = currentDensity()));

	$effect(() => {
		// Clamp cursor when the list shrinks. Depend on length only; read/write
		// cursor untracked so the effect never loops on its own write.
		const len = docs.length;
		untrack(() => {
			const max = Math.max(0, len - 1);
			if (cursor > max) cursor = max;
		});
	});

	const title = $derived(viewTitle(view));

	function move(delta: number) {
		if (!docs.length) return;
		cursor = Math.min(docs.length - 1, Math.max(0, cursor + delta));
	}
	function openCursor() {
		const t = docs[cursor];
		if (t) openId = t.id;
	}
	function toggleSelect() {
		const t = docs[cursor];
		if (!t) return;
		const next = new Set(selected);
		if (next.has(t.id)) next.delete(t.id);
		else next.add(t.id);
		selected = next;
	}
	function selectAndMove(delta: number) {
		toggleSelect();
		move(delta);
	}

	/** The threads an action targets: the selection, or the cursor thread. */
	function targets(): Thread[] {
		if (selected.size) return docs.filter((t) => selected.has(t.id));
		const t = docs[cursor];
		return t ? [t] : [];
	}

	// --- reply / reply-all / forward ---
	async function latestMessage(threadId: string): Promise<Message | null> {
		try {
			const res = await db.list('message', {
				where: { thread_id: threadId },
				order: [{ key: 'date', direction: 'DESC' }],
				limit: 1,
			});
			return (res.docs?.[0] as Message) ?? null;
		} catch {
			return null;
		}
	}
	async function reply(kind: 'reply' | 'reply_all' | 'forward') {
		const t = docs[cursor];
		if (!t) return;
		const m = await latestMessage(t.id);
		if (!m) return;
		const selfEmails = m.identity_email ? [m.identity_email] : [];
		let init: ComposeInit;
		if (kind === 'forward') {
			init = {
				subject: replySubject(m.subject ?? t.subject ?? '', 'forward'),
				identity_id: undefined,
				thread_id: t.id,
			};
		} else {
			const recipients =
				kind === 'reply_all'
					? replyAllRecipients(m, selfEmails)
					: { to: m.reply_to?.length ? m.reply_to : m.from ? [m.from] : [], cc: [] };
			init = {
				to: recipients.to,
				cc: recipients.cc,
				subject: replySubject(m.subject ?? t.subject ?? '', 'reply'),
				in_reply_to: m.rfc822_message_id,
				references: [...(m.references ?? []), m.rfc822_message_id],
				thread_id: t.id,
			};
		}
		compose.open(init);
	}

	// Toggle direction is decided by the first target's current state.
	function starTarget(): ThreadActionName {
		return targets()[0]?.starred ? 'unstar' : 'star';
	}
	function readTarget(): ThreadActionName {
		return (targets()[0]?.unread_count ?? 0) > 0 ? 'read' : 'unread';
	}

	async function act(action: ThreadActionName, opts: { folder?: string } = {}) {
		const ts = targets();
		if (!ts.length) return;
		const isOut = ['archive', 'trash', 'delete', 'spam', 'move'].includes(action);
		await actions.apply(ts, action, opts);
		selected = new Set();
		// Auto-advance past a removed cursor thread.
		if (isOut) {
			if (openId && ts.some((t) => t.id === openId)) openId = null;
			cursor = Math.min(cursor, Math.max(0, docs.length - 1));
		}
	}

	async function startSearch() {
		searching = true;
		await tick();
		searchInput?.focus();
	}
	function endSearch() {
		searching = false;
		searchTerm = '';
	}
	async function startFilter() {
		filtering = true;
		await tick();
		filterInput?.focus();
	}
	function endFilter() {
		filtering = false;
		filterText = '';
	}

	// --- keyboard bindings (list context) ---
	// onMount, NOT $effect: pushContext reads+writes the context-stack $state,
	// which would loop inside a tracked effect. The binding handlers close over
	// the live reactive state, so registering once is correct.
	onMount(() => {
		kb.pushContext('list');
		const off = kb.registerAll([
			{ keys: 'j', description: 'Next', group: 'List', context: 'list', handler: () => move(1) },
			{ keys: 'ArrowDown', description: 'Next', group: 'List', context: 'list', handler: () => move(1) },
			{ keys: 'k', description: 'Previous', group: 'List', context: 'list', handler: () => move(-1) },
			{ keys: 'ArrowUp', description: 'Previous', group: 'List', context: 'list', handler: () => move(-1) },
			{ keys: 'Ctrl+d', description: 'Half page down', group: 'List', context: 'list', handler: () => move(10) },
			{ keys: 'Ctrl+u', description: 'Half page up', group: 'List', context: 'list', handler: () => move(-10) },
			{ keys: 'g g', description: 'Top of list', group: 'List', context: 'list', handler: () => (cursor = 0) },
			{ keys: 'G', description: 'Bottom of list', group: 'List', context: 'list', handler: () => (cursor = docs.length - 1) },
			{ keys: 'Home', description: 'Top of list', group: 'List', context: 'list', handler: () => (cursor = 0) },
			{ keys: 'End', description: 'Bottom of list', group: 'List', context: 'list', handler: () => (cursor = docs.length - 1) },
			{ keys: 'Enter', description: 'Open thread', group: 'List', context: 'list', handler: openCursor },
			{ keys: 'l', description: 'Open thread', group: 'List', context: 'list', handler: openCursor },
			{ keys: 'ArrowRight', description: 'Open thread', group: 'List', context: 'list', handler: openCursor },
			{ keys: 'h', description: 'Close thread', group: 'List', context: 'list', handler: () => (openId = null) },
			{ keys: 'ArrowLeft', description: 'Close thread', group: 'List', context: 'list', handler: () => (openId = null) },
			{ keys: 'x', description: 'Select / deselect', group: 'List', context: 'list', handler: toggleSelect },
			{ keys: 'Shift+j', description: 'Select and move down', group: 'List', context: 'list', handler: () => selectAndMove(1) },
			{ keys: 'Shift+k', description: 'Select and move up', group: 'List', context: 'list', handler: () => selectAndMove(-1) },
			{ keys: 'a', description: 'Archive', group: 'Actions', context: 'list', handler: () => act('archive') },
			{ keys: 'd', description: 'Trash', group: 'Actions', context: 'list', handler: () => act('trash') },
			{ keys: 'D', description: 'Delete forever', group: 'Actions', context: 'list', handler: () => act('delete') },
			{ keys: 's', description: 'Toggle star', group: 'Actions', context: 'list', handler: () => act(starTarget()) },
			{ keys: 'u', description: 'Toggle read/unread', group: 'Actions', context: 'list', handler: () => act(readTarget()) },
			{ keys: '!', description: 'Mark spam', group: 'Actions', context: 'list', handler: () => act('spam') },
			{ keys: 'r', description: 'Reply', group: 'Actions', context: 'list', handler: () => reply('reply') },
			{ keys: 'R', description: 'Reply all', group: 'Actions', context: 'list', handler: () => reply('reply_all') },
			{ keys: 'w', description: 'Forward', group: 'Actions', context: 'list', handler: () => reply('forward') },
			{ keys: '/', description: 'Search', group: 'List', context: 'list', handler: startSearch },
			{ keys: 'f', description: 'Filter loaded list', group: 'List', context: 'list', handler: startFilter },
			{ keys: 'Escape', description: 'Close / clear', group: 'List', context: 'list', global: true, handler: () => {
				if (searching) endSearch();
				else if (filtering) endFilter();
				else openId = null;
			} },
		]);
		return () => {
			off();
			kb.popContext('list');
		};
	});
</script>

<svelte:head><title>{title} · Mail</title></svelte:head>

<section class="list-pane">
	<header class="list-head">
		{#if searching}
			<div class="searchbar">
				<!-- svelte-ignore a11y_autofocus -->
				<input
					bind:this={searchInput}
					bind:value={searchTerm}
					placeholder="Search {searchScope === 'all' ? 'all mail' : title}…"
					onkeydown={(e) => {
						if (e.key === 'Escape') endSearch();
						if (e.key === 'Tab') {
							e.preventDefault();
							searchScope = searchScope === 'folder' ? 'all' : 'folder';
						}
					}} />
				<span class="scope">Tab: {searchScope}</span>
			</div>
		{:else}
			<h1>{title}</h1>
			<span class="count">{docs.length}</span>
		{/if}
	</header>

	{#if filtering}
		<div class="filterbar">
			<!-- svelte-ignore a11y_autofocus -->
			<input
				bind:this={filterInput}
				bind:value={filterText}
				placeholder="Filter…"
				onkeydown={(e) => e.key === 'Escape' && endFilter()} />
		</div>
	{/if}

	<div class="list-body">
		<ThreadList
			docs={docs}
			{cursor}
			{selected}
			{density}
			loading={results.loading}
			onOpen={(i) => {
				cursor = i;
				openCursor();
			}}
			onCursor={(i) => (cursor = i)}
			onSwipe={(i, dir) => {
				cursor = i;
				act(dir === 'archive' ? 'archive' : 'trash');
			}} />
	</div>
</section>

<div class="reading-pane">
	<ReadingPane {db} threadId={openId} />
</div>

<style>
	.list-pane {
		width: 380px;
		flex-shrink: 0;
		border-right: 1px solid var(--color-outline);
		display: flex;
		flex-direction: column;
		overflow: hidden;
	}
	.list-head {
		display: flex;
		align-items: center;
		gap: var(--size-2);
		padding: var(--size-2) var(--size-3);
		border-bottom: 1px solid var(--color-outline);
		min-height: 44px;
	}
	.list-head h1 {
		font-size: var(--font-size-1);
		margin: 0;
		flex: 1;
	}
	.count {
		color: var(--color-text-disabled);
		font-variant-numeric: tabular-nums;
		font-size: var(--font-size-0);
	}
	.searchbar,
	.filterbar {
		display: flex;
		align-items: center;
		gap: var(--size-2);
		width: 100%;
	}
	.searchbar input,
	.filterbar input {
		flex: 1;
		padding: 5px 8px;
		border: 1px solid var(--color-outline);
		border-radius: var(--radius-2);
		background: var(--color-bg-2);
		color: inherit;
	}
	.filterbar {
		padding: var(--size-1) var(--size-3);
		border-bottom: 1px solid var(--color-outline);
	}
	.scope {
		font-size: var(--font-size-00, 0.7rem);
		color: var(--color-text-disabled);
	}
	.list-body {
		flex: 1;
		min-height: 0;
	}
	.reading-pane {
		flex: 1;
		min-width: 0;
		overflow: hidden;
	}
	@media (max-width: 767px) {
		.list-pane {
			width: 100%;
		}
		.reading-pane {
			display: none;
		}
	}
</style>
