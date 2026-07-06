<script lang="ts">
	const { data } = $props();
	const { db } = $derived(data);

	const accounts = db.search('account', { limit: 50 });
</script>

<svelte:head><title>Accounts · Settings</title></svelte:head>

<h2>Mail accounts</h2>
<p class="muted">Connect Gmail, IMAP, or a Cloudflare-routed custom domain.</p>

{#if accounts.docs.length === 0}
	<div class="empty">
		<p>No accounts connected yet.</p>
	</div>
{:else}
	<ul class="accounts">
		{#each accounts.docs as a (a.id)}
			<li>
				<span class="dot" style:background={a.color || 'var(--color-primary)'}></span>
				<span class="email">{a.email}</span>
				<span class="status">{a.status}</span>
			</li>
		{/each}
	</ul>
{/if}

<div class="add">
	<p class="muted">Account connection is enabled in P1 (Gmail), P4 (domain), P7 (IMAP).</p>
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
		gap: var(--size-2);
		padding: var(--size-2) 0;
		border-bottom: 1px solid var(--color-outline);
	}
	.dot {
		width: 10px;
		height: 10px;
		border-radius: 50%;
	}
	.email {
		flex: 1;
	}
	.status {
		font-size: var(--font-size-00, 0.72rem);
		color: var(--color-text-disabled);
	}
	.empty {
		padding: var(--size-5) 0;
	}
</style>
