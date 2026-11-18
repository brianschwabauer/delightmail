<script lang="ts">
	import { onMount } from 'svelte';
	import { Button, Input, Select, toast } from '@delightstack/components';
	import type { SelectOption } from '@delightstack/components';
	import type { SenderRule } from '#lib/schema.ts';
	import type { RuleSuggestion } from '#lib/mailbox-rpc.ts';
	import { BUILTIN_RULES, describeMatcher, type SenderRuleMatcher } from '#lib/mail/triage.ts';

	const { data } = $props();
	const { db } = $derived(data);

	// Full rows: `matcher` is an object field, not part of the sparse sync.
	const rules = db.list('sender_rule', { limit: 200, sparse: false } as never);

	type MatchType = 'from_domain' | 'from_address' | 'list_id';
	type RuleAction = 'inbox' | 'notifications' | 'pitches' | 'archive' | 'trash' | 'spam';

	let match_type = $state<MatchType>('from_domain');
	let value = $state('');
	let subject = $state('');
	let action = $state<RuleAction>('notifications');
	let adding = $state(false);
	let busy = $state<string | null>(null);

	let suggestions = $state<RuleSuggestion[]>([]);

	// One row per built-in rule name ("Sentry alerts" covers two domains).
	const BUILTIN_GROUPS = Object.values(
		BUILTIN_RULES.reduce<Record<string, { name: string; matchers: string[]; action: RuleAction }>>(
			(groups, r) => {
				const name = r.name ?? 'Built-in';
				groups[name] ??= { name, matchers: [], action: r.action as RuleAction };
				groups[name].matchers.push(describeMatcher(r.matcher));
				return groups;
			},
			{},
		),
	);
	let accepting = $state<string | null>(null);

	const MATCH_OPTIONS: SelectOption[] = [
		{ value: 'from_domain', label: 'Sender domain' },
		{ value: 'from_address', label: 'Sender address' },
		{ value: 'list_id', label: 'List-Id' },
	];
	const ACTION_LABELS: Record<RuleAction, string> = {
		inbox: 'Keep in Inbox',
		notifications: 'Notifications',
		pitches: 'Pitches',
		archive: 'Archive',
		spam: 'Spam',
		trash: 'Trash',
	};
	const ACTION_OPTIONS: SelectOption[] = Object.entries(ACTION_LABELS).map(([v, label]) => ({
		value: v,
		label,
	}));

	onMount(async () => {
		try {
			const res = await fetch('/api/triage/rule-suggestions');
			if (res.ok) suggestions = ((await res.json()) as { suggestions: RuleSuggestion[] }).suggestions;
		} catch {
			/* suggestions are optional */
		}
	});

	async function addRule() {
		const v = value.trim().toLowerCase().replace(/^@/, '');
		const s = subject.trim();
		if (!v && !s) return toast('Enter a sender or a subject to match.');
		const matcher: SenderRuleMatcher = {};
		if (v) matcher[match_type] = v;
		if (s) matcher.subject = s;
		adding = true;
		try {
			await db.create('sender_rule', { matcher, action, source: 'user', hit_count: 0 } as never);
			value = '';
			subject = '';
			toast('Rule added.');
		} catch (e) {
			toast((e as Error).message);
		} finally {
			adding = false;
		}
	}

	function suggestionKey(s: RuleSuggestion): string {
		return `${s.matcher.from_address}\n${s.matcher.subject ?? ''}`;
	}

	async function accept(s: RuleSuggestion, rule_action: RuleAction) {
		const key = suggestionKey(s);
		accepting = key;
		try {
			await db.create('sender_rule', {
				// A $state proxy can't be structured-cloned to the database worker.
				matcher: $state.snapshot(s.matcher),
				action: rule_action,
				source: 'user',
				hit_count: 0,
			} as never);
			suggestions = suggestions.filter((x) => suggestionKey(x) !== key);
			toast(`Future mail goes to ${ACTION_LABELS[rule_action]}.`);
		} catch (e) {
			toast((e as Error).message);
		} finally {
			accepting = null;
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

{#if suggestions.length}
	<section>
		<h3>Suggested</h3>
		<ul class="list">
			{#each suggestions as s (suggestionKey(s))}
				<li>
					<div class="info">
						<strong>{s.from_name ? `${s.from_name} <${s.matcher.from_address}>` : s.matcher.from_address}</strong>
						<small class="muted">
							{s.matcher.subject ? `“${s.matcher.subject}” · ` : ''}you {s.folder === 'trash' ? 'trashed' : 'archived'}
							{s.count}
						</small>
						<small class="muted samples">{s.samples.join(' · ')}</small>
					</div>
					<div class="choices">
						<Button dense outline disabled={accepting !== null} onclick={() => accept(s, 'notifications')}>Notifications</Button>
						<Button dense outline disabled={accepting !== null} onclick={() => accept(s, 'trash')}>Trash</Button>
						<Button dense transparent disabled={accepting !== null} onclick={() => accept(s, 'inbox')}>Keep in Inbox</Button>
					</div>
				</li>
			{/each}
		</ul>
	</section>
{/if}

<form class="add" onsubmit={(e) => { e.preventDefault(); addRule(); }}>
	<div class="match">
		<Select
			value={match_type}
			options={MATCH_OPTIONS}
			onchange={({ value: v }) => {
				match_type = v as MatchType;
			}} />
	</div>
	<div class="sender">
		<Input
			bind:value
			placeholder={match_type === 'from_domain' ? 'example.com' : match_type === 'from_address' ? 'news@example.com' : 'list.example.com'} />
	</div>
	<div class="subject">
		<Input bind:value={subject} placeholder="Subject, e.g. Successfully published *" />
	</div>
	<div class="action">
		<Select
			value={action}
			options={ACTION_OPTIONS}
			onchange={({ value: v }) => {
				action = v as RuleAction;
			}} />
	</div>
	<div class="submit">
		<Button dense disabled={adding} onclick={addRule}>{adding ? '…' : 'Add rule'}</Button>
	</div>
</form>

{#if rules.items.length === 0}
	<div class="empty muted">No rules of your own yet.</div>
{:else}
	<ul class="list">
		{#each rules.items as r (r.id)}
			<li>
				<div class="info">
					<strong>{describeMatcher(r.matcher as SenderRuleMatcher)}</strong>
					<small class="muted">
						→ {ACTION_LABELS[r.action as RuleAction] ?? r.action}
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

<section>
	<h3>Built-in</h3>
	<ul class="list builtin">
		{#each BUILTIN_GROUPS as g (g.name)}
			<li>
				<div class="info">
					<strong>{g.name}</strong>
					<small class="muted">{g.matchers.join(' · ')} → {ACTION_LABELS[g.action]}</small>
				</div>
			</li>
		{/each}
	</ul>
</section>

<style>
	h2 { font-size: var(--font-size-3); }
	h3 { font-size: var(--font-size-1); margin: var(--space-4) 0 var(--space-2); }
	.muted { color: var(--color-text-disabled); }
	.add {
		display: grid; gap: var(--space-2); align-items: center;
		grid-template-columns: minmax(150px, 1fr) 2fr;
		grid-template-areas: 'match sender' 'subject subject' 'action submit';
		margin: var(--space-4) 0; padding: var(--space-3); background: var(--color-bg-2);
		border: 1px solid var(--color-border); border-radius: var(--radius-md);
		.match { grid-area: match; }
		.sender { grid-area: sender; }
		.subject { grid-area: subject; }
		.action { grid-area: action; }
		.submit { grid-area: submit; justify-self: end; }
	}
	.list {
		list-style: none; padding: 0; margin: 0 0 var(--space-4);
		li {
			display: flex; align-items: center; justify-content: space-between; gap: var(--space-3);
			padding: var(--space-2) 0; border-bottom: 1px solid var(--color-border);
		}
	}
	.builtin li { padding: var(--space-1) 0; }
	.info { display: flex; flex-direction: column; min-width: 0; }
	.samples { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.choices { display: flex; gap: var(--space-1); flex-shrink: 0; }
	.empty { padding: var(--space-3) 0; }
	@media (width < 640px) {
		.list li:has(.choices) { flex-direction: column; align-items: stretch; }
		.choices { flex-wrap: wrap; }
	}
</style>
