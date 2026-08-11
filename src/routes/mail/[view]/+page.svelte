<script lang="ts">
	import { tick, onMount, untrack, getContext } from 'svelte';
	import { pushState, replaceState } from '$app/navigation';
	import { page } from '$app/state';
	import { Button, Input, toast } from '@delightstack/components';
	import { isMobile } from '$lib/mobile';
	import Icon from '$lib/components/Icon.svelte';
	import { viewToQuery, viewTitle, folderOfView } from '$lib/mail/views';
	import { parseSearchInput } from '$lib/mail/search-operators';
	import SnoozeChordMenu from '$lib/components/SnoozeChordMenu.svelte';
	import { currentDensity, resolvedScheme, type Density } from '$lib/theme';
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
	const drawer = getContext<{ open: () => void }>('mail:drawer');

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

	// Operators (from:, has:attachment, is:unread, is:starred, in:folder) are
	// pulled out of the raw input; the remainder is the free-text term.
	const parsed = $derived(parseSearchInput(searchTerm));

	// Pass a REACTIVE query function — the search class re-queries automatically
	// when its reactive deps (view / search state) change. (Recreating the search
	// or setting `.query` in an effect fights the class's own reactivity.)
	const results = db.search('thread', () => {
		if (!(searching && searchTerm)) return viewToQuery(view);
		const q = viewToQuery(searchScope === 'all' ? 'search' : view);
		const where: Record<string, unknown> = { ...(q.where ?? {}) };
		if (parsed.folder) where.folder = { eq: parsed.folder };
		if (parsed.starred) where.starred = true;
		if (parsed.hasAttachment) where.has_attachments = true;
		if (parsed.unread) where.unread_count = { gt: 0 };
		return { ...q, where, term: parsed.term || undefined, limit: 200 };
	});

	// MESSAGE-scope search: the thread index only covers subject + participants,
	// so "find that invoice" (body text) or from:alice need the message index —
	// text_excerpt and from_text are indexed for exactly this. Hits map back to
	// their threads and merge into the list below.
	const messageHits = db.search('message', () => {
		const active = searching && searchTerm && (parsed.term || parsed.from);
		if (!active) return { where: { thread_id: ['__none__'] }, limit: 1 };
		const where: Record<string, unknown> = {};
		if (parsed.unread) where.is_read = false;
		if (parsed.starred) where.is_starred = true;
		const scopeFolder =
			parsed.folder ?? (searchScope === 'folder' ? folderOfView(view) : undefined);
		if (scopeFolder) where.folder = { eq: scopeFolder };
		return {
			term: parsed.term || parsed.from,
			where: Object.keys(where).length ? where : undefined,
			limit: 200,
		};
	});
	const bodyThreadIds = $derived.by(() => {
		if (!(searching && searchTerm)) return [] as string[];
		const from = parsed.from;
		const ids = new Set<string>();
		for (const m of (messageHits.docs ?? []) as Message[]) {
			// from: post-filters the hits precisely (the term search is fuzzy).
			if (from && !(m.from_text ?? '').toLowerCase().includes(from)) continue;
			if (m.thread_id) ids.add(String(m.thread_id));
		}
		return [...ids];
	});
	const bodyThreads = db.search('thread', () =>
		bodyThreadIds.length
			? { where: { id: bodyThreadIds }, limit: 200 }
			: { where: { id: ['__none__'] }, limit: 1 },
	);

	// Apply the optimistic action overlay (hidden threads + flag patches), then
	// the client-only yazi filter over the loaded docs.
	const docs = $derived.by(() => {
		let all = (results.docs ?? []) as Thread[];
		// Merge in body-search matches the thread index missed, newest first.
		if (searching && searchTerm) {
			const seen = new Set(all.map((t) => String(t.id)));
			const extras = ((bodyThreads.docs ?? []) as Thread[]).filter((t) => {
				if (seen.has(String(t.id))) return false;
				// Thread-level operators still apply to body matches.
				if (parsed.starred && !t.starred) return false;
				if (parsed.hasAttachment && !t.has_attachments) return false;
				if (parsed.unread && !((t.unread_count ?? 0) > 0)) return false;
				return true;
			});
			if (extras.length) {
				all = [...all, ...extras].sort(
					(a, b) => (b.last_message_at ?? 0) - (a.last_message_at ?? 0),
				);
			}
		}
		all = all
			.filter((t) => !actions.isRemoved(String(t.id)))
			// Account scope filter (All / per-account).
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
	/** Set when a deep-link (?t=) opened a thread before the list loaded — once the
	 *  docs arrive we snap the cursor onto it so the instant preview header agrees
	 *  with the thread the reader is showing. */
	let deepLinkPending = $state(false);
	/** The messages of the open thread, mirrored up from the reading pane so reply/
	 *  forward act on data already loaded (no extra round-trip that could hang). */
	let openMessages = $state<Message[]>([]);
	let density = $state<Density>('comfortable');
	let confirmingDelete = $state(false);
	let moving = $state(false);
	let snoozing = $state(false);
	const MOVE_FOLDERS = ['inbox', 'archive', 'spam', 'trash'] as const;
	onMount(() => {
		density = currentDensity();
		// Deep-link: /mail/[view]?t=<thread_id> opens a thread (push notificationclick
		// lands here). Selection lives in the query so list scroll never resets.
		const t = new URLSearchParams(location.search).get('t');
		if (t) {
			openId = t;
			deepLinkPending = true;
			// Strip ?t= from THIS history entry so the entry under the reader is the
			// plain list — the mirror effect below re-adds it (mobile as a pushed
			// shallow entry, desktop in place), and phone-back from a notification
			// deep-link then lands on the list instead of re-opening the thread.
			const url = new URL(location.href);
			url.searchParams.delete('t');
			history.replaceState(history.state, '', url);
		}
	});

	// Snap the cursor onto a deep-linked thread once the list is available, so the
	// instant preview header (driven by the cursor) matches the opened thread.
	$effect(() => {
		if (!deepLinkPending || !docs.length) return;
		const id = openId;
		untrack(() => {
			const i = docs.findIndex((d) => String(d.id) === id);
			if (i >= 0) cursor = i;
			deepLinkPending = false;
		});
	});

	// Mirror the open thread into the URL (?t=) so reload and the notification
	// deep-link stay in sync. On MOBILE, opening additionally pushes a shallow
	// history entry ({threadOpen}) so the phone's back button / edge-swipe closes
	// the full-screen reader instead of leaving the app; in-app closes pop that
	// same entry so stale reader states never pile up in history.
	let pushedReader = false;
	$effect(() => {
		const id = openId;
		if (typeof history === 'undefined') return;
		untrack(() => {
			// Only touch history when something actually changes — the effect's very
			// first run (openId null, no ?t) happens BEFORE the SvelteKit router
			// initializes, where pushState/replaceState throw.
			const url = new URL(location.href);
			const current = url.searchParams.get('t');
			if (id) {
				url.searchParams.set('t', id);
				if (isMobile.current && !page.state.threadOpen) {
					pushState(url, { threadOpen: true });
					pushedReader = true;
				} else if (current !== id) {
					// Desktop, or moving thread→thread inside an already-pushed reader.
					replaceState(url, page.state);
				}
			} else if (pushedReader) {
				// In-app close (back arrow, Escape, archive-from-reader): pop our own
				// entry. The popstate effect below sees openId already null and no-ops.
				pushedReader = false;
				history.back();
			} else if (current !== null) {
				url.searchParams.delete('t');
				replaceState(url, page.state);
			}
		});
	});

	// Phone back button / edge-swipe: SvelteKit pops the shallow entry and
	// `threadOpen` drops out of page.state — close the reader to match.
	$effect(() => {
		const open = !!page.state.threadOpen;
		untrack(() => {
			if (open || !pushedReader) return;
			pushedReader = false;
			if (openId) {
				clearCommit();
				openId = null;
				focus.set('list');
			}
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

	// --- preview commit (yazi-style two-tier preview) ---
	// The thread under the cursor (`previewThread`) drives an INSTANT header/snippet
	// in the reader on every move — that repaint is free (in-memory list data). The
	// heavier work (the message query + the body iframe's network fetch, both keyed
	// on `openId`) is deferred until the cursor SETTLES, so holding ↑/↓ flies through
	// previews without touching the network. Explicit opens commit immediately.
	const previewThread = $derived(docs[cursor] ?? null);
	/** How long the cursor must rest on a row before its body loads. Short enough to
	 *  feel instant when you land, long enough that a fast scroll loads nothing. */
	const PREVIEW_SETTLE_MS = 120;
	let commitTimer: ReturnType<typeof setTimeout> | null = null;
	function clearCommit() {
		if (commitTimer) {
			clearTimeout(commitTimer);
			commitTimer = null;
		}
	}
	/** Open a thread NOW (explicit: Enter/→/click/next-thread) — cancels any pending
	 *  settle so the deferred load can't overwrite the deliberate choice. */
	function commit(id: string | null) {
		clearCommit();
		openId = id;
	}
	/** Show the cursor thread in the reading pane as a live preview, without
	 *  stealing focus (yazi-style: moving the cursor previews the "child"). The
	 *  reader only marks-read once it's actually focused, so previewing is free.
	 *  Drafts preview too (a read-only summary); Enter/→ resumes them in compose. */
	function previewCursor() {
		// No preview pane on mobile — the reader is a separate screen, so cursor
		// moves (taps, checkbox touches, post-action advances) must never open it.
		if (isMobile.current) return;
		if (!docs.length) return;
		const t = docs[cursor];
		if (!t) return;
		// The instant header already tracks `previewThread`; only defer the body load.
		const id = String(t.id);
		clearCommit();
		commitTimer = setTimeout(() => {
			commitTimer = null;
			openId = id;
		}, PREVIEW_SETTLE_MS);
	}
	// Auto preview: whenever a view's list (first) becomes available — boot AND
	// every folder switch — commit the cursor thread as a preview. Without the
	// per-view reset this only ran once, so switching folders left the reader on
	// the new first email's skeleton forever (previewCursor() only runs on cursor
	// MOVES). Within a view it stays one-shot: a null openId after boot is a
	// deliberate state (Escape closes the reader) and must stay closed.
	// The reader only marks-read once the list or reading pane holds focus, so
	// browsing folders from the rail never silently reads mail.
	let previewedView: string | null = null;
	$effect(() => {
		const v = view;
		untrack(() => {
			if (previewedView === null || previewedView === v) return;
			// Folder switched: drop the previous folder's open thread and cursor so
			// the new folder previews from its top row.
			previewedView = null;
			cursor = 0;
			selected = new Set();
			anchor = null;
			commit(null);
		});
	});
	$effect(() => {
		const v = view;
		// While the search is (re)running, `docs` can still be the PREVIOUS
		// folder's rows for a beat — committing one of those would preview the
		// wrong thread, so wait until the new query settles.
		if (results.loading || results.searching || !docs.length) return;
		untrack(() => {
			if (previewedView === v) return;
			previewedView = v;
			if (isMobile.current || openId || deepLinkPending) return;
			const t = docs[cursor] ?? docs[0];
			if (t) commit(String(t.id));
		});
	});

	// Body prefetch: opening a thread used to pay its whole chain on click — the
	// local message query, THEN the iframe's network fetch (KV-cold that means a
	// MailboxServer DO wake + an R2 read). Bodies are immutable (max-age=1y), so
	// warming the top threads' latest bodies right after the list loads turns the
	// reader's iframe load into a disk-cache hit — and warms the server's KV body
	// cache for everything else. Serial and low-priority so it never competes
	// with an actual open.
	const PREFETCH_COUNT = 8;
	const prefetched = new Set<string>();
	$effect(() => {
		const top = docs.slice(0, PREFETCH_COUNT).map((t) => String(t.id));
		untrack(() => {
			if (!top.length || isMobile.current) return;
			void prefetchBodies(top);
		});
	});
	async function prefetchBodies(thread_ids: string[]) {
		for (const tid of thread_ids) {
			if (prefetched.has(tid)) continue;
			prefetched.add(tid);
			// Latest message only — that's the one the reader expands.
			const m = await latestMessage(tid);
			if (!m?.id) continue;
			// EXACTLY the iframe's URL (scheme included) so the cache key matches.
			const url = `/api/messages/${encodeURIComponent(String(m.id))}/body?scheme=${resolvedScheme()}`;
			try {
				await fetch(url, { priority: 'low' } as RequestInit);
			} catch {
				/* prefetch is best-effort; the iframe fetch remains the source of truth */
			}
		}
	}

	/** Plain page move / next-thread step — clamps at the ends (no wrap). */
	function move(delta: number) {
		if (!docs.length) return;
		cursor = clamp(cursor + delta);
		anchor = null; // a plain move re-anchors the next Shift-range
		previewCursor();
	}
	/** Line move (j/k/↑/↓): wraps past the first/last row so you can loop around. */
	function moveLine(dir: -1 | 1) {
		if (!docs.length) return;
		const n = docs.length;
		cursor = (((cursor + dir) % n) + n) % n;
		anchor = null;
		previewCursor();
	}
	/** Jump move (Ctrl+↑/↓, ×5): clamps to the edge from the middle, but once
	 *  already AT the edge it wraps to the far end and keeps jumping from there —
	 *  so it only loops at the boundary, never mid-list. */
	function moveJump(dir: -1 | 1) {
		if (!docs.length) return;
		const n = docs.length;
		const last = n - 1;
		const STEP = 5;
		const atEdge = dir < 0 ? cursor === 0 : cursor === last;
		const target = atEdge ? (dir < 0 ? last : 0) + dir * (STEP - 1) : cursor + dir * STEP;
		cursor = clamp(target);
		anchor = null;
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
		if (extend) {
			// A growing selection doesn't wrap — extend clamps to the ends.
			const delta = dir * (kind === 'line' ? 1 : kind === 'jump' ? 5 : pageStep());
			extendTo(cursor + delta);
			return;
		}
		if (kind === 'line') moveLine(dir);
		else if (kind === 'jump') moveJump(dir);
		else move(dir * pageStep()); // page: clamp, never wrap
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
		// Commit the cursor thread NOW (even if a preview settle is still pending) so
		// → always opens exactly what's under the cursor, with no settle-delay flash.
		openCursor();
		if (openId) focus.set('reading');
	}

	/** Advance the cursor AND the open thread — next/prev without leaving the reader. */
	function stepThread(delta: number) {
		move(delta); // moves the cursor + schedules a settle-preview…
		const t = docs[cursor];
		if (t) commit(String(t.id)); // …but keep-reading opens it immediately.
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
		commit(String(t.id));
	}
	async function openDraft(t: Thread) {
		// Prefer the draft message the reader already loaded (the Drafts preview
		// mirrors it up via openMessages). The fallback `latestMessage` orders by
		// `date`, which the server-side search rejects — so relying on it alone
		// would silently fail to resume the draft.
		const loaded = openMessages.find((mm) => String(mm.thread_id) === String(t.id)) ?? null;
		const m = loaded ?? (await latestMessage(String(t.id)));
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
	// hard-delete on a single keystroke (Gmail-scope caveat).
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

	// z → snooze chord menu. The thread hides in Snoozed and the server's wake
	// job returns it to the inbox at the chosen time. The menu is a which-key
	// overlay: z z snoozes the default, z 1..6 pick presets — fast chords
	// resolve before the panel ever paints.
	function openSnooze() {
		if (targets().length) snoozing = true;
	}
	async function snoozeUntil(at: number) {
		snoozing = false;
		await act('snooze', { snooze_until: at });
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
		// blockquote the user types above.
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

	/** The thread currently shown in the reader (for the Archive/Unarchive toggle). */
	const openThread = $derived(docs.find((d) => String(d.id) === openId) ?? null);

	// `a` toggles: archive from anywhere, but un-archive (back to inbox) when the
	// target already lives in the archive — so the same key does the sensible
	// thing in the Archive folder (mirrors the reader's Archive/Unarchive button).
	function toggleArchive() {
		const t = targets()[0];
		if (t && (t.folder as string) === 'archive') void act('move', { folder: 'inbox' });
		else void act('archive');
	}

	// The inbox-zero ceremony triggers only when an ACTION empties the inbox in
	// this session — a cold-loaded empty inbox stays quiet. The action marks its
	// intent; the ceremony arms when the list actually reaches zero (the row
	// exit + local reindex land asynchronously after apply()).
	let clearedByAction = $state(false);
	let pendingClear = 0;
	$effect(() => {
		void view;
		untrack(() => {
			clearedByAction = false;
			pendingClear = 0;
		});
	});
	$effect(() => {
		const n = docs.length;
		untrack(() => {
			if (n === 0 && pendingClear && Date.now() - pendingClear < 5000) {
				clearedByAction = true;
				pendingClear = 0;
			} else if (n > 0) {
				clearedByAction = false;
			}
		});
	});

	async function act(
		action: ThreadActionName,
		opts: { folder?: string; snooze_until?: number; animate?: boolean } = {},
	) {
		const ts = targets();
		if (!ts.length) return;
		const isOut = ['archive', 'trash', 'delete', 'spam', 'move', 'snooze'].includes(action);
		const willClear = isOut && view === 'inbox' && ts.length >= docs.length;
		if (willClear) pendingClear = Date.now();
		await actions.apply(ts, action, opts);
		clearSelection();
		// Auto-advance past a removed cursor thread.
		if (isOut) {
			const removedOpen = !!openId && ts.some((t) => String(t.id) === openId);
			cursor = Math.min(cursor, Math.max(0, docs.length - 1));
			// If the thread being read was archived/trashed, slide the reader onto the
			// thread now under the cursor (previewed instantly, body settles in) rather
			// than dropping to an empty pane.
			if (removedOpen) {
				commit(null);
				previewCursor();
			}
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
			{ keys: 'a', description: 'Archive / Unarchive', group: 'Actions', context: 'list', handler: toggleArchive },
			{ keys: 'd', description: 'Trash', group: 'Actions', context: 'list', handler: () => act('trash') },
			{ keys: 'D', description: 'Delete forever', group: 'Actions', context: 'list', handler: askDelete },
			{ keys: 's', description: 'Toggle star', group: 'Actions', context: 'list', handler: () => act(starTarget()) },
			{ keys: 'u', description: 'Toggle read/unread', group: 'Actions', context: 'list', handler: () => act(readTarget()) },
			{ keys: '!', description: 'Mark spam', group: 'Actions', context: 'list', handler: () => act('spam') },
			{ keys: 'v', description: 'Move to…', group: 'Actions', context: 'list', handler: openMove },
			{ keys: 'm', description: 'Move to…', group: 'Actions', context: 'list', handler: openMove },
			{ keys: 'z', description: 'Snooze… (z z default, z 1–6 presets)', group: 'Actions', context: 'list', handler: openSnooze },
			{ keys: 'e', description: 'Unsubscribe', group: 'Actions', context: 'list', handler: () => void unsubscribeCursor() },
			{ keys: 'r', description: 'Reply', group: 'Actions', context: 'list', handler: () => reply('reply') },
			{ keys: 'R', description: 'Reply all', group: 'Actions', context: 'list', handler: () => reply('reply_all') },
			{ keys: 'w', description: 'Forward', group: 'Actions', context: 'list', handler: () => reply('forward') },
			{ keys: '/', description: 'Search', group: 'Find', context: 'list', handler: startSearch },
			{ keys: 'f', description: 'Filter loaded list', group: 'Find', context: 'list', handler: startFilter },
			{ keys: 'Escape', description: 'Close / clear', group: 'Panes', context: 'list', global: true, handler: () => {
				if (confirmingDelete) confirmingDelete = false;
				else if (moving) moving = false;
				else if (snoozing) snoozing = false;
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
			clearCommit();
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
			<button class="iconbtn m-only" onclick={() => drawer.open()} aria-label="Folders">
				<Icon name="menu" size={20} />
			</button>
			<h1>{title}</h1>
			{#if selected.size}
				<span class="selcount">{selected.size} selected</span>
			{/if}
			{#if !data.ws.connected}
				<span class="offline m-only">Offline</span>
			{/if}
			<span class="count">{docs.length}</span>
			<button class="iconbtn m-only" onclick={startSearch} aria-label="Search">
				<Icon name="search" size={20} />
			</button>
		{/if}
	</header>

	<!-- Mobile contextual selection bar: long-press starts a selection, taps grow
	     it, and the batch actions live here (the keyboard's a/d/u/s equivalents). -->
	{#if selected.size}
		<div class="selbar" role="toolbar" aria-label="Selection actions">
			<button class="iconbtn" onclick={clearSelection} aria-label="Clear selection">
				<Icon name="x" size={20} />
			</button>
			<span class="selbar-count">{selected.size} selected</span>
			<button class="iconbtn" onclick={() => act(readTarget())} aria-label="Toggle read">
				<Icon name="mail-open" size={20} />
			</button>
			<button class="iconbtn" onclick={() => act(starTarget())} aria-label="Toggle star">
				<Icon name="star" size={20} />
			</button>
			<button class="iconbtn" onclick={toggleArchive} aria-label="Archive">
				<Icon name="archive" size={20} />
			</button>
			<button class="iconbtn" onclick={() => act('trash')} aria-label="Trash">
				<Icon name="trash" size={20} />
			</button>
		</div>
	{/if}

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
	{#if snoozing}
		<SnoozeChordMenu
			count={targets().length}
			onPick={(at) => void snoozeUntil(at)}
			onClose={() => (snoozing = false)} />
	{/if}

	<div class="list-body">
		<ThreadList
			docs={docs}
			{cursor}
			{selected}
			{density}
			{view}
			celebrate={clearedByAction}
			leaving={actions.leaving}
			loading={results.loading || (docs.length === 0 && !db.synced)}
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
			selecting={isMobile.current && selected.size > 0}
			onLongPress={(i) => {
				cursor = i;
				anchor = null;
				toggleSelect();
			}}
			onSwipe={(i, dir) => {
				cursor = i;
				anchor = null;
				// Swipes earn the exit slide (the gesture set the row in motion);
				// keyboard/toolbar actions skip it so the next thread appears instantly.
				void act(dir === 'archive' ? 'archive' : readTarget(), { animate: true });
			}} />
	</div>
</section>

<div
	class="reading-pane pane"
	class:active={focus.is('reading')}
	class:mobile-open={!!openId}
	bind:this={readingEl}
	onmousedowncapture={() => openId && focus.set('reading')}>
	<ReadingPane
		{db}
		threadId={openId}
		{previewThread}
		folder={((previewThread?.folder ?? openThread?.folder) as string | undefined) ?? null}
		markReadActive={focus.is('list') || focus.is('reading')}
		onDocs={(m) => (openMessages = m)}
		onReply={reply}
		onAct={act}
		onBack={() => {
			commit(null);
			focus.set('list');
		}}
		onEditDraft={() => openThread && void openDraft(openThread)} />
</div>

<!-- Mobile reader action bar: thumb-reachable stand-ins for r/R/w/a/d and [/]. -->
{#if openId}
	<div class="reader-bar" role="toolbar" aria-label="Conversation actions">
		<button class="iconbtn" onclick={() => stepThread(-1)} aria-label="Previous conversation">
			<Icon name="chevron-left" size={22} />
		</button>
		<button class="iconbtn" onclick={() => reply('reply')} aria-label="Reply">
			<Icon name="reply" size={22} />
		</button>
		<button class="iconbtn" onclick={() => reply('reply_all')} aria-label="Reply all">
			<Icon name="reply-all" size={22} />
		</button>
		<button class="iconbtn" onclick={() => reply('forward')} aria-label="Forward">
			<Icon name="forward" size={22} />
		</button>
		<button class="iconbtn" onclick={toggleArchive} aria-label={openThread?.folder === 'archive' ? 'Unarchive' : 'Archive'}>
			<Icon name={openThread?.folder === 'archive' ? 'inbox' : 'archive'} size={22} />
		</button>
		<button class="iconbtn" onclick={() => act('trash')} aria-label="Trash">
			<Icon name="trash" size={22} />
		</button>
		<button class="iconbtn" onclick={() => stepThread(1)} aria-label="Next conversation">
			<Icon name="chevron-right" size={22} />
		</button>
	</div>
{/if}

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
	/* One live cursor at a time (vim-split style): when the list pane doesn't
	   hold focus, its cursor row dims to a ghost bar so "where am I" always has
	   exactly one answer. */
	.pane:not(.active) :global(.row.cursor) {
		background: transparent;
		box-shadow: inset 3px 0 0 color-mix(in oklab, var(--dm-cursor-bar) 35%, transparent);
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
		overscroll-behavior-y: contain;
	}

	/* Shared touch-target icon button (header, selection bar, reader bar). */
	.iconbtn {
		display: grid;
		place-items: center;
		width: 42px;
		height: 42px;
		border: none;
		border-radius: var(--radius-md);
		background: none;
		color: var(--color-text-muted, var(--color-text-disabled));
		cursor: pointer;
		flex-shrink: 0;
	}
	.iconbtn:active {
		background: var(--color-bg-3);
	}
	/* Mobile-only chrome: hidden wherever the keyboard is the interface. */
	.m-only,
	.selbar,
	.reader-bar {
		display: none;
	}
	.offline {
		font-size: var(--font-size-00);
		font-weight: var(--font-weight-semibold, 600);
		color: var(--color-warning, #b25d09);
	}

	@media (max-width: 767px) {
		.list-pane {
			width: 100%;
			border-right: none;
		}
		.m-only {
			display: grid;
		}
		span.m-only {
			display: inline;
		}
		.list-head {
			padding-top: calc(var(--space-2) + env(safe-area-inset-top));
		}
		/* Contextual selection bar (long-press → select → batch actions). */
		.selbar {
			display: flex;
			align-items: center;
			gap: var(--space-1);
			padding: var(--space-1) var(--space-2);
			border-bottom: 1px solid var(--color-border);
			background: var(--dm-accent-soft);
		}
		.selbar-count {
			flex: 1;
			min-width: 0;
			font-size: var(--font-size-0);
			font-weight: var(--font-weight-medium, 500);
			color: var(--color-primary);
		}
		/* The reader is its own screen: fixed over the list, opaque, above the FAB
		   (z 90) and below the drawer (z 400) / modals (401+). */
		.reading-pane {
			display: none;
		}
		.reading-pane.mobile-open {
			display: block;
			position: fixed;
			inset: 0;
			z-index: 120;
			background: var(--color-bg-1);
			padding-top: env(safe-area-inset-top);
			/* Keep the last message clear of the fixed action bar below. */
			padding-bottom: calc(56px + env(safe-area-inset-bottom));
		}
		.reader-bar {
			display: flex;
			align-items: center;
			justify-content: space-between;
			position: fixed;
			inset: auto 0 0 0;
			z-index: 130;
			height: calc(56px + env(safe-area-inset-bottom));
			padding: 0 var(--space-2) env(safe-area-inset-bottom);
			background: var(--color-bg-2);
			border-top: 1px solid var(--color-border);
		}
		/* iOS zooms any focused input under 16px — pin the find bars above it. */
		.searchbar :global(.findbar-input input),
		.filterbar :global(.findbar-input input) {
			font-size: 16px;
		}
	}
</style>
