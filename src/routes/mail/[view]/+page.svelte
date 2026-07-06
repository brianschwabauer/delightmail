<script lang="ts">
	import { viewToQuery, viewTitle } from '$lib/mail/views';

	const { data } = $props();
	const { db, view } = $derived(data);

	const query = $derived(viewToQuery(view));
	const threads = $derived(db.search('thread', query));
	const title = $derived(viewTitle(view));
</script>

<svelte:head><title>{title} · Mail</title></svelte:head>

<section class="list-pane">
	<header class="list-head">
		<h1>{title}</h1>
	</header>

	{#if threads.docs.length === 0}
		<div class="empty">
			{#if threads.loading}
				<p>Loading…</p>
			{:else}
				<p class="muted">No mail here yet.</p>
				<p class="hint">Connect a mail account in Settings to start mirroring your inbox.</p>
			{/if}
		</div>
	{:else}
		<ul class="rows">
			{#each threads.docs as t (t.id)}
				<li class="row" class:unread={t.unread_count > 0}>
					<div class="from">{t.participant_text || t.subject}</div>
					<div class="subject">{t.subject}</div>
				</li>
			{/each}
		</ul>
	{/if}
</section>

<div class="reading-pane">
	<p class="muted">Select a message to read.</p>
</div>

<style>
	.list-pane {
		width: 340px;
		border-right: 1px solid var(--color-outline);
		display: flex;
		flex-direction: column;
		overflow: hidden;
	}
	.list-head {
		padding: var(--size-3);
		border-bottom: 1px solid var(--color-outline);
	}
	.list-head h1 {
		font-size: var(--font-size-2);
		margin: 0;
	}
	.rows {
		list-style: none;
		margin: 0;
		padding: 0;
		overflow-y: auto;
	}
	.row {
		padding: var(--size-2) var(--size-3);
		border-bottom: 1px solid var(--color-outline);
		cursor: pointer;
	}
	.row.unread .from {
		font-weight: 700;
	}
	.from {
		font-size: var(--font-size-0);
	}
	.subject {
		font-size: var(--font-size-0);
		color: var(--color-text-disabled);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.reading-pane {
		flex: 1;
		padding: var(--size-5);
		overflow-y: auto;
	}
	.empty {
		padding: var(--size-6) var(--size-4);
		text-align: center;
	}
	.muted {
		color: var(--color-text-disabled);
	}
	.hint {
		font-size: var(--font-size-0);
		color: var(--color-text-disabled);
	}
</style>
