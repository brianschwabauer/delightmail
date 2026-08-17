<script lang="ts">
	import { Button, toast } from '@delightstack/components';
	import type { UnsubscribeTask } from '$lib/schema';

	const { data } = $props();
	const { db } = $derived(data);

	const tasks = db.list('unsubscribe_task', {
		where: { status: { eq: 'suggested' } },
		limit: 500,
	});

	// Group suggestions by sender domain.
	const grouped = $derived.by(() => {
		const map = new Map<string, UnsubscribeTask[]>();
		for (const t of tasks.items as UnsubscribeTask[]) {
			const list = map.get(t.sender_domain) ?? [];
			list.push(t);
			map.set(t.sender_domain, list);
		}
		return [...map.entries()].sort((a, b) => b[1].length - a[1].length);
	});

	let busy = $state<string | null>(null);

	async function unsubscribe(task: UnsubscribeTask) {
		busy = String(task.id);
		try {
			const res = await fetch(`/api/unsubscribe/${encodeURIComponent(task.id)}`, {
				method: 'POST',
			});
			const body = (await res.json()) as { ok: boolean; manual?: string; error?: string };
			if (body.ok) toast(`Unsubscribed from ${task.sender_domain}.`);
			else if (body.manual) {
				window.open(body.manual, '_blank', 'noopener');
				toast('Opened the unsubscribe page in a new tab.');
			} else toast(body.error || 'Could not unsubscribe automatically.');
		} catch (e) {
			toast((e as Error).message);
		} finally {
			busy = null;
		}
	}
</script>

<svelte:head><title>Subscriptions · Settings</title></svelte:head>

<h2>Subscriptions</h2>
<p class="muted">
	Senders the AI flagged as unsubscribe candidates, grouped by domain. One-click (RFC 8058)
	unsubscribes run server-side; others open the sender's page.
</p>

{#if grouped.length === 0}
	<div class="empty muted">No unsubscribe suggestions yet. They appear as AI triage runs.</div>
{:else}
	<ul class="list">
		{#each grouped as [domain, list] (domain)}
			<li>
				<div class="info">
					<strong>{domain}</strong>
					<small class="muted">{list.length} message{list.length === 1 ? '' : 's'} · {list[0].method}</small>
				</div>
				<Button dense disabled={busy === list[0].id} onclick={() => unsubscribe(list[0])}>
					{busy === list[0].id ? '…' : 'Unsubscribe'}
				</Button>
			</li>
		{/each}
	</ul>
{/if}

<style>
	h2 { font-size: var(--font-size-3); }
	.muted { color: var(--color-text-disabled); }
	.list { list-style: none; padding: 0; margin: var(--space-4) 0; }
	.list li {
		display: flex; align-items: center; justify-content: space-between;
		padding: var(--space-2) 0; border-bottom: 1px solid var(--color-border);
	}
	.info { display: flex; flex-direction: column; }
	.empty { padding: var(--space-5) 0; }
</style>
