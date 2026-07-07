<script lang="ts">
	import { tick, onMount, untrack, getContext } from 'svelte';
	import { Button, Input, toast } from '@delightstack/components';
	import Icon from '$lib/components/Icon.svelte';
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
	// The delightstack <Input> doesn't expose its DOM node or forward keydown, so
	// we bind the wrapping bar and reach the inner <input> for focus, and listen
	// for Escape/Tab on the bar (keydown bubbles up from the input).
	let searchbarEl = $state<HTMLElement>();
	let filterbarEl = $state<HTMLElement>();

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
	/** Selection as it stood when the current Shift-range gesture began — the
	 *  range [anchor..cursor] is applied on top of this, so shrinking the range
	 *  (moving back toward the anchor) restores rows instead of leaving them stuck. */
	let rangeBase = $state<Set<string>>(new Set());
	/** Whether the active range gesture is adding or removing rows (yazi-style):
	 *  a gesture that starts on an unselected anchor selects; on a selected anchor
	 *  it deselects. So holding Shift and moving can select OR deselect. */
	let rangeMode = $state<'select' | 'deselect'>('select');
	/** Rows that fit the list viewport (set by ThreadList) — drives PageUp/Down. */
	let listRows = $state(12);
	let openId = $state<string | null>(null);
	/** The messages of the open thread, mirrored up from the reading pane so reply/
	 *  forward act on data already loaded (no extra round-trip that could hang). */
	let openMessages = $state<Message[]>([]);
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
	/** Show the cursor thread in the reading pane as a live preview, without
	 *  stealing focus (yazi-style: moving the cursor previews the "child"). The
	 *  reader only marks-read once it's actually focused, so previewing is free.
	 *  Drafts resume in the compose overlay, so they aren't previewed here. */
	function previewCursor() {
		if (!docs.length || view === 'drafts') return;
		const t = docs[cursor];
		if (t) openId = String(t.id);
	}
	function move(delta: number) {
		if (!docs.length) return;
		cursor = clamp(cursor + delta);
		anchor = null; // a plain move re-anchors the next Shift-range
		previewCursor();
	}
	function cursorTo(i: number) {
		if (!docs.length) return;
		cursor = clamp(i);
		anchor = null;
		previewCursor();
	}
	function scrollReading(dy: number) {
		readingEl?.scrollBy({ top: dy, behavior: 'smooth' });
	}
	/** One page of the list, in rows (leaving a row of overlap for context). */
	function pageStep(): number {
		return Math.max(1, listRows - 1);
	}

	/** Begin (or continue) a Shift-range gesture anchored at the current cursor.
	 *  Snapshots the selection so the range can grow AND shrink, and locks in
	 *  whether this gesture selects or deselects. */
	function beginGesture(mode: 'select' | 'deselect') {
		anchor = cursor;
		rangeBase = new Set(selected);
		rangeMode = mode;
	}
	/** Paint the range [anchor..cursor] onto the pre-gesture base — add rows when
	 *  the gesture selects, remove them when it deselects. Rows outside the range
	 *  fall back to the base, so backing up over them undoes the pick. */
	function applyRange() {
		if (anchor === null) return;
		const [lo, hi] = anchor <= cursor ? [anchor, cursor] : [cursor, anchor];
		const next = new Set(rangeBase);
		for (let i = lo; i <= hi; i++) {
			const t = docs[i];
			if (!t) continue;
			if (rangeMode === 'select') next.add(String(t.id));
			else next.delete(String(t.id));
		}
		selected = next;
	}
	/** Extend the multi-selection to a target row — anchor-based range that both
	 *  selects and deselects. Every Shift/Ctrl+Shift motion routes through here. */
	function extendTo(target: number) {
		if (!docs.length) return;
		// A fresh gesture (no live anchor): its direction is decided by the anchor
		// row's current state — start on a selected row and Shift+move deselects.
		if (anchor === null) {
			const cur = docs[cursor];
			beginGesture(cur && selected.has(String(cur.id)) ? 'deselect' : 'select');
		}
		cursor = clamp(target);
		applyRange();
		previewCursor();
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
		// Drafts open in the compose overlay; everything else is already showing
		// as a live preview, so → just moves focus into the reader to scroll it.
		if (view === 'drafts') {
			openCursor();
			return;
		}
		if (!openId) openCursor();
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
		const nowSelected = !next.has(id);
		if (nowSelected) next.add(id);
		else next.delete(id);
		selected = next;
		// Seed a range gesture from this row so a following Shift+move continues in
		// the same direction (x-select then Shift+↓ keeps selecting; x-deselect then
		// Shift+↓ keeps deselecting).
		beginGesture(nowSelected ? 'select' : 'deselect');
	}
	/** yazi's Space: toggle the cursor row, then drop the cursor onto the next one
	 *  (previewing it). So you can keep tapping Space to sweep down a list —
	 *  selecting each mail you've just previewed while the next one opens. */
	function toggleSelectAndAdvance() {
		toggleSelect();
		move(1);
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
		// Target the thread actually on screen in the reader (openId) — the reading
		// pane's Reply/Forward buttons act on what's open, and a deep-link or a
		// re-sorted list can leave the cursor pointing elsewhere.
		const t = docs.find((d) => String(d.id) === openId) ?? docs[cursor];
		if (!t) return;
		// Prefer the messages the reader already loaded (reply is then instant and
		// can't hang on a round-trip); only fetch when replying to a thread that
		// isn't the one on screen. Reader messages are date-ASC, so the last is latest.
		const loaded =
			openId && String(t.id) === openId && openMessages.length
				? openMessages[openMessages.length - 1]
				: null;
		const m = loaded ?? (await latestMessage(String(t.id)));
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
		searchbarEl?.querySelector('input')?.focus();
	}
	function endSearch() {
		searching = false;
		searchTerm = '';
	}
	function onSearchKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') endSearch();
		else if (e.key === 'Tab') {
			e.preventDefault();
			searchScope = searchScope === 'folder' ? 'all' : 'folder';
		}
	}
	async function startFilter() {
		filtering = true;
		await tick();
		filterbarEl?.querySelector('input')?.focus();
	}
	function endFilter() {
		filtering = false;
		filterText = '';
	}
	function onFilterKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') endFilter();
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
			{ keys: 'Space', description: 'Select & go to next', group: 'Select', context: 'list', when: inList, handler: toggleSelectAndAdvance },
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
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div class="searchbar" bind:this={searchbarEl} onkeydown={onSearchKeydown}>
				<span class="search-icon" aria-hidden="true"><Icon name="search" size={16} /></span>
				<Input
					bind:value={searchTerm}
					dense
					clearable
					class="findbar-input"
					placeholder="Search {searchScope === 'all' ? 'all mail' : title}…" />
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
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div class="filterbar" bind:this={filterbarEl} onkeydown={onFilterKeydown}>
			<span class="filter-icon" aria-hidden="true"><Icon name="filter" size={16} /></span>
			<Input
				bind:value={filterText}
				dense
				clearable
				class="findbar-input"
				placeholder="Filter loaded conversations…" />
		</div>
	{/if}

	{#if confirmingDelete}
		<div class="bar danger" role="alertdialog" aria-label="Confirm delete">
			<span class="bar-msg">Delete {targets().length} forever? This can't be undone.</span>
			<Button size="0" error onclick={() => { confirmingDelete = false; act('delete'); }}><kbd>↵</kbd> Delete</Button>
			<Button size="0" transparent onclick={() => (confirmingDelete = false)}><kbd>Esc</kbd></Button>
		</div>
	{/if}
	{#if moving}
		<div class="bar" role="menu" aria-label="Move to folder">
			<span class="bar-msg">Move {targets().length} to</span>
			{#each MOVE_FOLDERS as f}
				<Button size="0" outline class="cap" onclick={() => moveTo(f)}>{f}</Button>
			{/each}
			<Button size="0" transparent onclick={() => (moving = false)}><kbd>Esc</kbd></Button>
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
				anchor = null;
				focus.set('list');
				previewCursor();
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
	<ReadingPane
		{db}
		threadId={openId}
		markReadActive={focus.is('reading')}
		onDocs={(m) => (openMessages = m)}
		onReply={reply}
		onAct={act} />
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
		display: inline-flex;
		align-items: center;
		color: var(--color-text-disabled);
		flex-shrink: 0;
	}
	.searchbar :global(.findbar-input),
	.filterbar :global(.findbar-input) {
		flex: 1;
		min-width: 0;
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
	.bar :global(.cap) {
		text-transform: capitalize;
	}
	.bar kbd {
		font-family: var(--font-mono);
		font-size: 0.85em;
		opacity: 0.9;
		margin-right: 3px;
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
