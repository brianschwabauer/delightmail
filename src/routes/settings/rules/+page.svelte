<script lang="ts">
	import { Button, Input, Select, toast } from '@delightstack/components';
	import type { SelectOption } from '@delightstack/components';
	import type { SenderRule } from '$lib/schema';

	const { data } = $props();
	const { db } = $derived(data);

	const rules = db.list('sender_rule', { limit: 200 });

	type MatchType = 'from_domain' | 'from_address' | 'list_id';
	type RuleAction = 'inbox' | 'archive' | 'trash' | 'spam';

	let matchType = $state<MatchType>('from_domain');
	let value = $state('');
	let action = $state<RuleAction>('archive');
	let adding = $state(false);
	let busy = $state<string | null>(null);

	const MATCH_OPTIONS: SelectOption[] = [
		{ value: 'from_domain', label: 'Sender domain' },
		{ value: 'from_address', label: 'Sender address' },
		{ value: 'list_id', label: 'List-Id' },
	];
	const ACTION_OPTIONS: SelectOption[] = [
		{ value: 'inbox', label: 'Keep in Inbox' },
		{ value: 'archive', label: 'Archive' },
		{ value: 'spam', label: 'Spam' },
		{ value: 'trash', label: 'Trash' },
	];

	function describe(r: SenderRule): string {
		const m = r.matcher as { from_domain?: string; from_address?: string; list_id?: string };
		if (m.from_address) return `From ${m.from_address}`;
		if (m.from_domain) return `From @${m.from_domain}`;
		if (m.list_id) return `List ${m.list_id}`;
		return 'Any';
	}

	async function addRule() {
		const v = value.trim().toLowerCase().replace(/^@/, '');
		if (!v) return toast('Enter a value to match.');
		adding = true;
		try {
			await db.create('sender_rule', {
				matcher: { [matchType]: v },
				action,
				source: 'user',
				hit_count: 0,
			} as never);
			value = '';
			toast('Rule added.');
		} catch (e) {
			toast((e as Error).message);
		} finally {
			adding = false;
		}
	}

	async function remove(r: SenderRule) {
		busy = String(r.id);
		try {
			await db.delete('sender_rule', String(r.id));
		} catch (e) {
			toast((e as Error).message);
		} finally {
			busy = null;
		}
	}
</script>

<svelte:head><title>Rules · Settings</title></svelte:head>

<h2>Rules</h2>
<p class="muted">
	Deterministic sender rules run <strong>before</strong> AI at ingest — zero-cost handling of
	repeat senders. A match applies the action and skips the AI.
</p>

<form class="add" onsubmit={(e) => { e.preventDefault(); addRule(); }}>
	<Select
		value={matchType}
		options={MATCH_OPTIONS}
		onchange={({ value: v }) => (matchType = v as MatchType)} />
	<div class="grow">
		<Input
			bind:value
			placeholder={matchType === 'from_domain' ? 'example.com' : matchType === 'from_address' ? 'news@example.com' : 'list.example.com'} />
	</div>
	<Select
		value={action}
		options={ACTION_OPTIONS}
		onchange={({ value: v }) => (action = v as RuleAction)} />
	<Button dense disabled={adding} onclick={addRule}>{adding ? '…' : 'Add rule'}</Button>
</form>

{#if rules.items.length === 0}
	<div class="empty muted">No rules yet. Add one above, or create one from a message's actions menu.</div>
{:else}
	<ul class="list">
		{#each rules.items as r (r.id)}
			<li>
				<div class="info">
					<strong>{describe(r as SenderRule)}</strong>
					<small class="muted">
						→ {r.action}
						{#if (r.hit_count ?? 0) > 0} · {r.hit_count} hits{/if}
						{#if r.source === 'ai_confirmed'} · from AI{/if}
					</small>
				</div>
				<Button dense outline error disabled={busy === String(r.id)} onclick={() => remove(r as SenderRule)}>
					{busy === String(r.id) ? '…' : 'Delete'}
				</Button>
			</li>
		{/each}
	</ul>
{/if}

<style>
	h2 { font-size: var(--font-size-3); }
	.muted { color: var(--color-text-disabled); }
	.add {
		display: flex; flex-wrap: wrap; gap: var(--space-2); align-items: center;
		margin: var(--space-4) 0; padding: var(--space-3); background: var(--color-bg-2);
		border: 1px solid var(--color-border); border-radius: var(--radius-md);
	}
	.add .grow { flex: 1; min-width: 160px; }
	.list { list-style: none; padding: 0; margin: var(--space-4) 0; }
	.list li {
		display: flex; align-items: center; justify-content: space-between;
		padding: var(--space-2) 0; border-bottom: 1px solid var(--color-border);
	}
	.info { display: flex; flex-direction: column; }
	.empty { padding: var(--space-5) 0; }
</style>
