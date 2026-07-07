<script lang="ts">
	import { onMount } from 'svelte';
	import { Button, toast } from '@delightstack/components';

	const { data } = $props();
	const { db } = $derived(data);

	// The action keys that make sense to remap (default key → description). The
	// live engine reads settings.keyboard_overrides on the next mail-view load.
	const OVERRIDABLE: Array<{ def: string; desc: string }> = [
		{ def: 'n', desc: 'Compose' },
		{ def: 'a', desc: 'Archive' },
		{ def: 'd', desc: 'Trash' },
		{ def: 's', desc: 'Toggle star' },
		{ def: 'u', desc: 'Toggle read/unread' },
		{ def: '!', desc: 'Mark spam' },
		{ def: 'e', desc: 'Unsubscribe' },
		{ def: 'v', desc: 'Move to…' },
	];

	let overrides = $state<Record<string, string>>({});
	let saving = $state(false);

	onMount(async () => {
		try {
			const e = db.entity('settings', 'main');
			await e.load();
			const raw = (e.loaded ? (e.value as { keyboard_overrides?: string }).keyboard_overrides : '') ?? '';
			if (raw) overrides = JSON.parse(raw) as Record<string, string>;
		} catch {
			/* defaults */
		}
	});

	function currentKey(def: string): string {
		return overrides[def] ?? def;
	}
	function setKey(def: string, value: string) {
		const k = value.trim().slice(0, 12);
		const next = { ...overrides };
		if (!k || k === def) delete next[def];
		else next[def] = k;
		overrides = next;
	}

	async function save() {
		saving = true;
		try {
			const e = db.entity('settings', 'main');
			await e.load();
			const patch = { keyboard_overrides: JSON.stringify(overrides) };
			if (!e.loaded) await db.create('settings', { id: 'main', ...patch } as never);
			else await e.save(patch);
			toast('Shortcuts saved. Reload the mail view to apply.');
		} catch (err) {
			toast((err as Error).message);
		} finally {
			saving = false;
		}
	}
	function reset() {
		overrides = {};
	}
</script>

<svelte:head><title>Keyboard · Settings</title></svelte:head>

<h2>Keyboard</h2>
<p class="muted">DelightMail is keyboard-first. Press <kbd>?</kbd> anywhere for the live cheat-sheet.</p>

<section>
	<h3>Customize action keys</h3>
	<p class="muted small">Override the key for common actions. Changes apply on the next mail-view load.</p>
	{#each OVERRIDABLE as o (o.def)}
		<div class="edit-row">
			<span class="desc">{o.desc}</span>
			<span class="def">default <kbd>{o.def}</kbd></span>
			<input
				class="key-input"
				value={currentKey(o.def)}
				aria-label="Key for {o.desc}"
				oninput={(e) => setKey(o.def, (e.target as HTMLInputElement).value)} />
		</div>
	{/each}
	<div class="actions">
		<Button disabled={saving} onclick={save}>{saving ? 'Saving…' : 'Save shortcuts'}</Button>
		<button class="reset" onclick={reset}>Reset to defaults</button>
	</div>
</section>

<style>
	h2 { font-size: var(--font-size-3); }
	h3 { font-size: var(--font-size-1); margin: var(--space-4) 0 var(--space-2); }
	.muted { color: var(--color-text-disabled); }
	.small { font-size: var(--font-size-00, 0.78rem); }
	.edit-row {
		display: flex; align-items: center; gap: var(--space-3); padding: 6px 0;
		border-bottom: 1px solid var(--color-border);
	}
	.desc { flex: 1; }
	.def { color: var(--color-text-disabled); font-size: var(--font-size-00, 0.75rem); }
	.key-input {
		width: 80px; text-align: center; font-family: var(--font-mono, monospace);
		padding: 4px 6px; border: 1px solid var(--color-border); border-radius: var(--radius-md);
		background: var(--color-bg-1); color: inherit;
	}
	.actions { display: flex; align-items: center; gap: var(--space-3); margin-top: var(--space-4); }
	.reset { background: none; border: none; color: var(--color-text-disabled); cursor: pointer; font: inherit; }
	kbd {
		font-family: var(--font-mono, monospace); font-size: 0.8em;
		background: var(--color-bg-2); border: 1px solid var(--color-border);
		border-radius: 5px; padding: 1px 7px;
	}
</style>
