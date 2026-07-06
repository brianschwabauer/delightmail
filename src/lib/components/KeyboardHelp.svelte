<script lang="ts">
	import type { Keyboard, Binding } from '$lib/keyboard/keyboard.svelte';

	interface Props {
		kb: Keyboard;
		open: boolean;
		onClose: () => void;
	}
	const { kb, open, onClose }: Props = $props();

	let filter = $state('');

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
			<header>
				<h2>Keyboard shortcuts</h2>
				<!-- svelte-ignore a11y_autofocus -->
				<input placeholder="Filter…" bind:value={filter} autofocus />
			</header>
			<div class="groups">
				{#each groups as [group, bindings] (group)}
					<section>
						<h3>{group}</h3>
						{#each bindings as b (b.keys)}
							<div class="binding">
								<span class="keys">
									{#each keyParts(b.keys) as part (part)}
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
		background: color-mix(in oklch, black 40%, transparent);
		display: grid;
		place-items: center;
		z-index: 100;
	}
	.sheet {
		width: min(760px, 92vw);
		max-height: 82vh;
		background: var(--color-bg-1);
		border: 1px solid var(--color-outline);
		border-radius: var(--radius-4, 14px);
		box-shadow: var(--shadow-4, 0 20px 60px rgba(0, 0, 0, 0.35));
		display: flex;
		flex-direction: column;
		overflow: hidden;
	}
	header {
		display: flex;
		align-items: center;
		gap: var(--size-3);
		padding: var(--size-3) var(--size-4);
		border-bottom: 1px solid var(--color-outline);
	}
	h2 {
		font-size: var(--font-size-2);
		margin: 0;
		flex: 1;
	}
	header input {
		padding: 6px 10px;
		border: 1px solid var(--color-outline);
		border-radius: var(--radius-2);
		background: var(--color-bg-2);
		color: inherit;
	}
	.groups {
		overflow-y: auto;
		padding: var(--size-3) var(--size-4);
		columns: 2;
		column-gap: var(--size-5);
	}
	section {
		break-inside: avoid;
		margin-bottom: var(--size-4);
	}
	h3 {
		font-size: var(--font-size-00, 0.72rem);
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--color-text-disabled);
		margin: 0 0 var(--size-2);
	}
	.binding {
		display: flex;
		align-items: center;
		gap: var(--size-2);
		padding: 3px 0;
		font-size: var(--font-size-0);
	}
	.keys {
		display: inline-flex;
		gap: 3px;
		min-width: 84px;
	}
	kbd {
		font-family: var(--font-mono, monospace);
		font-size: 0.78em;
		background: var(--color-bg-2);
		border: 1px solid var(--color-outline);
		border-bottom-width: 2px;
		border-radius: 5px;
		padding: 1px 6px;
	}
	.desc {
		color: var(--color-text);
	}
</style>
