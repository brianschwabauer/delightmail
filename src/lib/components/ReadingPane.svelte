<script lang="ts">
	import { untrack } from 'svelte';
	import { Avatar, Button } from '@delightstack/components';
	import { ripple } from '@delightstack/utilities';
	import Icon from './Icon.svelte';
	import type { MailDatabaseClient } from '$lib/clients';
	import type { Message, Thread } from '$lib/schema';
	import type { ThreadActionName } from '$lib/mail/actions';
	import { docToText } from '$lib/mail/compose';
	import { threadSenderLabel, parseParticipantText } from '$lib/mail/participants';
	import { useScope } from '$lib/mail/scope.svelte';
	import MessageBody from './MessageBody.svelte';

	const scope = useScope();

	interface Props {
		db: MailDatabaseClient;
		threadId: string | null;
		/** The thread under the list cursor, from the already-loaded list docs. Drives
		 *  an INSTANT header/snippet on every cursor move (yazi-style): the reader
		 *  repaints from in-memory data immediately, while the heavier message query +
		 *  body iframe (keyed on `threadId`) only fire once the cursor settles. */
		previewThread?: Thread | null;
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
		/** Mobile: the reader is a full-screen push — this closes it (back arrow). */
		onBack?: () => void;
	}
	const {
		db,
		threadId,
		previewThread = null,
		folder = null,
		markReadActive = true,
		onDocs,
		onReply,
		onAct,
		onEditDraft,
		onBack,
	}: Props = $props();

	// Reactive query function — the search re-queries when the open thread changes.
	const messages = db.search('message', () => ({
		where: { thread_id: threadId ?? '' },
		order: [{ key: 'date', direction: 'ASC' }],
		limit: 200,
	}));

	const docs = $derived(threadId ? ((messages.docs ?? []) as Message[]) : []);

	// Attachment chips for every message in the open thread (one live query;
	// filename/mime/size are all in the local index so this renders instantly,
	// offline included). `GET /api/attachments/:id` serves the bytes.
	interface AttachmentDoc {
		id: string;
		message_id: string;
		filename?: string;
		mime_type?: string;
		size_bytes?: number;
	}
	const attachmentDocs = db.search('attachment', () => ({
		where: {
			message_id: docs.length ? docs.map((m) => String(m.id)) : ['__none__'],
		},
		limit: 100,
	}));
	const attachmentsFor = $derived.by(() => {
		const map = new Map<string, AttachmentDoc[]>();
		for (const a of (attachmentDocs.docs ?? []) as unknown as AttachmentDoc[]) {
			const list = map.get(String(a.message_id)) ?? [];
			list.push(a);
			map.set(String(a.message_id), list);
		}
		return map;
	});
	function attIcon(mime?: string): 'image' | 'calendar' | 'file' {
		const m = (mime ?? '').toLowerCase();
		if (m.startsWith('image/')) return 'image';
		if (m.includes('calendar')) return 'calendar';
		return 'file';
	}
	function fmtSize(bytes?: number): string {
		const b = bytes ?? 0;
		if (b < 1024) return `${b} B`;
		if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
		return `${(b / (1024 * 1024)).toFixed(1)} MB`;
	}
	// Hand the loaded thread up to the page so reply/forward can act on messages
	// already in memory instead of issuing a fresh (possibly hanging) query.
	$effect(() => {
		onDocs?.(docs);
	});
	const latestId = $derived(docs.length ? docs[docs.length - 1].id : null);
	const subject = $derived(docs[0]?.subject || '(no subject)');
	const starred = $derived(docs.some((m) => m.is_starred));

	// --- instant preview gating (yazi-style) ---
	// `showMessages` = the loaded messages belong to the thread under the cursor, so
	// the real thread can render. Until then (fast scroll / still loading) the reader
	// keeps the SAME shell — subject, sender row, toolbar — and only the body swaps to
	// a shimmer skeleton, so holding ↑/↓ never shifts the layout, only its text.
	const loadedThreadId = $derived(docs.length ? String(docs[0].thread_id) : null);
	const ready = $derived(!!threadId && loadedThreadId === String(threadId));
	const showMessages = $derived(
		ready && (!previewThread || String(previewThread.id) === String(threadId)),
	);
	const headSubject = $derived(
		showMessages ? subject : previewThread?.subject || '(no subject)',
	);
	const headStarred = $derived(showMessages ? starred : !!previewThread?.starred);
	// Sender/date for the skeleton's message head — real data we already hold from the
	// list doc, so only the body content is unknown (and shimmers in).
	const previewFrom = $derived(
		threadSenderLabel(previewThread, {
			emails: scope.selfEmails,
			domains: scope.selfDomains,
		}) ||
			previewThread?.subject ||
			'(unknown)',
	);
	const previewDate = $derived(previewThread?.last_message_at ?? 0);

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
	// Draft-ness is known from the thread's folder BEFORE its messages load, so the
	// draft shell (Continue editing / Discard) shows immediately too — no toolbar flip
	// between the skeleton and the loaded reader.
	const isDraft = $derived(
		showMessages ? !!draftMsg : previewThread?.folder === 'drafts',
	);
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
		const anyUnread = docs.some((m) => !m.is_read);
		untrack(() => {
			markedThread = tid;
			if (anyUnread) void markRead(tid);
		});
	});

	/**
	 * ONE thread-level action instead of a serial load+save per unread message
	 * (opening a 6-unread thread used to cost 12 sequential round trips). The
	 * server marks every message, recounts thread.unread_count (which the old
	 * path never touched — the list badge stayed bold), and enqueues the Gmail
	 * write-back (which the generic PATCH path never did — reading here never
	 * marked the thread read in Gmail).
	 */
	async function markRead(tid: string) {
		// Optimistic: clear the list's unread badge within a frame.
		void db.applyLocalPatch('thread', tid, { unread_count: 0 } as never).catch(() => {});
		try {
			const res = await fetch('/api/threads/actions', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ thread_ids: [tid], action: 'read' }),
			});
			if (!res.ok) throw new Error(String(res.status));
		} catch {
			/* next open retries; the ws echo reconciles the overlay either way */
		}
	}

	// A message search hit only carries INDEXED fields, so `from`/`to` (objects) are
	// absent on anything not just written locally — `from_text` is indexed for
	// exactly this reason. Prefer the structured address, fall back to parsing it.
	function who(m: Message): string {
		const from = m.from?.name || m.from?.email;
		if (from) return from;
		const parsed = parseParticipantText(m.from_text)[0];
		return parsed?.name || parsed?.email || '(unknown)';
	}
	/** Empty when the recipients aren't loaded — better to omit the line than to
	 *  assert "to me" for a message that might be a cc or a list. */
	function recipients(m: Message): string {
		return m.to?.map((t) => t.name || t.email).filter(Boolean).join(', ') ?? '';
	}
	/**
	 * `body_keys` is not indexed either, so it is absent on every message that came
	 * from a search hit rather than a local write — reading `body_keys.html` there
	 * renders each message as a plain excerpt after a reload. When it's unknown,
	 * attempt the HTML body: MessageBody falls back to the excerpt by itself if the
	 * fetch comes back empty.
	 */
	function hasHtmlBody(m: Message): boolean {
		return m.body_keys ? !!m.body_keys.html : true;
	}
	function fmt(ts: number): string {
		return ts ? new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '';
	}
</script>

<!-- Shimmer stand-in for content that hasn't loaded yet (the body). Keeps the
     reader's layout identical between the instant preview and the settled reader —
     only these lines swap for the real body, so holding ↑/↓ never shifts the chrome. -->
{#snippet shimmer(widths: string[])}
	<div class="sk" aria-hidden="true">
		{#each widths as w}<div class="sk-line" style:width={w}></div>{/each}
	</div>
{/snippet}

{#if !threadId && !previewThread}
	<div class="placeholder">
		<div class="ph-mark" aria-hidden="true"><Icon name="mail" size={44} stroke={1.5} /></div>
		<p class="ph-title">No conversation open</p>
		<p class="ph-sub">Pick a message with <kbd>↵</kbd> or <kbd>→</kbd>. Move with <kbd>j</kbd>&nbsp;<kbd>k</kbd>.</p>
	</div>
{:else if isDraft}
	<article class="thread" aria-busy={!showMessages}>
		<header class="thread-head">
			<div class="head-col">
				<div class="subject-row">
					{#if onBack}
						<button class="backbtn" onclick={onBack} aria-label="Back to list">
							<Icon name="arrow-left" size={20} />
						</button>
					{/if}
					<span class="draft-tag">Draft</span>
					<h1 class="subject">{headSubject}</h1>
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
			{#if showMessages && draftMsg}
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
			{:else}
				<!-- Same fields shell; the body content shimmers in. -->
				<dl class="draft-fields">
					<div><dt>To</dt><dd>{previewFrom}</dd></div>
				</dl>
				{@render shimmer(['100%', '94%', '70%'])}
			{/if}
		</section>
	</article>
{:else}
	<article class="thread" aria-busy={!showMessages}>
		<header class="thread-head">
			<div class="head-col">
				<div class="subject-row">
					{#if onBack}
						<button class="backbtn" onclick={onBack} aria-label="Back to list">
							<Icon name="arrow-left" size={20} />
						</button>
					{/if}
					{#if headStarred}<span class="star" title="Starred"><Icon name="star" size={18} fill /></span>{/if}
					<h1 class="subject">{headSubject}</h1>
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

		{#if showMessages}
			{#each docs as m (m.id)}
				<section class="message" class:collapsed={!isExpanded(String(m.id))}>
					<button class="msg-head" onclick={() => toggle(String(m.id))} {@attach ripple({ opacity: 0.08 })}>
						<Avatar name={who(m)} size="2" />
						<span class="meta">
							<span class="from">{who(m)}</span>
							{#if recipients(m)}
								<span class="to">to {recipients(m)}</span>
							{/if}
						</span>
						<span class="date">{fmt(m.date)}</span>
					</button>
					{#if isExpanded(String(m.id))}
						<div class="body-surface">
							<MessageBody
								messageId={String(m.id)}
								excerpt={m.text_excerpt ?? ''}
								hasHtml={hasHtmlBody(m)} />
						</div>
						{#if attachmentsFor.get(String(m.id))?.length}
							<div class="attachments">
								{#each attachmentsFor.get(String(m.id)) ?? [] as att (att.id)}
									<a
										class="att-chip"
										href="/api/attachments/{encodeURIComponent(att.id)}"
										target="_blank"
										rel="noopener"
										title={att.filename || 'attachment'}>
										<Icon name={attIcon(att.mime_type)} size={15} />
										<span class="att-name">{att.filename || 'attachment'}</span>
										<span class="att-size">{fmtSize(att.size_bytes)}</span>
										<Icon name="download" size={13} class="att-dl" />
									</a>
								{/each}
							</div>
						{/if}
					{:else}
						<button class="snippet" onclick={() => toggle(String(m.id))}>{m.text_excerpt?.slice(0, 160) ?? ''}</button>
					{/if}
				</section>
			{/each}
		{:else}
			<!-- Skeleton: the SAME message shell (avatar, sender, date, framed body) as
			     the loaded reader, with the sender/date real and only the body shimmering. -->
			<section class="message">
				<div class="msg-head static">
					<Avatar name={previewFrom} size="2" />
					<span class="meta">
						<span class="from">{previewFrom}</span>
						<span class="to"><span class="sk-line inline" style:width="120px"></span></span>
					</span>
					<span class="date">{fmt(previewDate)}</span>
				</div>
				<div class="body-surface skeleton">
					{@render shimmer(['100%', '97%', '92%', '99%', '68%', '100%', '85%', '54%'])}
				</div>
			</section>
		{/if}
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
	/* --- Skeleton (cursor still moving / body not loaded yet) --- */
	/* A non-interactive message head, styled exactly like the real one so the layout
	   doesn't shift when the messages load. */
	.msg-head.static {
		cursor: default;
	}
	/* The framed body sheet is reused verbatim (same border/radius/shadow); only its
	   inner content swaps from shimmer lines to the iframe, so the card never jumps. */
	.body-surface.skeleton {
		background: var(--color-bg-1);
		min-height: 180px;
	}
	.sk {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
		padding: var(--space-4) var(--space-4);
	}
	.sk-line {
		height: 0.72em;
		border-radius: var(--radius-sm, 4px);
		background: var(--color-bg-3, var(--color-bg-2));
		position: relative;
		overflow: hidden;
	}
	.sk-line.inline {
		display: inline-block;
		height: 0.7em;
		vertical-align: middle;
	}
	/* The travelling highlight. Disabled under reduced-motion (the bars still read as
	   placeholders, just static). */
	.sk-line::after {
		content: '';
		position: absolute;
		inset: 0;
		transform: translateX(-100%);
		background: linear-gradient(
			90deg,
			transparent,
			color-mix(in oklab, var(--color-text) 9%, transparent),
			transparent
		);
		animation: sk-shimmer 1.4s ease-in-out infinite;
	}
	@media (prefers-reduced-motion: reduce) {
		.sk-line::after {
			animation: none;
		}
	}
	@keyframes sk-shimmer {
		100% {
			transform: translateX(100%);
		}
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
	.attachments {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
		margin-top: var(--space-2);
	}
	.att-chip {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		max-width: 280px;
		padding: 6px 10px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		background: var(--color-bg-0);
		color: inherit;
		text-decoration: none;
		font-size: var(--font-size-0);
		transition:
			border-color 120ms var(--ease-out, ease),
			background 120ms var(--ease-out, ease);
	}
	.att-chip:hover {
		border-color: color-mix(in oklab, var(--color-primary) 45%, var(--color-border));
		background: color-mix(in oklab, var(--color-primary) 5%, var(--color-bg-0));
	}
	.att-name {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.att-size {
		color: var(--color-text-disabled);
		font-variant-numeric: tabular-nums;
		flex-shrink: 0;
	}
	.att-chip :global(.att-dl) {
		color: var(--color-text-disabled);
		flex-shrink: 0;
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
	/* Mobile full-screen reader: a back arrow leads the header, the desktop
	   toolbar row gives way to the page's fixed bottom action bar (the draft
	   shell keeps its toolbar — "Continue editing" has no bottom-bar stand-in),
	   and the reading column hugs the narrower screen. */
	.backbtn {
		display: none;
	}
	@media (max-width: 767px) {
		.backbtn {
			display: grid;
			place-items: center;
			align-self: center;
			width: 40px;
			height: 40px;
			margin-left: calc(-1 * var(--space-2));
			border: none;
			border-radius: var(--radius-md);
			background: none;
			color: var(--color-text-muted, var(--color-text-disabled));
			cursor: pointer;
			flex-shrink: 0;
		}
		.backbtn:active {
			background: var(--color-bg-3);
		}
		article:not(:has(.draft-tag)) .toolbar {
			display: none;
		}
		.head-col,
		.message,
		.draft-preview {
			padding-left: var(--space-3);
			padding-right: var(--space-3);
		}
		.ph-sub {
			display: none;
		}
	}
</style>
