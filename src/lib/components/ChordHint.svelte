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
		bottom: calc(28px + var(--size-3));
		left: 50%;
		transform: translateX(-50%);
		background: var(--color-bg-1);
		border: 1px solid var(--color-outline);
		border-radius: var(--radius-3);
		box-shadow: var(--shadow-3, 0 8px 24px rgba(0, 0, 0, 0.25));
		padding: var(--size-2) var(--size-3);
		display: flex;
		gap: var(--size-3);
		align-items: flex-start;
		z-index: 90;
		max-width: 92vw;
	}
	.options {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
		gap: 4px 12px;
	}
	.opt {
		display: flex;
		gap: 6px;
		align-items: center;
		font-size: var(--font-size-00, 0.74rem);
	}
	kbd {
		font-family: var(--font-mono, monospace);
		background: var(--color-bg-2);
		border: 1px solid var(--color-outline);
		border-radius: 4px;
		padding: 0 5px;
	}
	.opt span {
		color: var(--color-text-disabled);
	}
</style>
