<script lang="ts">
	import { untrack } from 'svelte';
	import { Avatar, Button } from '@delightstack/components';
	import { ripple } from '@delightstack/utilities';
	import Icon from './Icon.svelte';
	import type { MailDatabaseClient } from '$lib/clients';
	import type { Message } from '$lib/schema';
	import type { ThreadActionName } from '$lib/mail/actions';
	import { docToText } from '$lib/mail/compose';
	import MessageBody from './MessageBody.svelte';

	interface Props {
		db: MailDatabaseClient;
		threadId: string | null;
		/** The open thread's folder — drives the Archive ↔ Unarchive toggle. */
		folder?: string | null;
		/** Whether the reader currently owns focus (i.e. the thread was actually
		 *  opened, not just previewed by moving the list cursor). Marking-read is
		 *  gated on this so scrolling the list with j/k never silently reads mail. */
		markReadActive?: boolean;
		/** Surfaces the loaded messages of the open thread so the page can reply/
		 *  forward from data already in hand — no extra round-trip that could hang. */
		onDocs?: (messages: Message[]) => void;
		onReply?: (kind: 'reply' | 'reply_all' | 'forward') => void;
		onAct?: (action: ThreadActionName, opts?: { folder?: string }) => void;
		/** Resume the previewed draft in the compose overlay (Drafts folder). */
		onEditDraft?: () => void;
	}
	const {
		db,
		threadId,
		folder = null,
		markReadActive = true,
		onDocs,
		onReply,
		onAct,
		onEditDraft,
	}: Props = $props();

	// Reactive query function — the search re-queries when the open thread changes.
	const messages = db.search('message', () => ({
		where: { thread_id: threadId ?? '' },
		order: [{ key: 'date', direction: 'ASC' }],
		limit: 200,
	}));

	const docs = $derived(threadId ? ((messages.docs ?? []) as Message[]) : []);
	// Hand the loaded thread up to the page so reply/forward can act on messages
	// already in memory instead of issuing a fresh (possibly hanging) query.
	$effect(() => {
		onDocs?.(docs);
	});
	const latestId = $derived(docs.length ? docs[docs.length - 1].id : null);
	const subject = $derived(docs[0]?.subject || '(no subject)');
	const starred = $derived(docs.some((m) => m.is_starred));

	// A standalone draft thread (every message is a draft) gets a read-only preview
	// instead of the normal reader; Enter/→ resumes it in the compose overlay.
	const draftMsg = $derived(docs.length > 0 && docs.every((m) => m.is_draft) ? docs[0] : null);
	const draftBody = $derived.by(() => {
		if (!draftMsg?.draft_doc) return '';
		try {
			return docToText(JSON.parse(draftMsg.draft_doc)).trim();
		} catch {
			return '';
		}
	});
	function addrList(list: Message['to']): string {
		return (list ?? []).map((a) => a.name || a.email).filter(Boolean).join(', ');
	}

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
		// Only mark-read once the reader is actually focused — a mere preview
		// (cursor move with focus still in the list) must leave mail untouched.
		if (!tid || docs.length === 0 || !markReadActive) return;
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
		<div class="ph-mark" aria-hidden="true"><Icon name="mail" size={44} stroke={1.5} /></div>
		<p class="ph-title">No conversation open</p>
		<p class="ph-sub">Pick a message with <kbd>↵</kbd> or <kbd>→</kbd>. Move with <kbd>j</kbd>&nbsp;<kbd>k</kbd>.</p>
	</div>
{:else if draftMsg}
	<article class="thread">
		<header class="thread-head">
			<div class="head-col">
				<div class="subject-row">
					<span class="draft-tag">Draft</span>
					<h1 class="subject">{draftMsg.subject || '(no subject)'}</h1>
				</div>
				<div class="toolbar">
					<Button size="0" accent onclick={() => onEditDraft?.()}>
						<Icon name="pencil" size={15} /> Continue editing
					</Button>
					{#if onAct}
						<span class="tb-gap"></span>
						<Button size="0" transparent onclick={() => onAct('trash')}>
							<Icon name="trash" size={15} /> Discard
						</Button>
					{/if}
				</div>
			</div>
		</header>
		<section class="message draft-preview">
			<dl class="draft-fields">
				<div><dt>To</dt><dd>{addrList(draftMsg.to) || '—'}</dd></div>
				{#if draftMsg.cc?.length}<div><dt>Cc</dt><dd>{addrList(draftMsg.cc)}</dd></div>{/if}
			</dl>
			{#if draftBody}
				<p class="draft-body">{draftBody}</p>
			{:else}
				<p class="draft-empty">This draft is empty.</p>
			{/if}
			<p class="draft-hint">Press <kbd>↵</kbd> or <kbd>→</kbd> to keep writing.</p>
		</section>
	</article>
{:else}
	<article class="thread">
		<header class="thread-head">
			<div class="head-col">
				<div class="subject-row">
					{#if starred}<span class="star" title="Starred"><Icon name="star" size={18} fill /></span>{/if}
					<h1 class="subject">{subject}</h1>
				</div>
				{#if onReply || onAct}
					<div class="toolbar">
						{#if onReply}
							<Button size="0" transparent onclick={() => onReply('reply')}><Icon name="reply" size={15} /> Reply</Button>
							<Button size="0" transparent onclick={() => onReply('reply_all')}><Icon name="reply-all" size={15} /> Reply all</Button>
							<Button size="0" transparent onclick={() => onReply('forward')}><Icon name="forward" size={15} /> Forward</Button>
						{/if}
						{#if onAct}
							<span class="tb-gap"></span>
							{#if folder === 'archive'}
								<Button size="0" transparent onclick={() => onAct('move', { folder: 'inbox' })}><Icon name="inbox" size={15} /> Unarchive</Button>
							{:else}
								<Button size="0" transparent onclick={() => onAct('archive')}><Icon name="archive" size={15} /> Archive</Button>
							{/if}
							<Button size="0" transparent onclick={() => onAct('trash')}><Icon name="trash" size={15} /> Trash</Button>
						{/if}
					</div>
				{/if}
			</div>
		</header>

		{#each docs as m (m.id)}
			<section class="message" class:collapsed={!isExpanded(String(m.id))}>
				<button class="msg-head" onclick={() => toggle(String(m.id))} {@attach ripple({ opacity: 0.08 })}>
					<Avatar name={who(m)} size="2" />
					<span class="meta">
						<span class="from">{who(m)}</span>
						<span class="to">to {recipients(m)}</span>
					</span>
					<span class="date">{fmt(m.date)}</span>
				</button>
				{#if isExpanded(String(m.id))}
					<div class="body-surface">
						<MessageBody
							messageId={String(m.id)}
							excerpt={m.text_excerpt ?? ''}
							hasHtml={!!m.body_keys?.html} />
					</div>
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
		padding: var(--space-4) 0 var(--space-3);
		border-bottom: 1px solid var(--color-border);
	}
	/* The header bar stays full-bleed (background + divider span the pane), but its
	   content rides the same centered column as the message bodies below — so the
	   subject and actions line up with the reading column instead of hugging the
	   pane's left edge. Keep this max-width in sync with .message / .draft-preview. */
	.head-col {
		max-width: 76ch;
		margin: 0 auto;
		padding: 0 var(--space-5);
	}
	.subject-row {
		display: flex;
		align-items: baseline;
		gap: var(--space-2);
	}
	.star {
		display: inline-flex;
		align-items: center;
		color: var(--color-warning);
	}
	/* --- Draft preview --- */
	.draft-tag {
		align-self: center;
		font-size: var(--font-size-00);
		font-weight: var(--font-weight-semibold, 600);
		letter-spacing: 0.02em;
		text-transform: uppercase;
		color: var(--color-primary);
		background: var(--dm-accent-soft);
		padding: 2px var(--space-2);
		border-radius: var(--radius-cap, 99px);
	}
	.draft-preview {
		max-width: 76ch;
		margin: var(--space-4) auto;
		padding: 0 var(--space-5);
	}
	.draft-fields {
		margin: 0 0 var(--space-4);
		padding: 0 0 var(--space-3);
		border-bottom: 1px solid var(--dm-hairline);
	}
	.draft-fields > div {
		display: flex;
		gap: var(--space-2);
		font-size: var(--font-size-0);
		padding: 2px 0;
	}
	.draft-fields dt {
		width: 40px;
		flex-shrink: 0;
		color: var(--color-text-disabled);
	}
	.draft-fields dd {
		margin: 0;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.draft-body {
		margin: 0;
		white-space: pre-wrap;
		line-height: 1.6;
		color: var(--color-text);
	}
	.draft-empty {
		margin: 0;
		color: var(--color-text-disabled);
		font-style: italic;
	}
	.draft-hint {
		margin: var(--space-5) 0 0;
		font-size: var(--font-size-00);
		color: var(--color-text-disabled);
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
	/* The message body sits on a contained "sheet" so HTML email (rendered on its
	   own white iframe background) reads as an intentional card instead of a slab
	   bleeding edge-to-edge — which is especially jarring in dark mode. overflow
	   clips the iframe's corners to the radius; the border carries the edge. */
	.body-surface {
		margin-top: var(--space-3);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		overflow: hidden;
		background: var(--color-bg-0);
		box-shadow: 0 1px 2px color-mix(in oklab, black 6%, transparent);
	}
	.msg-head {
		position: relative;
		overflow: hidden;
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
