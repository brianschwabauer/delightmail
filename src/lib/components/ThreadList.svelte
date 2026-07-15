<script lang="ts">
	import { Avatar, Checkbox } from '@delightstack/components';
	import { ripple } from '@delightstack/utilities';
	import Icon from './Icon.svelte';
	import { contactAvatarUrl } from '$lib/mail/avatar';
	import { threadSenderLabel, threadParticipants } from '$lib/mail/participants';
	import { useScope } from '$lib/mail/scope.svelte';
	import type { Thread } from '$lib/schema';

	const scope = useScope();

	interface Props {
		docs: Thread[];
		cursor: number;
		selected: Set<string>;
		density?: 'comfortable' | 'compact';
		loading?: boolean;
		onOpen: (index: number) => void;
		onCursor: (index: number) => void;
		onToggleSelect?: (index: number) => void;
		/** Reports how many rows fit the viewport — drives PageUp/PageDown paging. */
		onRows?: (rows: number) => void;
		/** Mobile swipe: right = archive, left = toggle read/unread. */
		onSwipe?: (index: number, dir: 'archive' | 'read') => void;
		/** Mobile long-press on a row — starts/extends a selection. */
		onLongPress?: (index: number) => void;
		/** Mobile selection mode (a selection exists): every row shows its checkbox
		 *  and a plain tap TOGGLES instead of opening; swipes are disabled. */
		selecting?: boolean;
		/** Rows playing their exit animation (archived/trashed, about to leave). */
		leaving?: Set<string>;
		/** The current view — drives the per-folder empty-state copy. */
		view?: string;
		/** The user just cleared the last inbox thread THIS session — the empty
		 *  state earns a small ceremony instead of appearing cold. */
		celebrate?: boolean;
	}
	let {
		docs,
		cursor,
		selected,
		density = 'comfortable',
		loading = false,
		onOpen,
		onCursor,
		onToggleSelect,
		onRows,
		onSwipe,
		onLongPress,
		selecting = false,
		leaving = new Set(),
		view = 'inbox',
		celebrate = false,
	}: Props = $props();

	// Ten minutes of copywriting is the cheapest personality an app can buy.
	const EMPTY_COPY: Record<string, { title: string; sub: string }> = {
		inbox: { title: 'Inbox zero', sub: 'Nothing needs you.' },
		filtered: { title: 'The filter is holding', sub: 'Nothing quarantined for review.' },
		starred: { title: 'No stars', sub: 'Press s on anything worth keeping close.' },
		snoozed: { title: 'Nothing sleeping', sub: 'b snoozes a thread until it matters.' },
		sent: { title: 'Nothing sent yet', sub: 'c starts a message.' },
		drafts: { title: 'Nothing half-written', sub: 'Drafts autosave as you type.' },
		archive: { title: 'The archive is empty', sub: 'e files things away, out of sight.' },
		spam: { title: 'No spam', sub: 'As it should be.' },
		trash: { title: 'Empty', sub: 'As it should be.' },
		search: { title: 'No matches', sub: 'Try from:, has:attachment, is:unread…' },
	};
	const empty = $derived(EMPTY_COPY[view] ?? { title: 'All clear', sub: 'Nothing here right now.' });
	// A quiet moment of ceremony for the celebratory case only.
	const ZERO_LINES = ['All clear.', 'Nothing needs you.', 'Enjoy the quiet.', 'Go touch grass.'];
	const zeroLine = ZERO_LINES[new Date().getDate() % ZERO_LINES.length];

	// --- touch gestures (mobile): swipe-to-act + long-press-to-select ---
	// One gesture at a time. Its axis is decided by the FIRST dominant movement:
	// vertical hands off to native scrolling (touch-action: pan-y), horizontal
	// turns into a tracked swipe — the row follows the finger over a colored
	// underlay and commits at the threshold. A still finger long-presses.
	const SWIPE_COMMIT = 72; // px of horizontal travel that commits the action
	const SWIPE_MAX = 112; // px cap — the row resists past the commit point
	const AXIS_LOCK = 8; // px of travel before the gesture picks an axis
	const LONG_PRESS_MS = 450;
	let gesture: {
		index: number;
		x0: number;
		y0: number;
		axis: 'h' | 'v' | null;
		longTimer: ReturnType<typeof setTimeout> | null;
		consumed: boolean; // long-press fired or swipe committed → swallow the tap
	} | null = null;
	/** The row being dragged and how far — drives the transform + underlay. */
	let swipe = $state<{ index: number; dx: number } | null>(null);
	/** Whether the row is animating back/away (transition on, finger up). */
	let swipeSettling = $state(false);

	function cancelLongPress() {
		if (gesture?.longTimer) {
			clearTimeout(gesture.longTimer);
			gesture.longTimer = null;
		}
	}
	function onTouchStart(e: TouchEvent, index: number) {
		const t = e.touches[0];
		gesture = { index, x0: t.clientX, y0: t.clientY, axis: null, longTimer: null, consumed: false };
		swipeSettling = false;
		if (onLongPress && !selecting) {
			gesture.longTimer = setTimeout(() => {
				if (!gesture || gesture.axis !== null) return;
				gesture.consumed = true;
				navigator.vibrate?.(10);
				onLongPress(index);
			}, LONG_PRESS_MS);
		}
	}
	function onTouchMove(e: TouchEvent) {
		if (!gesture) return;
		const t = e.touches[0];
		const dx = t.clientX - gesture.x0;
		const dy = t.clientY - gesture.y0;
		if (gesture.axis === null) {
			if (Math.abs(dx) < AXIS_LOCK && Math.abs(dy) < AXIS_LOCK) return;
			cancelLongPress();
			gesture.axis = Math.abs(dx) > Math.abs(dy) * 1.2 && onSwipe && !selecting ? 'h' : 'v';
		}
		if (gesture.axis !== 'h') return;
		// Resist past the commit point: full travel up to the threshold, then 1/3.
		const abs = Math.abs(dx);
		// The finger should FEEL the commitment point, not just see the underlay
		// pop — one 8ms tick exactly when the swipe arms (and again if it re-arms).
		const wasArmed = Math.abs(swipe?.index === gesture.index ? (swipe?.dx ?? 0) : 0) >= SWIPE_COMMIT;
		if (!wasArmed && abs >= SWIPE_COMMIT) navigator.vibrate?.(8);
		const eased = abs <= SWIPE_COMMIT ? abs : SWIPE_COMMIT + (abs - SWIPE_COMMIT) / 3;
		swipe = { index: gesture.index, dx: Math.sign(dx) * Math.min(eased, SWIPE_MAX) };
	}
	function onTouchEnd(e: TouchEvent) {
		if (!gesture) return;
		const g = gesture;
		gesture = null;
		cancelLongPress();
		if (g.consumed) {
			// Long-press already handled this touch — don't let it also click-open.
			e.preventDefault();
			return;
		}
		if (g.axis !== 'h' || !swipe) return;
		e.preventDefault(); // a swipe never opens the row
		const commit = Math.abs(swipe.dx) >= SWIPE_COMMIT;
		if (commit) onSwipe?.(g.index, swipe.dx > 0 ? 'archive' : 'read');
		// Snap back (the archived row also vanishes from docs, so no fly-out needed).
		swipeSettling = true;
		swipe = { index: g.index, dx: 0 };
		setTimeout(() => {
			swipe = null;
			swipeSettling = false;
		}, 200);
	}
	function onTouchCancel() {
		cancelLongPress();
		gesture = null;
		swipe = null;
		swipeSettling = false;
	}

	const ROW_H = $derived(density === 'compact' ? 48 : 68);
	const OVERSCAN = 20;

	let viewport = $state<HTMLDivElement>();
	let scrollTop = $state(0);
	let height = $state(600);

	const total = $derived(docs.length);
	const start = $derived(Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN));
	const visibleCount = $derived(Math.ceil(height / ROW_H) + OVERSCAN * 2);
	const end = $derived(Math.min(total, start + visibleCount));
	const slice = $derived(docs.slice(start, end));

	function onScroll() {
		if (viewport) scrollTop = viewport.scrollTop;
	}

	// Report the number of fully-visible rows so the page can page by a screenful.
	$effect(() => {
		onRows?.(Math.max(1, Math.floor(height / ROW_H)));
	});

	// Keep the keyboard cursor row visible.
	$effect(() => {
		if (!viewport || cursor < 0) return;
		const top = cursor * ROW_H;
		const bottom = top + ROW_H;
		if (top < viewport.scrollTop) viewport.scrollTop = top;
		else if (bottom > viewport.scrollTop + viewport.clientHeight) {
			viewport.scrollTop = bottom - viewport.clientHeight;
		}
	});

	function fmtTime(ts: number): string {
		if (!ts) return '';
		const d = new Date(ts);
		const now = new Date();
		const sameDay = d.toDateString() === now.toDateString();
		if (sameDay) return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
		const yst = new Date(now);
		yst.setDate(now.getDate() - 1);
		if (d.toDateString() === yst.toDateString()) return 'Yesterday';
		if (now.getTime() - ts < 7 * 864e5) return d.toLocaleDateString(undefined, { weekday: 'short' });
		return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
	}
	// `participant_text` is the search blob ("Name email, Name email"), not a label —
	// name the other people on the thread, leaving the user out.
	function sender(t: Thread): string {
		const label = threadSenderLabel(t, {
			emails: scope.selfEmails,
			domains: scope.selfDomains,
		});
		return label || t.subject || '(no sender)';
	}
	// participants[0] is the message's `from` (ingest pushes it first), so it's
	// the sender whose favicon/Gravatar we want on the row.
	function senderAvatar(t: Thread): string | undefined {
		return contactAvatarUrl(threadParticipants(t)[0]?.email ?? undefined);
	}
</script>

<div
	class="viewport"
	class:selecting
	bind:this={viewport}
	bind:clientHeight={height}
	onscroll={onScroll}
	role="listbox"
	tabindex="-1"
	aria-label="Threads"
	aria-multiselectable="true">
	<div class="spacer" style:height="{total * ROW_H}px">
		<div class="rows" style:transform="translateY({start * ROW_H}px)">
			{#each slice as t, i (t.id)}
				{@const index = start + i}
				{@const isSel = selected.has(String(t.id))}
				{@const dx = swipe?.index === index ? swipe.dx : 0}
				<div
					class="row"
					class:unread={t.unread_count > 0}
					class:cursor={index === cursor}
					class:selected={isSel}
					class:compact={density === 'compact'}
					class:swiping={dx !== 0}
					class:settling={swipeSettling && swipe?.index === index}
					class:leaving={leaving.has(String(t.id))}
					style:height="{ROW_H}px"
					role="option"
					aria-selected={index === cursor}
					ontouchstart={(e) => onTouchStart(e, index)}
					ontouchmove={onTouchMove}
					ontouchend={onTouchEnd}
					ontouchcancel={onTouchCancel}
					onclick={() => {
						onCursor(index);
						// In mobile selection mode a tap toggles membership; it never opens.
						if (selecting && onToggleSelect) onToggleSelect(index);
						else onOpen(index);
					}}
					{@attach ripple({ opacity: 0.07 })}>
					{#if dx !== 0}
						<div
							class="swipe-under"
							class:fwd={dx > 0}
							class:armed={Math.abs(dx) >= 72}
							aria-hidden="true">
							<Icon name={dx > 0 ? 'archive' : t.unread_count > 0 ? 'mail-open' : 'mail'} size={20} />
						</div>
					{/if}
					<div class="row-slide" style:transform="translateX({dx}px)">
					<div class="lead">
						<span class="av"><Avatar name={sender(t)} src={senderAvatar(t)} size={density === 'compact' ? '0' : '1'} /></span>
						<!-- Selection uses the real delightstack Checkbox (its own check/uncheck
						     animation). Wrapping span stops the click from opening the thread. -->
						<!-- svelte-ignore a11y_click_events_have_key_events -->
						<!-- svelte-ignore a11y_no_static_element_interactions -->
						<span class="check" onclick={(e) => e.stopPropagation()}>
							<Checkbox
								checked={isSel}
								size={density === 'compact' ? '0' : '1'}
								onchange={() => {
									onCursor(index);
									onToggleSelect?.(index);
								}} />
						</span>
					</div>
					<div class="body">
						<div class="line1">
							{#if t.unread_count > 0}<span class="udot" aria-hidden="true"></span>{/if}
							<span class="from">{sender(t)}</span>
							{#if t.has_attachments}<span class="clip" aria-hidden="true"><Icon name="paperclip" size={12} /></span>{/if}
							{#if t.starred}<span class="star" aria-hidden="true"><Icon name="star" size={12} fill /></span>{/if}
							<span class="time">{fmtTime(t.last_message_at)}</span>
						</div>
						<div class="line2">
							<span class="subject">{t.subject || '(no subject)'}</span>
							{#if !density || density === 'comfortable'}
								{#if t.snippet}<span class="snippet">— {t.snippet}</span>{/if}
							{/if}
							{#if t.message_count > 1}<span class="count">{t.message_count}</span>{/if}
						</div>
					</div>
					</div>
				</div>
			{/each}
		</div>
	</div>
	{#if total === 0}
		{#if loading}
			<!-- Skeleton rows, not a string: the shape of the list arrives before
			     its content, so the paint never "jumps" from a label to rows. -->
			<div class="skeleton-rows" aria-hidden="true">
				{#each { length: 6 } as _, i (i)}
					<div class="sk-row" style:height="{ROW_H}px" style:opacity={1 - i * 0.13}>
						<span class="sk-avatar"></span>
						<span class="sk-lines">
							<span class="sk-bar" style:width="{38 + ((i * 13) % 28)}%"></span>
							<span class="sk-bar dim" style:width="{58 + ((i * 19) % 34)}%"></span>
						</span>
					</div>
				{/each}
			</div>
		{:else}
			<div class="empty" class:celebrate>
				<span class="empty-mark" aria-hidden="true"><Icon name="sparkles" size={34} stroke={1.5} /></span>
				<span class="empty-title">{celebrate ? zeroLine : empty.title}</span>
				<span class="empty-sub">{celebrate ? 'Inbox zero — you earned it.' : empty.sub}</span>
			</div>
		{/if}
	{/if}
</div>

<style>
	.viewport {
		height: 100%;
		overflow-y: auto;
		overscroll-behavior-y: contain;
		outline: none;
	}
	.spacer {
		position: relative;
	}
	.rows {
		position: absolute;
		inset: 0 0 auto 0;
	}
	.row {
		position: relative;
		border-bottom: 1px solid var(--dm-hairline);
		cursor: pointer;
		overflow: hidden;
		/* Vertical pans stay native scrolling; horizontal travel is ours (swipe). */
		touch-action: pan-y;
	}
	/* The row's visible content, which follows the finger during a swipe. */
	.row-slide {
		position: relative;
		z-index: 1;
		display: flex;
		align-items: center;
		gap: var(--space-3);
		padding: 0 var(--space-3);
		height: 100%;
	}
	/* While sliding, the content needs an opaque back so the underlay only shows
	   in the gap it opens up; when settling (finger up) it animates home. */
	.row.swiping .row-slide {
		background: var(--color-bg-1);
	}
	.row.settling .row-slide {
		transition: transform 180ms var(--ease-out, ease);
	}
	/* The action revealed beneath a swiped row: archive (→, success-tinted) on the
	   left edge, read-toggle (←, accent-tinted) on the right. `armed` marks the
	   commit threshold — the background saturates and the glyph pops. */
	.swipe-under {
		position: absolute;
		inset: 0;
		z-index: 0;
		display: flex;
		align-items: center;
		justify-content: flex-end;
		padding: 0 var(--space-4);
		color: var(--color-primary);
		background: color-mix(in oklab, var(--color-primary) 14%, var(--color-bg-1));
	}
	.swipe-under.fwd {
		justify-content: flex-start;
		color: var(--color-success, #1a7f4b);
		background: color-mix(in oklab, var(--color-success, #1a7f4b) 14%, var(--color-bg-1));
	}
	.swipe-under :global(svg) {
		transition: transform 120ms var(--ease-out, ease);
	}
	.swipe-under.armed :global(svg) {
		transform: scale(1.25);
	}
	.swipe-under.armed {
		background: color-mix(in oklab, var(--color-primary) 28%, var(--color-bg-1));
	}
	.swipe-under.armed.fwd {
		background: color-mix(in oklab, var(--color-success, #1a7f4b) 28%, var(--color-bg-1));
	}
	/* Hover "trail": the tint snaps in instantly on hover and fades back out when
	   the pointer leaves (matching delightstack's List rows), so sweeping the
	   list leaves a soft, decaying trail of where you've been. Kept as an overlay
	   above the cursor/selected backgrounds and below the row content. */
	.row::before {
		content: '';
		position: absolute;
		inset: 0;
		background: var(--color-text);
		opacity: 0;
		pointer-events: none;
		transition: opacity 300ms var(--ease-out, ease);
		z-index: 1;
	}
	.row:hover::before {
		opacity: 0.06;
		transition-duration: 0ms;
	}
	.row.cursor {
		background: var(--dm-cursor-bg);
		box-shadow: inset 3px 0 0 var(--dm-cursor-bar);
	}
	/* Archive/trash exit: the row slides toward where it's going instead of
	   blinking out. ActionManager holds the doc in place for the duration. */
	.row.leaving {
		transform: translateX(32px);
		opacity: 0;
		transition:
			transform 160ms var(--ease-out, ease),
			opacity 160ms var(--ease-out, ease);
		pointer-events: none;
	}
	.row.selected {
		background: var(--dm-selection-bg);
	}
	.row.cursor.selected {
		background: color-mix(in oklab, var(--dm-selection-bg), var(--dm-cursor-bg));
	}

	/* Leading control: the avatar by default; on hover / when selected it swaps to
	   the delightstack Checkbox (which owns the check/uncheck animation). */
	.lead {
		position: relative;
		z-index: 2;
		flex-shrink: 0;
		display: grid;
		place-items: center;
	}
	.av {
		display: block;
		transition: opacity var(--duration-fast, 120ms) ease;
	}
	/* Favicons/logos ship as small, often-transparent square glyphs. Give the
	   avatar image a neutral backdrop and `contain` it with a hair of inset so
	   the whole mark shows inside the circle instead of being cropped by the
	   default `cover`. Gravatars are square photos, so they fill it cleanly too. */
	.av :global(.avatar img) {
		background: var(--color-bg-3);
		object-fit: contain;
		padding: 3px;
		box-sizing: border-box;
	}
	.check {
		position: absolute;
		inset: 0;
		/* The Checkbox's hit-target (indicator + 20px padding) is BIGGER than the
		   avatar box it overlays, in both axes. `place-items` centers it within its
		   grid track; `place-content` then centers that oversized track within the
		   box, so the check lands dead-center on the avatar. (Flex mis-centers here:
		   the checkbox flex-shrinks to the box width and its rigid inner indicator
		   overflows to one side. Grid items don't shrink, so this holds.) */
		display: grid;
		place-items: center;
		place-content: center;
		opacity: 0;
		pointer-events: none;
		transition: opacity var(--duration-fast, 120ms) ease;
	}
	.row:hover .check,
	.row.selected .check,
	.selecting .check {
		opacity: 1;
		pointer-events: auto;
	}
	.row:hover .av,
	.row.selected .av,
	.selecting .av {
		opacity: 0;
	}

	.body {
		position: relative;
		z-index: 2;
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 3px;
	}
	.line1 {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: var(--font-size-0);
	}
	.udot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--color-primary);
		flex-shrink: 0;
	}
	.from {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--color-text-muted, var(--color-text-disabled));
	}
	/* Unread: the SUBJECT carries the weight (it's what you triage by); the
	   sender just steps up to full-strength text. */
	.row.unread .from {
		font-weight: var(--font-weight-medium, 500);
		color: var(--color-text);
	}
	.clip {
		display: inline-flex;
		align-items: center;
		color: var(--color-text-disabled);
		flex-shrink: 0;
	}
	.star {
		display: inline-flex;
		align-items: center;
		color: var(--color-warning);
		flex-shrink: 0;
	}
	.time {
		margin-left: auto;
		flex-shrink: 0;
		color: var(--color-text-disabled);
		font-variant-numeric: tabular-nums;
		font-size: 0.72rem;
	}
	/* The subject line is what you scan — it was 0.65rem (~10.4px), below any
	   legibility floor while the sender sat above it. */
	.line2 {
		display: flex;
		align-items: baseline;
		gap: 6px;
		font-size: var(--font-size-0);
		color: var(--color-text-disabled);
		min-width: 0;
	}
	.subject {
		flex-shrink: 0;
		max-width: 60%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--color-text-muted, var(--color-text-disabled));
	}
	.row.unread .subject {
		color: var(--color-text);
		font-weight: var(--font-weight-semibold, 600);
	}
	.snippet {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.count {
		margin-left: auto;
		flex-shrink: 0;
		background: var(--color-bg-3);
		border-radius: var(--radius-cap, 99px);
		padding: 0 7px;
		font-variant-numeric: tabular-nums;
		color: var(--color-text-muted, var(--color-text-disabled));
	}
	.compact .line2 .snippet {
		display: none;
	}

	.empty {
		position: absolute;
		inset: 0;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 4px;
		color: var(--color-text-disabled);
		text-align: center;
		padding: var(--space-6);
	}
	.empty-mark {
		display: inline-flex;
		color: var(--color-primary);
		opacity: 0.6;
	}
	/* The inbox-zero ceremony: only when the LAST inbox thread was cleared this
	   session — never on a cold load. A barely-there radial wash blooms and the
	   sparkles pop once. Earned, then quiet. */
	.empty.celebrate::before {
		content: '';
		position: absolute;
		inset: 0;
		background: radial-gradient(
			circle at 50% 42%,
			color-mix(in oklab, var(--color-primary) 10%, transparent),
			transparent 55%
		);
		animation: zero-wash 900ms var(--ease-out, ease) both;
		pointer-events: none;
	}
	.empty.celebrate .empty-mark {
		opacity: 1;
		animation: zero-pop 500ms var(--ease-spring, cubic-bezier(0.2, 1.4, 0.4, 1)) both;
	}
	.empty.celebrate .empty-title {
		color: var(--color-text);
	}
	@keyframes zero-pop {
		from {
			transform: scale(0.4) rotate(-12deg);
			opacity: 0;
		}
		to {
			transform: scale(1) rotate(0);
			opacity: 1;
		}
	}
	@keyframes zero-wash {
		from {
			opacity: 0;
		}
		30% {
			opacity: 1;
		}
		to {
			opacity: 0.5;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.empty.celebrate::before,
		.empty.celebrate .empty-mark {
			animation: none;
		}
	}

	/* Loading skeleton rows */
	.skeleton-rows {
		position: absolute;
		inset: 0;
		overflow: hidden;
	}
	.sk-row {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		padding: 0 var(--space-3);
	}
	.sk-avatar {
		width: 32px;
		height: 32px;
		border-radius: 50%;
		background: var(--color-bg-3, var(--color-bg-2));
		flex-shrink: 0;
	}
	.sk-lines {
		flex: 1;
		display: flex;
		flex-direction: column;
		gap: 7px;
	}
	.sk-bar {
		height: 0.7em;
		border-radius: var(--radius-sm, 4px);
		background: var(--color-bg-3, var(--color-bg-2));
	}
	.sk-bar.dim {
		opacity: 0.6;
	}
	.empty-title {
		font-size: var(--font-size-1);
		color: var(--color-text);
	}
	.empty-sub {
		font-size: var(--font-size-0);
	}
</style>
