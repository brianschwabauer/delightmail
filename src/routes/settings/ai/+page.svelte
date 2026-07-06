<script lang="ts">
	import { onMount } from 'svelte';
	import { Button, toast } from '@delightstack/components';
	import { DEFAULT_TRIAGE_PROMPT } from '$lib/mail/triage';

	const { data } = $props();
	const { db } = $derived(data);

	let enabled = $state(false);
	let mode = $state<'label_only' | 'quarantine' | 'full_auto'>('quarantine');
	let prompt = $state('');
	let saving = $state(false);
	let testing = $state(false);
	let results = $state<Array<Record<string, unknown>>>([]);

	onMount(async () => {
		try {
			const e = db.entity('settings', 'main');
			await e.load();
			const s = (e.loaded ? e.value : {}) as {
				triage_enabled?: boolean;
				triage_mode?: typeof mode;
				triage_prompt?: string;
			};
			enabled = s.triage_enabled ?? false;
			mode = s.triage_mode ?? 'quarantine';
			prompt = s.triage_prompt ?? DEFAULT_TRIAGE_PROMPT;
		} catch {
			prompt = DEFAULT_TRIAGE_PROMPT;
		}
	});

	async function save() {
		saving = true;
		try {
			const e = db.entity('settings', 'main');
			await e.load();
			const patch = { triage_enabled: enabled, triage_mode: mode, triage_prompt: prompt };
			if (!e.loaded) await db.create('settings', { id: 'main', ...patch });
			else await e.save(patch);
			toast('AI triage settings saved.');
		} catch (err) {
			toast((err as Error).message);
		} finally {
			saving = false;
		}
	}

	async function runTest() {
		testing = true;
		results = [];
		try {
			const res = await fetch('/api/triage/test', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ prompt, count: 5 }),
			});
			const body = (await res.json()) as { results?: Array<Record<string, unknown>> };
			results = body.results ?? [];
		} catch (err) {
			toast((err as Error).message);
		} finally {
			testing = false;
		}
	}
</script>

<svelte:head><title>AI Triage · Settings</title></svelte:head>

<h2>AI Triage</h2>
<p class="muted">
	Every inbound message is classified through a Cloudflare AI Gateway dynamic route — swap the
	model in the CF dashboard with no code deploy. Guardrails (never trash known correspondents,
	never act on urgent mail, confidence floor) are enforced in code.
</p>

<label class="toggle">
	<input type="checkbox" bind:checked={enabled} />
	Enable AI triage
</label>

<section>
	<h3>Mode</h3>
	<div class="segmented">
		{#each [['label_only', 'Label only'], ['quarantine', 'Quarantine'], ['full_auto', 'Full auto']] as [v, label] (v)}
			<button class:active={mode === v} onclick={() => (mode = v as typeof mode)}>{label}</button>
		{/each}
	</div>
	<p class="muted small">
		Quarantine (recommended) moves filtered mail to the reviewable “AI Filtered” folder — it never
		actually trashes anything.
	</p>
</section>

<section>
	<h3>Your policy</h3>
	<p class="muted small">Your own words about what you care about. The JSON contract + safety rules are added around this automatically.</p>
	<textarea bind:value={prompt} rows="10"></textarea>
</section>

<div class="actions">
	<Button disabled={saving} onclick={save}>{saving ? 'Saving…' : 'Save'}</Button>
	<Button transparent disabled={testing} onclick={runTest}>
		{testing ? 'Testing…' : 'Test against recent mail'}
	</Button>
</div>

{#if results.length}
	<section class="preview">
		<h3>Preview</h3>
		{#each results as r (r.subject)}
			<div class="result">
				<div class="subj">{r.subject ?? '(no subject)'}</div>
				{#if r.error}
					<div class="err">{r.error}</div>
				{:else}
					{@const v = r.verdict as Record<string, unknown>}
					<div class="verdict">
						<span class="chip">{v?.category}</span>
						<span class="chip">→ {v?.action}</span>
						<span class="chip">imp {v?.importance}</span>
						<span class="chip">conf {Number(v?.confidence).toFixed(2)}</span>
						{#if r.overridden}<span class="chip warn">overridden</span>{/if}
					</div>
					<div class="summary muted small">{v?.summary}</div>
				{/if}
			</div>
		{/each}
	</section>
{/if}

<style>
	h2 { font-size: var(--font-size-3); }
	h3 { font-size: var(--font-size-1); margin: var(--size-4) 0 var(--size-2); }
	.muted { color: var(--color-text-disabled); }
	.small { font-size: var(--font-size-0); }
	.toggle { display: flex; align-items: center; gap: var(--size-2); margin: var(--size-4) 0; }
	.segmented { display: inline-flex; border: 1px solid var(--color-outline); border-radius: var(--radius-2); overflow: hidden; }
	.segmented button { padding: 6px 14px; border: none; background: var(--color-bg-2); color: inherit; cursor: pointer; border-right: 1px solid var(--color-outline); }
	.segmented button:last-child { border-right: none; }
	.segmented button.active { background: var(--color-primary); color: white; }
	textarea { width: 100%; border: 1px solid var(--color-outline); border-radius: var(--radius-2); background: var(--color-bg-2); color: inherit; padding: var(--size-3); font: inherit; font-size: var(--font-size-0); resize: vertical; }
	.actions { display: flex; gap: var(--size-2); margin-top: var(--size-3); }
	.preview .result { padding: var(--size-2) 0; border-bottom: 1px solid var(--color-outline); }
	.subj { font-weight: 600; font-size: var(--font-size-0); }
	.verdict { display: flex; gap: 6px; flex-wrap: wrap; margin: 4px 0; }
	.chip { font-size: var(--font-size-00, 0.72rem); background: var(--color-bg-2); border-radius: 99px; padding: 1px 8px; }
	.chip.warn { background: color-mix(in oklch, var(--color-warning, orange) 30%, transparent); }
	.err { color: var(--color-bad, #c0392b); font-size: var(--font-size-0); }
</style>
