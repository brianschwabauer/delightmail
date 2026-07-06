<script lang="ts">
	import type { Thread } from '$lib/schema';

	interface Props {
		docs: Thread[];
		cursor: number;
		selected: Set<string>;
		density?: 'comfortable' | 'compact';
		loading?: boolean;
		onOpen: (index: number) => void;
		onCursor: (index: number) => void;
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

	const ROW_H = $derived(density === 'compact' ? 44 : 60);
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
				<div
					class="row"
					class:unread={t.unread_count > 0}
					class:cursor={index === cursor}
					class:selected={selected.has(t.id)}
					style:height="{ROW_H}px"
					role="option"
					aria-selected={index === cursor}
					ontouchstart={(e) => onTouchStart(e, index)}
					ontouchend={onTouchEnd}
					onclick={() => {
						onCursor(index);
						onOpen(index);
					}}>
					<div class="line1">
						<span class="from">{t.participant_text || t.subject || '(no sender)'}</span>
						<span class="time">{fmtTime(t.last_message_at)}</span>
					</div>
					<div class="line2">
						{#if t.starred}<span class="star">★</span>{/if}
						<span class="subject">{t.subject || '(no subject)'}</span>
						{#if t.message_count > 1}<span class="count">{t.message_count}</span>{/if}
					</div>
				</div>
			{/each}
		</div>
	</div>
	{#if total === 0}
		<div class="empty">
			{#if loading}Loading…{:else}Nothing here.{/if}
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
		padding: 6px 12px;
		border-bottom: 1px solid var(--color-outline);
		cursor: pointer;
		display: flex;
		flex-direction: column;
		justify-content: center;
		gap: 2px;
		overflow: hidden;
	}
	.row.cursor {
		box-shadow: inset 2px 0 0 var(--color-primary);
		background: var(--color-bg-2);
	}
	.row.selected {
		background: color-mix(in oklch, var(--color-primary) 14%, transparent);
	}
	.line1 {
		display: flex;
		justify-content: space-between;
		gap: 8px;
		font-size: var(--font-size-0);
	}
	.row.unread .from {
		font-weight: 700;
	}
	.from {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.time {
		flex-shrink: 0;
		color: var(--color-text-disabled);
		font-variant-numeric: tabular-nums;
		font-size: var(--font-size-00, 0.72rem);
	}
	.line2 {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: var(--font-size-00, 0.78rem);
		color: var(--color-text-disabled);
	}
	.row.unread .subject {
		color: var(--color-text);
	}
	.subject {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.star {
		color: var(--color-warning, #e5a13d);
	}
	.count {
		margin-left: auto;
		background: var(--color-bg-3, var(--color-bg-2));
		border-radius: 99px;
		padding: 0 6px;
		font-variant-numeric: tabular-nums;
	}
	.empty {
		padding: var(--size-6);
		text-align: center;
		color: var(--color-text-disabled);
	}
</style>
