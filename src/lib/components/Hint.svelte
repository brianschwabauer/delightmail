<script lang="ts">
	import type { Snippet } from 'svelte';
	import { Popover, type PopoverPlacement } from '@delightstack/components';

	/** Hover tooltip: a label plus its keyboard shortcut(s), delightstack-Popover
	 *  positioned. Wraps its trigger in an inline span (Popover needs a DOM ref). */
	interface Props {
		label: string;
		/** Shortcut keys, rendered as <kbd> chips ("R", "Ctrl+z"). */
		keys?: string[];
		placement?: PopoverPlacement;
		children: Snippet;
	}
	const { label, keys = [], placement = 'top', children }: Props = $props();

	let ref = $state<HTMLElement>();
</script>

<span class="target" bind:this={ref}>{@render children()}</span>
<Popover
	ref_element={ref}
	open_on_hover
	{placement}
	dense
	arrow={false}
	disable_initial_focus
	hover_delay={350}>
	<span class="tip">
		{label}
		{#each keys as k (k)}<kbd>{k}</kbd>{/each}
	</span>
</Popover>

<style>
	.target {
		display: inline-flex;
	}
	.tip {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: var(--font-size-00);
		white-space: nowrap;
	}
	kbd {
		display: inline-grid;
		place-items: center;
		min-width: 18px;
		padding: 1px 5px;
		font-family: var(--font-mono);
		font-size: 0.82em;
		background: var(--color-bg-2);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-sm, 4px);
	}
</style>
