<script lang="ts">
	import type { MailDatabaseClient } from '$lib/clients';
	import type { Message } from '$lib/schema';
	import MessageBody from './MessageBody.svelte';

	interface Props {
		db: MailDatabaseClient;
		threadId: string | null;
	}
	const { db, threadId }: Props = $props();

	// Live messages for the open thread, oldest first.
	const messages = $derived(
		threadId
			? db.search('message', {
					where: { thread_id: threadId },
					order: [{ key: 'date', direction: 'ASC' }],
					limit: 200,
				})
			: null,
	);

	const docs = $derived((messages?.docs ?? []) as Message[]);

	// Which messages are expanded — latest expanded by default.
	let expanded = $state<Set<string>>(new Set());
	let lastThread = $state<string | null>(null);
	$effect(() => {
		if (threadId !== lastThread) {
			lastThread = threadId;
			const next = new Set<string>();
			if (docs.length) next.add(docs[docs.length - 1].id);
			expanded = next;
			// Mark the thread read on open (optimistic).
			markRead();
		}
	});

	async function markRead() {
		if (!threadId) return;
		for (const m of docs) {
			if (!m.is_read) {
				try {
					const e = db.entity('message', m.id);
					await e.load();
					await e.save({ is_read: true });
				} catch {
					/* ignore */
				}
			}
		}
	}

	function toggle(id: string) {
		const next = new Set(expanded);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		expanded = next;
	}

	function who(m: Message): string {
		return m.from?.name || m.from?.email || '(unknown)';
	}
	function fmt(ts: number): string {
		return ts ? new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '';
	}
</script>

{#if !threadId}
	<div class="placeholder"><p>Select a message to read.</p></div>
{:else}
	<article class="thread">
		<h1 class="subject">{docs[0]?.subject || '(no subject)'}</h1>
		{#each docs as m (m.id)}
			<section class="message" class:collapsed={!expanded.has(m.id)}>
				<button class="msg-head" onclick={() => toggle(m.id)}>
					<span class="avatar" aria-hidden="true">{who(m).charAt(0).toUpperCase()}</span>
					<span class="meta">
						<span class="from">{who(m)}</span>
						<span class="to">to {m.to?.map((t) => t.name || t.email).join(', ') || 'me'}</span>
					</span>
					<span class="date">{fmt(m.date)}</span>
				</button>
				{#if expanded.has(m.id)}
					<MessageBody messageId={m.id} excerpt={m.text_excerpt ?? ''} />
				{:else}
					<div class="snippet">{m.text_excerpt?.slice(0, 140) ?? ''}</div>
				{/if}
			</section>
		{/each}
	</article>
{/if}

<style>
	.placeholder,
	.thread {
		height: 100%;
		overflow-y: auto;
	}
	.placeholder {
		display: grid;
		place-items: center;
		color: var(--color-text-disabled);
	}
	.thread {
		padding: var(--size-4) var(--size-5);
	}
	.subject {
		font-size: var(--font-size-3);
		margin: 0 0 var(--size-4);
		line-height: 1.25;
	}
	.message {
		border: 1px solid var(--color-outline);
		border-radius: var(--radius-3);
		margin-bottom: var(--size-3);
		overflow: hidden;
	}
	.msg-head {
		display: flex;
		align-items: center;
		gap: var(--size-3);
		width: 100%;
		background: var(--color-bg-2);
		border: none;
		padding: var(--size-2) var(--size-3);
		cursor: pointer;
		text-align: left;
		font: inherit;
	}
	.avatar {
		width: 30px;
		height: 30px;
		border-radius: 50%;
		background: var(--color-primary);
		color: white;
		display: grid;
		place-items: center;
		font-weight: 700;
		flex-shrink: 0;
	}
	.meta {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}
	.from {
		font-weight: 600;
		font-size: var(--font-size-0);
	}
	.to {
		font-size: var(--font-size-00, 0.72rem);
		color: var(--color-text-disabled);
	}
	.date {
		margin-left: auto;
		font-size: var(--font-size-00, 0.72rem);
		color: var(--color-text-disabled);
		flex-shrink: 0;
	}
	.snippet {
		padding: var(--size-2) var(--size-3);
		color: var(--color-text-disabled);
		font-size: var(--font-size-0);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
</style>
