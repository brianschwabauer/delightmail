<script lang="ts">
	import { untrack } from 'svelte';
	import type { MailDatabaseClient } from '$lib/clients';
	import type { Message } from '$lib/schema';
	import MessageBody from './MessageBody.svelte';

	interface Props {
		db: MailDatabaseClient;
		threadId: string | null;
	}
	const { db, threadId }: Props = $props();

	// Reactive query function — the search re-queries when the open thread changes.
	const messages = db.search('message', () => ({
		where: { thread_id: threadId ?? '' },
		order: [{ key: 'date', direction: 'ASC' }],
		limit: 200,
	}));

	const docs = $derived(threadId ? ((messages.docs ?? []) as Message[]) : []);
	const latestId = $derived(docs.length ? docs[docs.length - 1].id : null);

	// Expansion: latest message open by default, plus explicit user toggles.
	// Reset the overrides when the open thread changes (untracked to avoid loops).
	let overrides = $state<Map<string, boolean>>(new Map());
	let currentThread = $state<string | null>(null);
	$effect(() => {
		const t = threadId;
		if (t !== untrack(() => currentThread)) {
			untrack(() => {
				currentThread = t;
				overrides = new Map();
			});
		}
	});

	function isExpanded(id: string): boolean {
		return overrides.has(id) ? overrides.get(id)! : id === latestId;
	}
	function toggle(id: string) {
		const next = new Map(overrides);
		next.set(id, !isExpanded(id));
		overrides = next;
	}

	// Mark unread messages read on open. Guarded to run once per thread so the
	// save→re-query→effect cycle can't thrash the reactive engine.
	let markedThread = $state<string | null>(null);
	$effect(() => {
		const tid = threadId;
		if (!tid || docs.length === 0) return;
		if (untrack(() => markedThread) === tid) return;
		const unread = docs.filter((m) => !m.is_read);
		untrack(() => {
			markedThread = tid;
			if (unread.length) void markRead(unread);
		});
	});

	async function markRead(unread: Message[]) {
		for (const m of unread) {
			try {
				const e = db.entity('message', m.id);
				await e.load();
				await e.save({ is_read: true });
			} catch {
				/* ignore */
			}
		}
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
			<section class="message" class:collapsed={!isExpanded(m.id)}>
				<button class="msg-head" onclick={() => toggle(m.id)}>
					<span class="avatar" aria-hidden="true">{who(m).charAt(0).toUpperCase()}</span>
					<span class="meta">
						<span class="from">{who(m)}</span>
						<span class="to">to {m.to?.map((t) => t.name || t.email).join(', ') || 'me'}</span>
					</span>
					<span class="date">{fmt(m.date)}</span>
				</button>
				{#if isExpanded(m.id)}
					<MessageBody
						messageId={m.id}
						excerpt={m.text_excerpt ?? ''}
						hasHtml={!!m.body_keys?.html} />
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
