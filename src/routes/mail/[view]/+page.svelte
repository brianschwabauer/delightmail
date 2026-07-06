<script lang="ts">
	import { tick } from 'svelte';
	import { viewToQuery, viewTitle } from '$lib/mail/views';
	import { useKeyboard } from '$lib/keyboard/keyboard.svelte';
	import ThreadList from '$lib/components/ThreadList.svelte';
	import ReadingPane from '$lib/components/ReadingPane.svelte';
	import type { Thread } from '$lib/schema';

	const { data } = $props();
	const { db, view } = $derived(data);

	const kb = useKeyboard();

	// --- search (/) and filter (f) state ---
	let searching = $state(false);
	let searchScope = $state<'folder' | 'all'>('folder');
	let searchTerm = $state('');
	let filtering = $state(false);
	let filterText = $state('');
	let searchInput = $state<HTMLInputElement>();
	let filterInput = $state<HTMLInputElement>();

	const query = $derived(
		searching && searchTerm
			? { ...viewToQuery(searchScope === 'all' ? 'search' : view), term: searchTerm, limit: 200 }
			: viewToQuery(view),
	);
	const results = $derived(db.search('thread', query));

	// Client-only yazi filter over the loaded docs.
	const docs = $derived.by(() => {
		const all = (results.docs ?? []) as Thread[];
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

	$effect(() => {
		// Clamp cursor when the list changes.
		if (cursor >= docs.length) cursor = Math.max(0, docs.length - 1);
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
	$effect(() => {
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
			loading={results.loading}
			onOpen={(i) => {
				cursor = i;
				openCursor();
			}}
			onCursor={(i) => (cursor = i)} />
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
