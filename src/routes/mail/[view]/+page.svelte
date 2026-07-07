<script lang="ts">
	import { tick, onMount, untrack, getContext } from 'svelte';
	import { toast } from '@delightstack/components';
	import { viewToQuery, viewTitle } from '$lib/mail/views';
	import { currentDensity, type Density } from '$lib/theme';
	import { useKeyboard } from '$lib/keyboard/keyboard.svelte';
	import { useActions } from '$lib/mail/actions-client.svelte';
	import { useScope } from '$lib/mail/scope.svelte';
	import { replySubject, replyAllRecipients, buildQuoteDoc } from '$lib/mail/compose';
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
	const scope = useScope();

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
			.filter((t) => !actions.isRemoved(String(t.id)))
			// Account scope filter (All / per-account, §10.1).
			.filter((t) => scope.includes(t.account_ids as string[] | undefined))
			.map((t) => {
				const patch = actions.patchFor(String(t.id));
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
	let confirmingDelete = $state(false);
	let moving = $state(false);
	const MOVE_FOLDERS = ['inbox', 'archive', 'spam', 'trash'] as const;
	onMount(() => {
		density = currentDensity();
		// Deep-link: /mail/[view]?t=<thread_id> opens a thread (push notificationclick
		// lands here, §10.4). Selection lives in the query so list scroll never resets.
		const t = new URLSearchParams(location.search).get('t');
		if (t) openId = t;
	});

	// Mirror the open thread into the URL (?t=) without a navigation, so reload and
	// the notification deep-link stay in sync.
	$effect(() => {
		const id = openId;
		if (typeof history === 'undefined') return;
		untrack(() => {
			const url = new URL(location.href);
			if (id) url.searchParams.set('t', id);
			else url.searchParams.delete('t');
			history.replaceState(history.state, '', url);
		});
	});

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
		// Enter (and l/→) confirm a pending delete first — "D then Enter" is fast.
		if (confirmingDelete) {
			confirmingDelete = false;
			void act('delete');
			return;
		}
		const t = docs[cursor];
		if (t) openId = String(t.id);
	}

	// D → confirm-modal defaulting to Yes (Enter confirms, Esc cancels) — never
	// hard-delete on a single keystroke (Gmail-scope caveat §5.1).
	function askDelete() {
		if (targets().length) confirmingDelete = true;
	}

	// v / m → move picker. e → unsubscribe from the cursor thread's sender.
	function openMove() {
		if (targets().length) moving = true;
	}
	async function moveTo(folder: string) {
		moving = false;
		await act('move', { folder });
	}
	async function unsubscribeCursor() {
		const t = docs[cursor];
		if (!t) return;
		const m = await latestMessage(String(t.id));
		if (!m) return;
		// unsubscribe_task is indexed by sender_domain (message_id isn't searchable).
		const domain = (m.from?.email ?? '').split('@')[1]?.toLowerCase();
		if (!domain) return toast('No unsubscribe option for this sender.');
		try {
			const res = (await db.list('unsubscribe_task', {
				where: { sender_domain: [domain], status: { eq: 'suggested' } },
				limit: 1,
			})) as unknown as { docs?: Array<{ id: string | number }> };
			const task = res.docs?.[0];
			if (!task) return toast('No unsubscribe option for this sender.');
			const r = await fetch(`/api/unsubscribe/${encodeURIComponent(String(task.id))}`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: '{}',
			});
			const body = (await r.json().catch(() => ({}))) as { ok?: boolean; manual?: string };
			if (body.ok) toast('Unsubscribed.');
			else if (body.manual) {
				window.open(body.manual, '_blank', 'noopener');
				toast('Opened the unsubscribe page.');
			} else toast('Could not unsubscribe automatically.');
		} catch (e) {
			toast((e as Error).message);
		}
	}
	function toggleSelect() {
		const t = docs[cursor];
		if (!t) return;
		const id = String(t.id);
		const next = new Set(selected);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		selected = next;
	}
	function selectAndMove(delta: number) {
		toggleSelect();
		move(delta);
	}

	/** The threads an action targets: the selection, or the cursor thread. */
	function targets(): Thread[] {
		if (selected.size) return docs.filter((t) => selected.has(String(t.id)));
		const t = docs[cursor];
		return t ? [t] : [];
	}

	// --- reply / reply-all / forward ---
	async function latestMessage(threadId: string): Promise<Message | null> {
		try {
			const res = (await db.list('message', {
				where: { thread_id: threadId },
				order: [{ key: 'date', direction: 'DESC' }],
				limit: 1,
			})) as unknown as { docs?: Message[] };
			return res.docs?.[0] ?? null;
		} catch {
			return null;
		}
	}
	async function reply(kind: 'reply' | 'reply_all' | 'forward') {
		const t = docs[cursor];
		if (!t) return;
		const m = await latestMessage(String(t.id));
		if (!m) return;
		const selfEmails = m.identity_email ? [m.identity_email] : [];
		// The DSL types message addresses as nullable ({name: string|null}); the pure
		// compose helpers want the clean {name?: string} shape — normalize here.
		const src = {
			from: nzAddr(m.from),
			to: nzList(m.to),
			cc: nzList(m.cc),
			reply_to: nzList(m.reply_to),
		};
		// Quoted history (from the excerpt available client-side), collapsed under a
		// blockquote the user types above (§10.3).
		const quoted = buildQuoteDoc({ from: src.from, date: m.date, text: m.text_excerpt ?? '' });
		let init: ComposeInit;
		if (kind === 'forward') {
			init = {
				subject: replySubject(m.subject ?? t.subject ?? '', 'forward'),
				identity_id: undefined,
				bodyDoc: quoted,
				thread_id: String(t.id),
			};
		} else {
			const recipients =
				kind === 'reply_all'
					? replyAllRecipients(src, selfEmails)
					: { to: src.reply_to.length ? src.reply_to : src.from ? [src.from] : [], cc: [] };
			init = {
				to: recipients.to,
				cc: recipients.cc,
				subject: replySubject(m.subject ?? t.subject ?? '', 'reply'),
				bodyDoc: quoted,
				in_reply_to: m.rfc822_message_id,
				references: [...(m.references ?? []), m.rfc822_message_id],
				thread_id: String(t.id),
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
			if (openId && ts.some((t) => String(t.id) === openId)) openId = null;
			cursor = Math.min(cursor, Math.max(0, docs.length - 1));
		}
	}

	// Normalize DSL-nullable addresses ({name: string|null}) to the clean shape.
	type CleanAddr = { name?: string; email?: string };
	function nzAddr(a: { name?: string | null; email?: string | null } | null | undefined): CleanAddr | undefined {
		return a ? { name: a.name ?? undefined, email: a.email ?? undefined } : undefined;
	}
	function nzList(list: Array<{ name?: string | null; email?: string | null }> | null | undefined): CleanAddr[] {
		return (list ?? []).map((a) => ({ name: a.name ?? undefined, email: a.email ?? undefined }));
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
			// The tokenizer emits bare uppercase for a shifted letter (like G/D/R), so
			// select-and-move must be registered as 'J'/'K', not 'Shift+j'/'Shift+k'
			// (which never matched → the bindings were dead).
			{ keys: 'J', description: 'Select and move down', group: 'List', context: 'list', handler: () => selectAndMove(1) },
			{ keys: 'K', description: 'Select and move up', group: 'List', context: 'list', handler: () => selectAndMove(-1) },
			{ keys: 'a', description: 'Archive', group: 'Actions', context: 'list', handler: () => act('archive') },
			{ keys: 'd', description: 'Trash', group: 'Actions', context: 'list', handler: () => act('trash') },
			{ keys: 'D', description: 'Delete forever', group: 'Actions', context: 'list', handler: askDelete },
			{ keys: 's', description: 'Toggle star', group: 'Actions', context: 'list', handler: () => act(starTarget()) },
			{ keys: 'u', description: 'Toggle read/unread', group: 'Actions', context: 'list', handler: () => act(readTarget()) },
			{ keys: '!', description: 'Mark spam', group: 'Actions', context: 'list', handler: () => act('spam') },
			{ keys: 'v', description: 'Move to…', group: 'Actions', context: 'list', handler: openMove },
			{ keys: 'm', description: 'Move to…', group: 'Actions', context: 'list', handler: openMove },
			{ keys: 'e', description: 'Unsubscribe', group: 'Actions', context: 'list', handler: () => void unsubscribeCursor() },
			{ keys: 'r', description: 'Reply', group: 'Actions', context: 'list', handler: () => reply('reply') },
			{ keys: 'R', description: 'Reply all', group: 'Actions', context: 'list', handler: () => reply('reply_all') },
			{ keys: 'w', description: 'Forward', group: 'Actions', context: 'list', handler: () => reply('forward') },
			{ keys: '/', description: 'Search', group: 'List', context: 'list', handler: startSearch },
			{ keys: 'f', description: 'Filter loaded list', group: 'List', context: 'list', handler: startFilter },
			{ keys: 'Escape', description: 'Close / clear', group: 'List', context: 'list', global: true, handler: () => {
				if (confirmingDelete) confirmingDelete = false;
				else if (moving) moving = false;
				else if (searching) endSearch();
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

	{#if confirmingDelete}
		<div class="bar danger" role="alertdialog" aria-label="Confirm delete">
			<span>Delete {targets().length} forever? This can't be undone.</span>
			<button class="yes" onclick={() => { confirmingDelete = false; act('delete'); }}>Enter · Delete</button>
			<button onclick={() => (confirmingDelete = false)}>Esc</button>
		</div>
	{/if}
	{#if moving}
		<div class="bar" role="menu" aria-label="Move to folder">
			<span>Move to:</span>
			{#each MOVE_FOLDERS as f}
				<button role="menuitem" onclick={() => moveTo(f)}>{f}</button>
			{/each}
			<button onclick={() => (moving = false)}>Esc</button>
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
	.bar {
		display: flex;
		align-items: center;
		gap: var(--size-2);
		padding: var(--size-1) var(--size-3);
		border-bottom: 1px solid var(--color-outline);
		background: var(--color-bg-2);
		font-size: var(--font-size-00, 0.75rem);
		flex-wrap: wrap;
	}
	.bar.danger {
		background: color-mix(in oklab, var(--color-danger, #dc2626) 12%, var(--color-bg-2));
	}
	.bar button {
		background: var(--color-bg-1);
		border: 1px solid var(--color-outline);
		border-radius: var(--radius-2);
		padding: 2px 8px;
		color: inherit;
		cursor: pointer;
		font: inherit;
		font-size: var(--font-size-00, 0.72rem);
	}
	.bar .yes {
		background: var(--color-danger, #dc2626);
		color: white;
		border-color: transparent;
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
