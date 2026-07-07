<script lang="ts">
	import { tick } from 'svelte';
	import { Input } from '@delightstack/components';
	import type { Keyboard, Binding } from '$lib/keyboard/keyboard.svelte';

	interface Props {
		kb: Keyboard;
		open: boolean;
		onClose: () => void;
	}
	const { kb, open, onClose }: Props = $props();

	let filter = $state('');
	let headerEl = $state<HTMLElement>();
	// Land the caret in the filter as the sheet opens (delightstack <Input> has no
	// autofocus prop, so focus its inner field once it's in the DOM).
	$effect(() => {
		if (open) void tick().then(() => headerEl?.querySelector('input')?.focus());
	});

	const groups = $derived.by(() => {
		const bindings = kb.activeBindings().filter((b) => {
			if (!filter) return true;
			const q = filter.toLowerCase();
			return b.description.toLowerCase().includes(q) || b.keys.toLowerCase().includes(q);
		});
		const map = new Map<string, Binding[]>();
		for (const b of bindings) {
			const list = map.get(b.group) ?? [];
			if (!list.some((x) => x.keys === b.keys)) list.push(b);
			map.set(b.group, list);
		}
		return [...map.entries()];
	});

	function keyParts(keys: string): string[] {
		return keys.split(' ');
	}
</script>

{#if open}
	<div
		class="scrim"
		role="button"
		tabindex="-1"
		onclick={onClose}
		onkeydown={(e) => e.key === 'Escape' && onClose()}>
		<div class="sheet" role="dialog" aria-label="Keyboard shortcuts" onclick={(e) => e.stopPropagation()}>
			<header bind:this={headerEl}>
				<h2>Keyboard shortcuts</h2>
				<Input placeholder="Filter…" bind:value={filter} dense class="kbd-filter" />
			</header>
			<div class="groups">
				{#each groups as [group, bindings] (group)}
					<section>
						<h3>{group}</h3>
						{#each bindings as b (b.keys)}
							<div class="binding">
								<span class="keys">
									{#each keyParts(b.keys) as part, i (i)}
										<kbd>{part}</kbd>
									{/each}
								</span>
								<span class="desc">{b.description}</span>
							</div>
						{/each}
					</section>
				{/each}
			</div>
		</div>
	</div>
{/if}

<style>
	.scrim {
		position: fixed;
		inset: 0;
		background: var(--color-backdrop, color-mix(in oklch, black 40%, transparent));
		display: grid;
		place-items: center;
		z-index: var(--layer-modal, 100);
	}
	.sheet {
		width: min(820px, 92vw);
		max-height: 82vh;
		background: var(--color-bg-1);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-xl, 14px);
		box-shadow: var(--shadow-2xl, 0 20px 60px rgba(0, 0, 0, 0.35));
		display: flex;
		flex-direction: column;
		overflow: hidden;
	}
	header {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		padding: var(--space-3) var(--space-4);
		border-bottom: 1px solid var(--color-border);
	}
	h2 {
		font-size: var(--font-size-2);
		font-weight: var(--font-weight-semibold, 600);
		margin: 0;
		flex: 1;
	}
	header :global(.kbd-filter) {
		width: 220px;
		max-width: 50%;
	}
	.groups {
		overflow-y: auto;
		padding: var(--space-4);
		columns: 2;
		column-gap: var(--space-5);
	}
	section {
		break-inside: avoid;
		margin-bottom: var(--space-4);
	}
	h3 {
		font-size: var(--font-size-00);
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--color-primary);
		font-weight: var(--font-weight-semibold, 600);
		margin: 0 0 var(--space-2);
	}
	.binding {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		padding: 4px 0;
		font-size: var(--font-size-0);
	}
	.keys {
		display: inline-flex;
		gap: 3px;
		min-width: 108px;
		flex-shrink: 0;
	}
	kbd {
		font-family: var(--font-mono);
		font-size: 0.78em;
		background: var(--color-bg-2);
		border: 1px solid var(--color-border);
		border-bottom-width: 2px;
		border-radius: var(--radius-sm);
		padding: 1px 6px;
		white-space: nowrap;
	}
	.desc {
		color: var(--color-text-muted, var(--color-text));
	}
</style>
