<script lang="ts">
	import { untrack } from 'svelte';
	import { Avatar, Button } from '@delightstack/components';
	import type { MailDatabaseClient } from '$lib/clients';
	import type { Message } from '$lib/schema';
	import type { ThreadActionName } from '$lib/mail/actions';
	import MessageBody from './MessageBody.svelte';

	interface Props {
		db: MailDatabaseClient;
		threadId: string | null;
		onReply?: (kind: 'reply' | 'reply_all' | 'forward') => void;
		onAct?: (action: ThreadActionName) => void;
	}
	const { db, threadId, onReply, onAct }: Props = $props();

	// Reactive query function — the search re-queries when the open thread changes.
	const messages = db.search('message', () => ({
		where: { thread_id: threadId ?? '' },
		order: [{ key: 'date', direction: 'ASC' }],
		limit: 200,
	}));

	const docs = $derived(threadId ? ((messages.docs ?? []) as Message[]) : []);
	const latestId = $derived(docs.length ? docs[docs.length - 1].id : null);
	const subject = $derived(docs[0]?.subject || '(no subject)');
	const starred = $derived(docs.some((m) => m.is_starred));

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
	function recipients(m: Message): string {
		return m.to?.map((t) => t.name || t.email).join(', ') || 'me';
	}
	function fmt(ts: number): string {
		return ts ? new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '';
	}
</script>

{#if !threadId}
	<div class="placeholder">
		<div class="ph-mark" aria-hidden="true">✉</div>
		<p class="ph-title">No conversation open</p>
		<p class="ph-sub">Pick a message with <kbd>↵</kbd> or <kbd>→</kbd>. Move with <kbd>j</kbd>&nbsp;<kbd>k</kbd>.</p>
	</div>
{:else}
	<article class="thread">
		<header class="thread-head">
			<div class="subject-row">
				{#if starred}<span class="star" title="Starred">★</span>{/if}
				<h1 class="subject">{subject}</h1>
			</div>
			{#if onReply || onAct}
				<div class="toolbar">
					{#if onReply}
						<Button size="0" transparent onclick={() => onReply('reply')}>Reply</Button>
						<Button size="0" transparent onclick={() => onReply('reply_all')}>Reply all</Button>
						<Button size="0" transparent onclick={() => onReply('forward')}>Forward</Button>
					{/if}
					{#if onAct}
						<span class="tb-gap"></span>
						<Button size="0" transparent onclick={() => onAct('archive')}>Archive</Button>
						<Button size="0" transparent onclick={() => onAct('trash')}>Trash</Button>
					{/if}
				</div>
			{/if}
		</header>

		{#each docs as m (m.id)}
			<section class="message" class:collapsed={!isExpanded(String(m.id))}>
				<button class="msg-head" onclick={() => toggle(String(m.id))}>
					<Avatar name={who(m)} size="2" />
					<span class="meta">
						<span class="from">{who(m)}</span>
						<span class="to">to {recipients(m)}</span>
					</span>
					<span class="date">{fmt(m.date)}</span>
				</button>
				{#if isExpanded(String(m.id))}
					<MessageBody
						messageId={String(m.id)}
						excerpt={m.text_excerpt ?? ''}
						hasHtml={!!m.body_keys?.html} />
				{:else}
					<button class="snippet" onclick={() => toggle(String(m.id))}>{m.text_excerpt?.slice(0, 160) ?? ''}</button>
				{/if}
			</section>
		{/each}
	</article>
{/if}

<style>
	.placeholder,
	.thread {
		height: 100%;
	}
	.placeholder {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: var(--space-2);
		color: var(--color-text-disabled);
		text-align: center;
		padding: var(--space-6);
	}
	.ph-mark {
		font-size: 2.5rem;
		opacity: 0.5;
	}
	.ph-title {
		font-size: var(--font-size-1);
		color: var(--color-text);
		margin: 0;
	}
	.ph-sub {
		margin: 0;
		font-size: var(--font-size-0);
	}
	.thread {
		overflow-y: auto;
	}
	.thread-head {
		position: sticky;
		top: 0;
		z-index: 1;
		background: var(--color-bg-1);
		padding: var(--space-4) var(--space-5) var(--space-3);
		border-bottom: 1px solid var(--color-border);
	}
	.subject-row {
		display: flex;
		align-items: baseline;
		gap: var(--space-2);
	}
	.star {
		color: var(--color-warning);
		font-size: var(--font-size-2);
	}
	.subject {
		font-size: var(--font-size-3);
		font-weight: var(--font-weight-semibold, 600);
		letter-spacing: -0.01em;
		margin: 0;
		line-height: 1.25;
	}
	.toolbar {
		display: flex;
		align-items: center;
		gap: 2px;
		margin-top: var(--space-2);
		flex-wrap: wrap;
	}
	.tb-gap {
		width: 1px;
		align-self: stretch;
		margin: 2px var(--space-2);
		background: var(--color-border);
	}
	.message {
		max-width: 76ch;
		margin: var(--space-3) auto;
		padding: 0 var(--space-5);
	}
	.message + .message {
		border-top: 1px solid var(--dm-hairline);
		padding-top: var(--space-3);
	}
	.msg-head {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		width: 100%;
		background: none;
		border: none;
		padding: 0;
		cursor: pointer;
		text-align: left;
		font: inherit;
	}
	.meta {
		display: flex;
		flex-direction: column;
		min-width: 0;
		flex: 1;
	}
	.from {
		font-weight: var(--font-weight-semibold, 600);
		font-size: var(--font-size-0);
	}
	.to {
		font-size: var(--font-size-00);
		color: var(--color-text-disabled);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.date {
		margin-left: auto;
		font-size: var(--font-size-00);
		color: var(--color-text-disabled);
		font-variant-numeric: tabular-nums;
		flex-shrink: 0;
	}
	.snippet {
		display: block;
		width: 100%;
		text-align: left;
		margin-top: var(--space-2);
		padding: 0;
		background: none;
		border: none;
		color: var(--color-text-disabled);
		font: inherit;
		font-size: var(--font-size-0);
		cursor: pointer;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	kbd {
		font-family: var(--font-mono);
		font-size: 0.85em;
		background: var(--color-bg-2);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-sm);
		padding: 0 5px;
	}
</style>
