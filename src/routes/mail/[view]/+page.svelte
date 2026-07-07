<script lang="ts">
	import { tick, onMount, untrack, getContext } from 'svelte';
	import { toast } from '@delightstack/components';
	import { viewToQuery, viewTitle } from '$lib/mail/views';
	import { currentDensity, type Density } from '$lib/theme';
	import { useKeyboard } from '$lib/keyboard/keyboard.svelte';
	import { useActions } from '$lib/mail/actions-client.svelte';
	import { useScope } from '$lib/mail/scope.svelte';
	import { useFocus } from '$lib/mail/focus.svelte';
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
	const focus = useFocus();

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
	/** Anchor row for Shift-range selection; null until a range starts. */
	let anchor = $state<number | null>(null);
	/** Rows that fit the list viewport (set by ThreadList) — drives PageUp/Down. */
	let listRows = $state(12);
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

	let readingEl = $state<HTMLElement>();

	function clamp(i: number): number {
		return Math.min(docs.length - 1, Math.max(0, i));
	}
	function move(delta: number) {
		if (!docs.length) return;
		cursor = clamp(cursor + delta);
		anchor = null; // a plain move re-anchors the next Shift-range
	}
	function cursorTo(i: number) {
		if (!docs.length) return;
		cursor = clamp(i);
		anchor = null;
	}
	function scrollReading(dy: number) {
		readingEl?.scrollBy({ top: dy, behavior: 'smooth' });
	}
	/** One page of the list, in rows (leaving a row of overlap for context). */
	function pageStep(): number {
		return Math.max(1, listRows - 1);
	}

	/** Extend the multi-selection to a target row — anchor-based range, unioned
	 *  with any prior x/Shift picks. Every Shift+motion routes through here. */
	function extendTo(target: number) {
		if (!docs.length) return;
		if (anchor === null) anchor = cursor;
		cursor = clamp(target);
		const [lo, hi] = anchor <= cursor ? [anchor, cursor] : [cursor, anchor];
		const next = new Set(selected);
		for (let i = lo; i <= hi; i++) {
			const t = docs[i];
			if (t) next.add(String(t.id));
		}
		selected = next;
	}

	/** The dispatcher behind every arrow / page / home-end motion. In the reading
	 *  pane a motion scrolls the message; in the list it moves the cursor, and
	 *  when `extend` is set it grows the selection as it goes. */
	function nav(kind: 'line' | 'jump' | 'page', dir: -1 | 1, extend: boolean) {
		if (focus.is('reading')) {
			const px =
				kind === 'page' ? (readingEl?.clientHeight ?? 600) * 0.9 : kind === 'jump' ? 320 : 90;
			scrollReading(dir * px);
			return;
		}
		if (!focus.is('list')) return;
		const delta = dir * (kind === 'line' ? 1 : kind === 'jump' ? 5 : pageStep());
		if (extend) extendTo(cursor + delta);
		else move(delta);
	}
	function navEdge(where: 'top' | 'bottom', extend: boolean) {
		if (focus.is('reading')) {
			readingEl?.scrollTo({
				top: where === 'top' ? 0 : (readingEl?.scrollHeight ?? 0),
				behavior: 'smooth',
			});
			return;
		}
		if (!focus.is('list')) return;
		const target = where === 'top' ? 0 : docs.length - 1;
		if (extend) extendTo(target);
		else cursorTo(target);
	}

	// yazi h/l — move between panes. Left never closes the reader (it stays as a
	// live preview, like yazi); Right into the list opens the cursor thread.
	function paneLeft() {
		if (focus.is('reading')) focus.set('list');
		else if (focus.is('list')) focus.set('folders');
	}
	function paneRight() {
		if (!focus.is('list')) return;
		openCursor();
		if (openId) focus.set('reading');
	}

	/** Advance the cursor AND the open thread — next/prev without leaving the reader. */
	function stepThread(delta: number) {
		move(delta);
		const t = docs[cursor];
		if (t) openId = String(t.id);
	}
	function openCursor() {
		// Enter (and l/→) confirm a pending delete first — "D then Enter" is fast.
		if (confirmingDelete) {
			confirmingDelete = false;
			void act('delete');
			return;
		}
		const t = docs[cursor];
		if (!t) return;
		// In Drafts, opening resumes editing in the compose overlay, not the reader.
		if (view === 'drafts') {
			void openDraft(t);
			return;
		}
		openId = String(t.id);
	}
	async function openDraft(t: Thread) {
		const m = await latestMessage(String(t.id));
		if (!m) return;
		let bodyDoc: unknown;
		try {
			bodyDoc = m.draft_doc ? JSON.parse(m.draft_doc) : undefined;
		} catch {
			bodyDoc = undefined;
		}
		compose.open({
			draft_id: String(m.id),
			thread_id: String(t.id),
			to: nzList(m.to),
			cc: nzList(m.cc),
			subject: m.subject ?? '',
			bodyDoc,
		});
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
		anchor = cursor; // start a range from the row we just picked
	}
	function clearSelection() {
		selected = new Set();
		anchor = null;
	}
	function selectAndMove(delta: number) {
		extendTo(cursor + delta);
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
		clearSelection();
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
	//
	// Motions are pane-aware: gating on `listOrReading` lets the folder rail's own
	// j/k/←/→ win when the folders pane holds focus (the engine drops any binding
	// whose `when` is false before choosing a winner).
	const inList = () => focus.is('list');
	const listOrReading = () => focus.is('list') || focus.is('reading');
	onMount(() => {
		kb.pushContext('list');
		const off = kb.registerAll([
			// Move the cursor / scroll the reader.
			{ keys: 'j', description: 'Down', group: 'Navigate', context: 'list', when: listOrReading, handler: () => nav('line', 1, false) },
			{ keys: 'k', description: 'Up', group: 'Navigate', context: 'list', when: listOrReading, handler: () => nav('line', -1, false) },
			{ keys: 'ArrowDown', description: 'Down', group: 'Navigate', context: 'list', when: listOrReading, handler: () => nav('line', 1, false) },
			{ keys: 'ArrowUp', description: 'Up', group: 'Navigate', context: 'list', when: listOrReading, handler: () => nav('line', -1, false) },
			{ keys: 'Ctrl+ArrowDown', description: 'Down ×5', group: 'Navigate', context: 'list', when: listOrReading, handler: () => nav('jump', 1, false) },
			{ keys: 'Ctrl+ArrowUp', description: 'Up ×5', group: 'Navigate', context: 'list', when: listOrReading, handler: () => nav('jump', -1, false) },
			{ keys: 'PageDown', description: 'Page down', group: 'Navigate', context: 'list', when: listOrReading, handler: () => nav('page', 1, false) },
			{ keys: 'PageUp', description: 'Page up', group: 'Navigate', context: 'list', when: listOrReading, handler: () => nav('page', -1, false) },
			{ keys: 'Home', description: 'Top', group: 'Navigate', context: 'list', when: listOrReading, handler: () => navEdge('top', false) },
			{ keys: 'End', description: 'Bottom', group: 'Navigate', context: 'list', when: listOrReading, handler: () => navEdge('bottom', false) },
			{ keys: 'g g', description: 'Top', group: 'Navigate', context: 'list', when: inList, handler: () => navEdge('top', false) },
			{ keys: 'G', description: 'Bottom', group: 'Navigate', context: 'list', when: inList, handler: () => navEdge('bottom', false) },
			// Step to the next/prev thread without leaving the reader.
			{ keys: ']', description: 'Next thread (keep reading)', group: 'Reading', context: 'list', handler: () => stepThread(1) },
			{ keys: '[', description: 'Previous thread (keep reading)', group: 'Reading', context: 'list', handler: () => stepThread(-1) },
			// Pane movement (yazi h/l): folders ↔ list ↔ reading.
			{ keys: 'l', description: 'Into reader', group: 'Panes', context: 'list', when: listOrReading, handler: paneRight },
			{ keys: 'ArrowRight', description: 'Into reader', group: 'Panes', context: 'list', when: listOrReading, handler: paneRight },
			{ keys: 'Enter', description: 'Open thread', group: 'Panes', context: 'list', when: listOrReading, handler: paneRight },
			{ keys: 'h', description: 'Back to folders / list', group: 'Panes', context: 'list', when: listOrReading, handler: paneLeft },
			{ keys: 'ArrowLeft', description: 'Back to folders / list', group: 'Panes', context: 'list', when: listOrReading, handler: paneLeft },
			// Multi-select: Shift extends a range across every motion.
			{ keys: 'x', description: 'Select / deselect', group: 'Select', context: 'list', when: inList, handler: toggleSelect },
			{ keys: 'Shift+ArrowDown', description: 'Select down', group: 'Select', context: 'list', when: inList, handler: () => nav('line', 1, true) },
			{ keys: 'Shift+ArrowUp', description: 'Select up', group: 'Select', context: 'list', when: inList, handler: () => nav('line', -1, true) },
			{ keys: 'Ctrl+Shift+ArrowDown', description: 'Select down ×5', group: 'Select', context: 'list', when: inList, handler: () => nav('jump', 1, true) },
			{ keys: 'Ctrl+Shift+ArrowUp', description: 'Select up ×5', group: 'Select', context: 'list', when: inList, handler: () => nav('jump', -1, true) },
			{ keys: 'Shift+PageDown', description: 'Select page down', group: 'Select', context: 'list', when: inList, handler: () => nav('page', 1, true) },
			{ keys: 'Shift+PageUp', description: 'Select page up', group: 'Select', context: 'list', when: inList, handler: () => nav('page', -1, true) },
			{ keys: 'Shift+Home', description: 'Select to top', group: 'Select', context: 'list', when: inList, handler: () => navEdge('top', true) },
			{ keys: 'Shift+End', description: 'Select to bottom', group: 'Select', context: 'list', when: inList, handler: () => navEdge('bottom', true) },
			{ keys: 'J', description: 'Next thread / select down', group: 'Select', context: 'list', when: listOrReading, handler: () => (focus.is('reading') ? stepThread(1) : selectAndMove(1)) },
			{ keys: 'K', description: 'Prev thread / select up', group: 'Select', context: 'list', when: listOrReading, handler: () => (focus.is('reading') ? stepThread(-1) : selectAndMove(-1)) },
			// Actions — operate on the selection (or cursor) from any pane.
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
			{ keys: '/', description: 'Search', group: 'Find', context: 'list', handler: startSearch },
			{ keys: 'f', description: 'Filter loaded list', group: 'Find', context: 'list', handler: startFilter },
			{ keys: 'Escape', description: 'Close / clear', group: 'Panes', context: 'list', global: true, handler: () => {
				if (confirmingDelete) confirmingDelete = false;
				else if (moving) moving = false;
				else if (searching) endSearch();
				else if (filtering) endFilter();
				else if (selected.size) clearSelection();
				else if (openId) { openId = null; focus.set('list'); }
				else focus.set('list');
			} },
		]);
		return () => {
			off();
			kb.popContext('list');
		};
	});
</script>

<svelte:head><title>{title} · Mail</title></svelte:head>

<section
	class="list-pane pane"
	class:active={focus.is('list')}
	onmousedowncapture={() => focus.set('list')}>
	<header class="list-head">
		{#if searching}
			<div class="searchbar">
				<span class="search-icon" aria-hidden="true">⌕</span>
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
				<button class="scope" onclick={() => (searchScope = searchScope === 'folder' ? 'all' : 'folder')}>
					<kbd>Tab</kbd>
					{searchScope === 'all' ? 'All mail' : 'This folder'}
				</button>
			</div>
		{:else}
			<h1>{title}</h1>
			{#if selected.size}
				<span class="selcount">{selected.size} selected</span>
			{/if}
			<span class="count">{docs.length}</span>
		{/if}
	</header>

	{#if filtering}
		<div class="filterbar">
			<span class="filter-icon" aria-hidden="true">≣</span>
			<!-- svelte-ignore a11y_autofocus -->
			<input
				bind:this={filterInput}
				bind:value={filterText}
				placeholder="Filter loaded conversations…"
				onkeydown={(e) => e.key === 'Escape' && endFilter()} />
		</div>
	{/if}

	{#if confirmingDelete}
		<div class="bar danger" role="alertdialog" aria-label="Confirm delete">
			<span class="bar-msg">Delete {targets().length} forever? This can't be undone.</span>
			<button class="btn-danger" onclick={() => { confirmingDelete = false; act('delete'); }}><kbd>↵</kbd> Delete</button>
			<button class="btn-ghost" onclick={() => (confirmingDelete = false)}><kbd>Esc</kbd></button>
		</div>
	{/if}
	{#if moving}
		<div class="bar" role="menu" aria-label="Move to folder">
			<span class="bar-msg">Move {targets().length} to</span>
			{#each MOVE_FOLDERS as f}
				<button class="btn-ghost" role="menuitem" onclick={() => moveTo(f)}>{f}</button>
			{/each}
			<button class="btn-ghost dim" onclick={() => (moving = false)}><kbd>Esc</kbd></button>
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
				if (openId) focus.set('reading');
			}}
			onCursor={(i) => {
				cursor = i;
				focus.set('list');
			}}
			onToggleSelect={(i) => {
				cursor = i;
				toggleSelect();
			}}
			onRows={(n) => (listRows = n)}
			onSwipe={(i, dir) => {
				cursor = i;
				act(dir === 'archive' ? 'archive' : 'trash');
			}} />
	</div>
</section>

<div
	class="reading-pane pane"
	class:active={focus.is('reading')}
	bind:this={readingEl}
	onmousedowncapture={() => openId && focus.set('reading')}>
	<ReadingPane {db} threadId={openId} onReply={reply} onAct={act} />
</div>

<style>
	/* --- The pane-focus signature: the active column lifts and grows a top
	   accent rule so yazi ←/→ movement is unmistakable, while inactive panes
	   stay calm. --- */
	.pane {
		position: relative;
		transition: background-color var(--duration-fast, 120ms) var(--ease-out, ease);
	}
	.pane::before {
		content: '';
		position: absolute;
		inset: 0 0 auto 0;
		height: 2px;
		background: var(--color-primary);
		opacity: 0;
		transition: opacity var(--duration-fast, 120ms) var(--ease-out, ease);
		z-index: 2;
	}
	.pane.active::before {
		opacity: 1;
	}
	.pane.active {
		background: var(--dm-focus-tint);
	}

	.list-pane {
		width: 400px;
		flex-shrink: 0;
		border-right: 1px solid var(--color-border);
		display: flex;
		flex-direction: column;
		overflow: hidden;
	}
	.list-head {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		padding: var(--space-2) var(--space-3);
		border-bottom: 1px solid var(--color-border);
		min-height: 52px;
	}
	.list-head h1 {
		font-size: var(--font-size-2);
		font-weight: var(--font-weight-semibold, 600);
		letter-spacing: -0.01em;
		margin: 0;
		flex: 1;
	}
	.selcount {
		font-size: var(--font-size-00);
		font-weight: var(--font-weight-medium, 500);
		color: var(--color-primary);
		background: var(--dm-accent-soft);
		padding: 2px var(--space-2);
		border-radius: var(--radius-cap, 99px);
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
		gap: var(--space-2);
		width: 100%;
	}
	.search-icon,
	.filter-icon {
		color: var(--color-text-disabled);
		font-size: 1.1em;
	}
	.searchbar input,
	.filterbar input {
		flex: 1;
		padding: 6px 10px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		background: var(--color-bg-1);
		color: inherit;
		font: inherit;
		font-size: var(--font-size-0);
	}
	.searchbar input:focus,
	.filterbar input:focus {
		outline: none;
		border-color: var(--color-primary);
		box-shadow: 0 0 0 3px var(--dm-accent-soft);
	}
	.filterbar {
		padding: var(--space-1) var(--space-3) var(--space-2);
		border-bottom: 1px solid var(--color-border);
	}
	.scope {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		font-size: var(--font-size-00);
		color: var(--color-text-disabled);
		background: none;
		border: none;
		cursor: pointer;
		white-space: nowrap;
	}
	.bar {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		padding: var(--space-2) var(--space-3);
		border-bottom: 1px solid var(--color-border);
		background: var(--color-bg-2);
		font-size: var(--font-size-0);
		flex-wrap: wrap;
	}
	.bar-msg {
		flex: 1;
		min-width: 0;
	}
	.bar.danger {
		background: var(--color-error-bg, color-mix(in oklab, var(--color-error) 12%, var(--color-bg-2)));
		color: var(--color-error-text, inherit);
	}
	.btn-ghost,
	.btn-danger {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		background: var(--color-bg-1);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		padding: 3px 10px;
		color: inherit;
		cursor: pointer;
		font: inherit;
		font-size: var(--font-size-00);
		text-transform: capitalize;
	}
	.btn-ghost:hover {
		background: var(--color-bg-3);
	}
	.btn-ghost.dim {
		border-color: transparent;
		background: none;
		color: var(--color-text-disabled);
	}
	.btn-danger {
		background: var(--color-error);
		color: var(--color-error-text, white);
		border-color: transparent;
		font-weight: var(--font-weight-medium, 500);
	}
	.btn-danger kbd,
	.btn-ghost kbd {
		font-family: var(--font-mono);
		font-size: 0.85em;
		opacity: 0.9;
	}
	.list-body {
		flex: 1;
		min-height: 0;
	}
	.reading-pane {
		flex: 1;
		min-width: 0;
		overflow-y: auto;
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
