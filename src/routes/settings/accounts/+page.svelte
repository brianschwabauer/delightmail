<script lang="ts">
	import { Button, Input, toast } from '@delightstack/components';

	const { data } = $props();
	const { db } = $derived(data);

	const accounts = db.search('account', { limit: 50 });
	let connecting = $state(false);
	let domain = $state('');
	let addingDomain = $state(false);

	async function connectDomain() {
		if (!domain.trim()) return;
		addingDomain = true;
		try {
			const res = await fetch('/api/accounts/domain', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ domain: domain.trim() }),
			});
			const body = (await res.json().catch(() => ({}))) as { next_steps?: string; message?: string };
			if (!res.ok) return toast(body.message || 'Could not register the domain.');
			toast(body.next_steps || 'Domain registered.');
			domain = '';
		} catch (e) {
			toast((e as Error).message);
		} finally {
			addingDomain = false;
		}
	}

	async function connectGmail() {
		connecting = true;
		try {
			const res = await fetch('/api/accounts/google/start', { method: 'POST' });
			if (!res.ok) {
				const err = (await res.json().catch(() => ({}))) as { message?: string };
				toast(err.message || 'Gmail connect is not configured on this instance.');
				return;
			}
			const { url } = (await res.json()) as { url: string };
			window.location.href = url;
		} catch (e) {
			toast((e as Error).message || 'Could not start Gmail connect.');
		} finally {
			connecting = false;
		}
	}

	function statusLabel(a: { status: string; status_detail?: string | null }): string {
		if (a.status === 'backfilling') return 'Backfilling…';
		if (a.status === 'live') return 'Live';
		if (a.status === 'error') return a.status_detail || 'Error';
		if (a.status === 'connecting') return 'Connecting…';
		if (a.status === 'paused') return 'Paused';
		return a.status;
	}
</script>

<svelte:head><title>Accounts · Settings</title></svelte:head>

<h2>Mail accounts</h2>
<p class="muted">Connect Gmail, a custom domain, or an IMAP mailbox.</p>

{#if accounts.docs.length}
	<ul class="accounts">
		{#each accounts.docs as a (a.id)}
			<li>
				<span class="dot" style:background={a.color || 'var(--color-primary)'}></span>
				<span class="email">
					<strong>{a.display_name || a.email}</strong>
					<small>{a.kind}</small>
				</span>
				<span class="status" class:err={a.status === 'error'}>{statusLabel(a)}</span>
			</li>
		{/each}
	</ul>
{:else}
	<div class="empty"><p class="muted">No accounts connected yet.</p></div>
{/if}

<div class="add">
	<Button disabled={connecting} onclick={connectGmail}>
		{connecting ? 'Redirecting…' : 'Connect a Gmail account'}
	</Button>
</div>

<div class="add domain">
	<h3>Custom domain</h3>
	<p class="hint muted">
		Route a domain's mail here via Cloudflare Email Routing (catch-all → Send to Worker).
	</p>
	<div class="domain-row">
		<Input bind:value={domain} placeholder="example.com" />
		<Button disabled={addingDomain} onclick={connectDomain}>
			{addingDomain ? 'Registering…' : 'Add domain'}
		</Button>
	</div>
</div>

<style>
	h2 {
		font-size: var(--font-size-3);
	}
	.muted {
		color: var(--color-text-disabled);
	}
	.accounts {
		list-style: none;
		padding: 0;
		margin: var(--size-4) 0;
	}
	.accounts li {
		display: flex;
		align-items: center;
		gap: var(--size-3);
		padding: var(--size-3) 0;
		border-bottom: 1px solid var(--color-outline);
	}
	.dot {
		width: 10px;
		height: 10px;
		border-radius: 50%;
		flex-shrink: 0;
	}
	.email {
		flex: 1;
		display: flex;
		flex-direction: column;
	}
	.email small {
		color: var(--color-text-disabled);
	}
	.status {
		font-size: var(--font-size-00, 0.72rem);
		color: var(--color-text-disabled);
	}
	.status.err {
		color: var(--color-bad, #c0392b);
	}
	.empty {
		padding: var(--size-5) 0;
	}
	.add {
		margin-top: var(--size-4);
	}
	.add.domain h3 {
		font-size: var(--font-size-1);
		margin-bottom: var(--size-1);
	}
	.domain-row {
		display: flex;
		gap: var(--size-2);
		align-items: center;
		max-width: 420px;
	}
	.domain-row :global(.input),
	.domain-row :global(label) {
		flex: 1;
	}
	.hint {
		margin-top: var(--size-2);
		font-size: var(--font-size-0);
	}
</style>
