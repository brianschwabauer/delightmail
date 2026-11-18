<script lang="ts">
	import { onMount } from 'svelte';
	import { Button, ButtonGroup, Toggle, Input, toast } from '@delightstack/components';
	import { DEFAULT_TRIAGE_PROMPT, DEFAULT_RETENTION_DAYS } from '#lib/mail/triage.ts';
	import type { TriageUsage } from '#lib/mailbox-rpc.ts';

	type Mode = 'label_only' | 'quarantine' | 'full_auto';
	const MODES: Array<[Mode, string, string]> = [
		['label_only', 'Label only', 'Tag categories, never move anything'],
		['quarantine', 'Quarantine', 'Notifications and Pitches get their folders; anything else AI would move goes to AI Filtered'],
		['full_auto', 'Full auto', 'Apply every verdict directly (trash stays recoverable)'],
	];
	const NOTIFICATION_DAYS: Array<[number, string]> = [
		[7, '7 days'],
		[30, '30 days'],
		[90, '90 days'],
		[0, 'Never'],
	];
	const PITCH_DAYS: Array<[number, string]> = [
		[30, '30 days'],
		[90, '90 days'],
		[365, '1 year'],
		[0, 'Never'],
	];

	const { data } = $props();
	const { db } = $derived(data);

	let enabled = $state(false);
	let mode = $state<Mode>('quarantine');
	let prompt = $state('');
	let notifications_days = $state(DEFAULT_RETENTION_DAYS.notifications);
	let pitches_days = $state(DEFAULT_RETENTION_DAYS.pitches);
	let saving = $state(false);
	let testing = $state(false);
	let results = $state<Array<Record<string, unknown>>>([]);
	let usage = $state<TriageUsage | null>(null);

	const totals = $derived(
		(usage?.rows ?? []).reduce(
			(t, r) => ({
				decisions: t.decisions + r.decisions,
				moved: t.moved + r.moved,
				cost_usd: t.cost_usd + r.cost_usd,
			}),
			{ decisions: 0, moved: 0, cost_usd: 0 },
		),
	);

	onMount(async () => {
		try {
			const e = db.entity('settings', 'main');
			await e.load();
			const s = (e.loaded ? e.value : {}) as {
				triage_enabled?: boolean;
				triage_mode?: Mode;
				triage_prompt?: string;
				notifications_retention_days?: number;
				pitches_retention_days?: number;
			};
			enabled = s.triage_enabled ?? false;
			mode = s.triage_mode ?? 'quarantine';
			prompt = s.triage_prompt || DEFAULT_TRIAGE_PROMPT;
			notifications_days = s.notifications_retention_days ?? DEFAULT_RETENTION_DAYS.notifications;
			pitches_days = s.pitches_retention_days ?? DEFAULT_RETENTION_DAYS.pitches;
		} catch {
			prompt = DEFAULT_TRIAGE_PROMPT;
		}
		try {
			const res = await fetch('/api/triage/usage?days=30');
			if (res.ok) usage = (await res.json()) as TriageUsage;
		} catch {
			/* the usage panel is optional */
		}
	});

	async function save() {
		saving = true;
		try {
			const e = db.entity('settings', 'main');
			await e.load();
			const patch = {
				triage_enabled: enabled,
				triage_mode: mode,
				triage_prompt: prompt,
				notifications_retention_days: notifications_days,
				pitches_retention_days: pitches_days,
			};
			if (!e.loaded) await db.create('settings', { id: 'main', ...patch } as never);
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
				body: JSON.stringify({ prompt, count: 8 }),
			});
			const body = (await res.json()) as { results?: Array<Record<string, unknown>> };
			results = body.results ?? [];
		} catch (err) {
			toast((err as Error).message);
		} finally {
			testing = false;
		}
	}

	function usd(n: number): string {
		if (n === 0) return '$0';
		return n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
	}
	const STAGE_LABELS: Record<string, string> = {
		'pre-pass': 'People you know',
		rule: 'Your rules',
		builtin: 'Built-in rules',
		inherit: 'Pitch follow-ups',
	};
</script>

<svelte:head><title>AI Triage · Settings</title></svelte:head>

<h2>AI Triage</h2>

{#if usage && !usage.configured}
	<p class="warn">No AI key is configured on the server, so triage is off.</p>
{/if}

<div class="toggle-row">
	<Toggle bind:checked={enabled} label="Enable AI triage" />
</div>

<section>
	<h3>Mode</h3>
	<ButtonGroup outline>
		{#each MODES as [v, label, tip] (v)}
			<Button active={mode === v} tooltip={tip} onclick={() => (mode = v)}>{label}</Button>
		{/each}
	</ButtonGroup>
</section>

<section class="retention">
	<div>
		<h3>Delete notifications after</h3>
		<ButtonGroup outline>
			{#each NOTIFICATION_DAYS as [days, label] (days)}
				<Button active={notifications_days === days} onclick={() => (notifications_days = days)}>{label}</Button>
			{/each}
		</ButtonGroup>
	</div>
	<div>
		<h3>Delete pitches after</h3>
		<ButtonGroup outline>
			{#each PITCH_DAYS as [days, label] (days)}
				<Button active={pitches_days === days} onclick={() => (pitches_days = days)}>{label}</Button>
			{/each}
		</ButtonGroup>
	</div>
</section>

<section>
	<h3>Your policy</h3>
	<Input type="textarea" bind:value={prompt} rows={8} auto_resize />
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
		{#each results as r, i (i)}
			<div class="result">
				<div class="subj">{r.subject ?? '(no subject)'}</div>
				{#if r.error}
					<div class="err">{r.error}</div>
				{:else}
					{@const v = r.verdict as Record<string, unknown>}
					<div class="verdict">
						<span class="chip strong">→ {r.folder ?? 'inbox'}</span>
						<span class="chip">{v?.category}</span>
						<span class="chip">{STAGE_LABELS[String(r.stage)] ?? r.model}</span>
						{#if r.stage === 'model'}
							<span class="chip">{Math.round(Number(v?.confidence) * 100)}%</span>
						{/if}
						{#if r.overridden}<span class="chip warn">kept by guardrail</span>{/if}
					</div>
					<div class="summary muted small">{v?.summary}</div>
				{/if}
			</div>
		{/each}
	</section>
{/if}

{#if usage && usage.rows.length}
	<section>
		<h3>Last 30 days · {usd(totals.cost_usd)}</h3>
		<table>
			<thead>
				<tr>
					<th>Decided by</th>
					<th class="num">Mail</th>
					<th class="num">Filed</th>
					<th class="num">Tokens</th>
					<th class="num">Cost</th>
				</tr>
			</thead>
			<tbody>
				{#each usage.rows as row (row.model)}
					<tr>
						<td>{STAGE_LABELS[row.model] ?? row.model}</td>
						<td class="num">{row.decisions}</td>
						<td class="num">{row.moved}</td>
						<td class="num">{(row.input_tokens + row.output_tokens).toLocaleString()}</td>
						<td class="num">{usd(row.cost_usd)}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</section>
{/if}

<style>
	h2 { font-size: var(--font-size-3); }
	h3 { font-size: var(--font-size-1); margin: var(--space-4) 0 var(--space-2); }
	.muted { color: var(--color-text-disabled); }
	.small { font-size: var(--font-size-0); }
	.warn { color: var(--color-warning, oklch(0.7 0.15 70)); font-size: var(--font-size-0); }
	.toggle-row { margin: var(--space-4) 0; }
	.retention { display: flex; flex-wrap: wrap; column-gap: var(--space-6, 32px); }
	.actions { display: flex; gap: var(--space-2); margin-top: var(--space-3); }
	.preview .result { padding: var(--space-2) 0; border-bottom: 1px solid var(--color-border); }
	.subj { font-weight: 600; font-size: var(--font-size-0); }
	.verdict { display: flex; gap: 6px; flex-wrap: wrap; margin: 4px 0; }
	.chip {
		font-size: var(--font-size-00, 0.72rem); background: var(--color-bg-2); border-radius: 99px; padding: 1px 8px;
		&.strong { font-weight: 600; }
		&.warn { background: color-mix(in oklch, var(--color-warning, orange) 30%, transparent); }
	}
	.err { color: var(--color-error, oklch(0.55 0.19 27)); font-size: var(--font-size-0); }
	table {
		border-collapse: collapse; font-size: var(--font-size-0); width: 100%; max-width: 560px;
		th, td { padding: var(--space-1) var(--space-2) var(--space-1) 0; text-align: left; border-bottom: 1px solid var(--color-border); }
		th { font-weight: 600; color: var(--color-text-disabled); }
		.num { text-align: right; font-variant-numeric: tabular-nums; }
	}
</style>
