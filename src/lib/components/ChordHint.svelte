<script lang="ts">
	import type { Keyboard } from '$lib/keyboard/keyboard.svelte';

	interface Props {
		kb: Keyboard;
	}
	const { kb }: Props = $props();

	const options = $derived(kb.chordOptions());
</script>

{#if kb.pendingChord}
	<div class="chord" role="status">
		<span class="prefix"><kbd>{kb.pendingChord}</kbd></span>
		<div class="options">
			{#each options as o (o.key)}
				<div class="opt"><kbd>{o.key}</kbd><span>{o.description}</span></div>
			{/each}
		</div>
	</div>
{/if}

<style>
	.chord {
		position: fixed;
		bottom: calc(28px + var(--space-3));
		left: 50%;
		transform: translateX(-50%);
		background: var(--color-bg-1);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-lg);
		box-shadow: var(--shadow-xl, 0 8px 24px rgba(0, 0, 0, 0.25));
		padding: var(--space-2) var(--space-3);
		display: flex;
		gap: var(--space-3);
		align-items: flex-start;
		z-index: var(--layer-popover, 90);
		max-width: 92vw;
	}
	.prefix kbd {
		background: var(--dm-accent-soft);
		border-color: var(--dm-focus-ring);
		color: var(--color-primary);
	}
	.options {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
		gap: 5px 14px;
	}
	.opt {
		display: flex;
		gap: 6px;
		align-items: center;
		font-size: var(--font-size-00);
	}
	kbd {
		font-family: var(--font-mono);
		background: var(--color-bg-2);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-sm);
		padding: 0 5px;
	}
	.opt span {
		color: var(--color-text-disabled);
	}
</style>
