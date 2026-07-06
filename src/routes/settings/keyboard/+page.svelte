<script lang="ts">
	// A static reference of the default bindings (the live engine lives in the
	// mail layout context). Per-key overrides persist to settings.keyboard_overrides.
	const groups: Array<[string, Array<[string, string]>]> = [
		['Global', [
			['n / c', 'Compose'],
			['/', 'Search'],
			['Ctrl+K', 'Command palette'],
			['?', 'Keyboard help'],
			['z', 'Undo last action'],
			['g i / s / t / d / a / f', 'Go to folder'],
		]],
		['List', [
			['j / k', 'Next / previous'],
			['g g / G', 'Top / bottom'],
			['Ctrl+d / Ctrl+u', 'Half page'],
			['Enter / l', 'Open thread'],
			['h / Esc', 'Close thread'],
			['x', 'Select / deselect'],
			['Shift+j / Shift+k', 'Select and move'],
			['f', 'Filter loaded list'],
		]],
		['Actions', [
			['a', 'Archive'],
			['d', 'Trash'],
			['D', 'Delete forever'],
			['s', 'Toggle star'],
			['u', 'Toggle read/unread'],
			['!', 'Mark spam'],
		]],
	];
</script>

<svelte:head><title>Keyboard · Settings</title></svelte:head>

<h2>Keyboard</h2>
<p class="muted">DelightMail is keyboard-first. Press <kbd>?</kbd> anywhere for the live cheat-sheet.</p>

{#each groups as [group, rows] (group)}
	<section>
		<h3>{group}</h3>
		{#each rows as [keys, desc] (keys)}
			<div class="row"><kbd>{keys}</kbd><span>{desc}</span></div>
		{/each}
	</section>
{/each}

<style>
	h2 { font-size: var(--font-size-3); }
	h3 { font-size: var(--font-size-1); margin: var(--size-4) 0 var(--size-2); }
	.muted { color: var(--color-text-disabled); }
	.row { display: flex; gap: var(--size-3); padding: 4px 0; align-items: center; }
	kbd {
		font-family: var(--font-mono, monospace);
		font-size: 0.8em;
		background: var(--color-bg-2);
		border: 1px solid var(--color-outline);
		border-radius: 5px;
		padding: 1px 7px;
		min-width: 120px;
		text-align: center;
	}
	span { color: var(--color-text-disabled); }
</style>
