<script lang="ts">
	import { Avatar } from '@delightstack/components';
	import type { Thread } from '$lib/schema';

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
		/** Mobile swipe: right = archive, left = trash. */
		onSwipe?: (index: number, dir: 'archive' | 'trash') => void;
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
	}: Props = $props();

	// --- touch swipe (mobile) ---
	let swipeStartX = 0;
	let swipeIndex = -1;
	const SWIPE_THRESHOLD = 64;
	function onTouchStart(e: TouchEvent, index: number) {
		swipeStartX = e.touches[0].clientX;
		swipeIndex = index;
	}
	function onTouchEnd(e: TouchEvent) {
		if (swipeIndex < 0 || !onSwipe) return;
		const dx = e.changedTouches[0].clientX - swipeStartX;
		if (dx > SWIPE_THRESHOLD) onSwipe(swipeIndex, 'archive');
		else if (dx < -SWIPE_THRESHOLD) onSwipe(swipeIndex, 'trash');
		swipeIndex = -1;
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
	function sender(t: Thread): string {
		return t.participant_text || t.subject || '(no sender)';
	}
</script>

<div
	class="viewport"
	bind:this={viewport}
	bind:clientHeight={height}
	onscroll={onScroll}
	role="listbox"
	tabindex="-1"
	aria-label="Threads">
	<div class="spacer" style:height="{total * ROW_H}px">
		<div class="rows" style:transform="translateY({start * ROW_H}px)">
			{#each slice as t, i (t.id)}
				{@const index = start + i}
				{@const isSel = selected.has(String(t.id))}
				<div
					class="row"
					class:unread={t.unread_count > 0}
					class:cursor={index === cursor}
					class:selected={isSel}
					class:compact={density === 'compact'}
					style:height="{ROW_H}px"
					role="option"
					aria-selected={index === cursor}
					ontouchstart={(e) => onTouchStart(e, index)}
					ontouchend={onTouchEnd}
					onclick={() => {
						onCursor(index);
						onOpen(index);
					}}>
					<div class="lead">
						<span class="av"><Avatar name={sender(t)} size={density === 'compact' ? '0' : '1'} /></span>
						<button
							class="check"
							class:on={isSel}
							aria-label={isSel ? 'Deselect' : 'Select'}
							aria-pressed={isSel}
							onclick={(e) => {
								e.stopPropagation();
								onCursor(index);
								onToggleSelect?.(index);
							}}>
							<span class="tick" aria-hidden="true">✓</span>
						</button>
					</div>
					<div class="body">
						<div class="line1">
							{#if t.unread_count > 0}<span class="udot" aria-hidden="true"></span>{/if}
							<span class="from">{sender(t)}</span>
							{#if t.has_attachments}<span class="clip" aria-hidden="true">📎</span>{/if}
							{#if t.starred}<span class="star" aria-hidden="true">★</span>{/if}
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
			{/each}
		</div>
	</div>
	{#if total === 0}
		<div class="empty">
			{#if loading}
				<span class="empty-title">Loading…</span>
			{:else}
				<span class="empty-mark" aria-hidden="true">✦</span>
				<span class="empty-title">All clear</span>
				<span class="empty-sub">Nothing here right now.</span>
			{/if}
		</div>
	{/if}
</div>

<style>
	.viewport {
		height: 100%;
		overflow-y: auto;
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
		display: flex;
		align-items: center;
		gap: var(--space-3);
		padding: 0 var(--space-3);
		border-bottom: 1px solid var(--dm-hairline);
		cursor: pointer;
		overflow: hidden;
	}
	.row:hover {
		background: var(--color-bg-2);
	}
	.row.cursor {
		background: var(--dm-cursor-bg);
		box-shadow: inset 2px 0 0 var(--dm-cursor-bar);
	}
	.row.selected {
		background: var(--dm-selection-bg);
	}
	.row.cursor.selected {
		background: color-mix(in oklab, var(--dm-selection-bg), var(--dm-cursor-bg));
	}

	/* Leading control: avatar by default, a selection tick on hover / when picked. */
	.lead {
		position: relative;
		flex-shrink: 0;
		display: grid;
		place-items: center;
	}
	.av {
		display: block;
		transition: opacity var(--duration-fast, 120ms) ease;
	}
	.check {
		position: absolute;
		inset: 0;
		display: grid;
		place-items: center;
		border: none;
		background: none;
		padding: 0;
		cursor: pointer;
		opacity: 0;
	}
	.tick {
		display: grid;
		place-items: center;
		width: 22px;
		height: 22px;
		border-radius: 50%;
		border: 1.5px solid var(--color-border);
		color: transparent;
		font-size: 0.7rem;
		background: var(--color-bg-1);
	}
	.row:hover .check,
	.row.selected .check {
		opacity: 1;
	}
	.row:hover .av,
	.row.selected .av {
		opacity: 0;
	}
	.row.selected .tick {
		background: var(--color-primary);
		border-color: var(--color-primary);
		color: white;
	}

	.body {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 1px;
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
	.row.unread .from {
		font-weight: var(--font-weight-semibold, 600);
		color: var(--color-text);
	}
	.clip {
		font-size: 0.72em;
		opacity: 0.7;
		flex-shrink: 0;
	}
	.star {
		color: var(--color-warning);
		flex-shrink: 0;
	}
	.time {
		margin-left: auto;
		flex-shrink: 0;
		color: var(--color-text-disabled);
		font-variant-numeric: tabular-nums;
		font-size: var(--font-size-00);
	}
	.line2 {
		display: flex;
		align-items: baseline;
		gap: 6px;
		font-size: var(--font-size-00);
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
		font-weight: var(--font-weight-medium, 500);
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
		font-size: 1.6rem;
		opacity: 0.5;
	}
	.empty-title {
		font-size: var(--font-size-1);
		color: var(--color-text);
	}
	.empty-sub {
		font-size: var(--font-size-0);
	}
</style>
