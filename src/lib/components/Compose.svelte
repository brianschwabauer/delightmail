<script lang="ts">
	import { tick, onMount } from 'svelte';
	import { Editor as EditorClass, defaultBlocks } from '@delightstack/editor';
	// The package's generated Editor.svelte.d.ts has an internal name collision
	// (component `Editor` vs the core `Editor` type it imports), so the named
	// re-export resolves type-only under verbatimModuleSyntax. A namespace import
	// is unambiguously a value import; pull the component off it.
	import * as EditorComponents from '@delightstack/editor/components';
	// The same .d.ts collision types the value as the editor INSTANCE, not the
	// component, so cast it back to a Svelte component that takes `editor`.
	const EditorView = EditorComponents.Editor as unknown as import('svelte').Component<{
		editor: EditorClass;
	}>;
	import { Avatar, Button, Expand, Input, Modal, toast } from '@delightstack/components';
	import type { InputOption } from '@delightstack/components';
	import Icon from './Icon.svelte';
	import type { MailDatabaseClient } from '$lib/clients';
	import type { Address, Identity } from '$lib/schema';
	import { contactAvatarUrl } from '$lib/mail/avatar';
	import { mergeSignatureDoc, docToText } from '$lib/mail/compose';
	import { DraftAutosaver } from '$lib/mail/draft-autosave';

	export interface ComposeInit {
		to?: Address[];
		cc?: Address[];
		bcc?: Address[];
		subject?: string;
		bodyDoc?: unknown;
		identity_id?: string;
		in_reply_to?: string;
		references?: string[];
		thread_id?: string;
		/** Set when editing an existing draft so autosave updates it in place. */
		draft_id?: string;
	}

	interface Props {
		db: MailDatabaseClient;
		init: ComposeInit;
		onClose: () => void;
	}
	const { db, init, onClose }: Props = $props();

	// The Modal is open for the lifetime of this component (it only mounts while a
	// draft is being composed). Closing it — Escape, backdrop, or the ✕ — resolves
	// through `onClose`, which unmounts us. Escape is owned by the Modal alone, so
	// it can no longer leak past compose to close the mail you were reading.
	let open = $state(true);

	const MAX_TOTAL_BYTES = 25 * 1024 * 1024;

	interface Attachment {
		id: string;
		filename: string;
		size: number;
		mime_type: string;
		r2_key: string;
		uploading: boolean;
	}

	const identities = db.search('identity', { limit: 50 });

	let identityId = $state(init.identity_id ?? '');
	let showCc = $state((init.cc?.length ?? 0) > 0);
	let showBcc = $state((init.bcc?.length ?? 0) > 0);
	// Recipients are held as the delightstack <Input multiple> value: a string[]
	// of chips. Each chip is the email address (a picked contact stores its email;
	// a typed "Name <email>" is kept verbatim) — both round-trip back to an
	// Address via parseAddress. Display names for picked/known contacts live in
	// `nameByEmail` so the sent message still carries them (chips show the email).
	let to = $state<string[]>(initChips(init.to));
	let cc = $state<string[]>(initChips(init.cc));
	let bcc = $state<string[]>(initChips(init.bcc));
	let subject = $state(init.subject ?? '');
	let sending = $state(false);
	let attachments = $state<Attachment[]>([]);
	let fileInput = $state<HTMLInputElement>();
	let overlayEl = $state<HTMLElement>();

	// email → display name, so a chip (which shows only the email) can still be
	// reconstituted into a named Address at send time. Primed from any incoming
	// draft and topped up as autocomplete options stream in. Plain map (a lookup
	// cache, not reactive UI state).
	const nameByEmail = new Map<string, string>();
	for (const a of [...(init.to ?? []), ...(init.cc ?? []), ...(init.bcc ?? [])]) {
		if (a.email && a.name) nameByEmail.set(a.email.toLowerCase(), a.name);
	}

	const editor = new EditorClass({
		placeholder: 'Write your message…',
		blocks: defaultBlocks(),
		content: (init.bodyDoc as never) ?? undefined,
	});

	const fromIdentity = $derived(
		(identities.docs as Identity[]).find((i) => String(i.id) === identityId) ??
			(identities.docs[0] as Identity | undefined),
	);

	// The Send button is enabled only when the message can actually go out: at
	// least one committed recipient chip, a sending identity, and no attachment
	// mid-upload. (A half-typed address must be committed — Enter/Tab/comma, or
	// picking a suggestion — before it counts, which is standard chip behavior.)
	const canSend = $derived(
		!sending && !!fromIdentity && to.length > 0 && !attachments.some((a) => a.uploading),
	);

	// --- draft autosave (§6): every 3s of idle, persist to a draft row. The saver
	// serializes saves, so fast typing during an in-flight create can't spawn a
	// second create (duplicate/orphan drafts). ---
	let sent = $state(false);

	function currentSig(): string {
		return JSON.stringify({ s: subject, t: to, c: cc, d: editor.doc });
	}
	function hasContent(): boolean {
		return !!(subject.trim() || to.length || docToText(editor.doc).trim());
	}

	const saver = new DraftAutosaver(
		{
			signature: currentSig,
			hasContent,
			save: async (id) => {
				if (!fromIdentity) throw new Error('no identity to save under');
				const res = await fetch('/api/drafts', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({
						draft_id: id,
						identity_id: fromIdentity.id,
						to: toAddresses(to),
						cc: showCc ? toAddresses(cc) : [],
						subject,
						doc: editor.doc,
					}),
				});
				if (!res.ok) throw new Error('draft save failed');
				return ((await res.json()) as { draft_id: string }).draft_id;
			},
			remove: async (id) => {
				await fetch(`/api/drafts/${encodeURIComponent(id)}`, { method: 'DELETE' });
			},
		},
		init.draft_id,
	);

	onMount(() => {
		if (!identityId && identities.docs.length) {
			identityId = String((identities.docs[0] as Identity).id);
		}
		// Land the cursor in the first empty recipient field the moment compose
		// opens — and, because focus is now inside the overlay, Esc reaches the
		// overlay's own handler (fixing "n then Esc doesn't close it").
		void tick().then(() => {
			overlayEl?.querySelector<HTMLInputElement>('#to')?.focus();
		});
		const timer = setInterval(() => {
			if (sent || sending || !fromIdentity) return;
			void saver.tick();
		}, 3000);
		return () => {
			clearInterval(timer);
			editor.destroy();
		};
	});

	// Signature preview (§10.3): shown below the body, swapped when the identity
	// changes, and merged into the doc at send time without touching what's written.
	const signatureDoc = $derived.by(() => {
		const raw = fromIdentity?.signature_doc;
		if (!raw) return null;
		try {
			return JSON.parse(raw) as { type: string; content?: unknown[] };
		} catch {
			return null;
		}
	});
	const signaturePreview = $derived(signatureDoc ? docToText(signatureDoc) : '');

	function parseAddress(raw: string): Address | null {
		const trimmed = raw.trim().replace(/[,;]+$/, '');
		if (!trimmed) return null;
		const m = trimmed.match(/^(.*)<(.+@.+)>$/);
		if (m) return { name: m[1].trim() || undefined, email: m[2].trim() };
		if (/^[^@\s]+@[^@\s]+$/.test(trimmed)) return { email: trimmed };
		return null;
	}
	// Address[] (from init/draft) → chip strings for <Input multiple>. We store the
	// bare email as the chip and stash the name in `nameByEmail` for send time.
	function initChips(list?: Address[]): string[] {
		return (list ?? []).map((a) => a.email).filter((e): e is string => !!e);
	}
	// Chip strings → deduped, named Address[] for the draft/send payloads.
	function toAddresses(chips: string[]): Address[] {
		const out: Address[] = [];
		const seen = new Set<string>();
		for (const chip of chips) {
			const a = parseAddress(chip);
			if (!a?.email) continue;
			const key = a.email.toLowerCase();
			if (seen.has(key)) continue;
			seen.add(key);
			out.push({ email: a.email, name: a.name ?? nameByEmail.get(key) });
		}
		return out;
	}

	// <Input onfilter> — one-shot contact search feeding the autocomplete panel.
	// Ranks known correspondents first (send_count), drops anyone already added
	// across To/Cc/Bcc, and records each name so the chip's email can be re-named
	// at send. label === the email so the picked chip is the address itself. An
	// empty query (e.g. the panel refreshing right after a pick) lists the most
	// frequent contacts so adding several recipients stays a keyboard flow.
	async function contactOptions(query: string): Promise<InputOption[]> {
		const term = query.trim();
		const chosen = new Set(
			[...to, ...cc, ...bcc].map((c) => (parseAddress(c)?.email ?? c).toLowerCase()),
		);
		const res = await db.list(
			'contact',
			term
				? { term, limit: 8 }
				: { limit: 8, order: [{ key: 'send_count', direction: 'DESC' }] },
		);
		return (res.hits ?? [])
			.map((h) => h.document as { email?: string; name?: string; send_count?: number })
			.filter((c) => c.email && !chosen.has(c.email.toLowerCase()))
			.sort((a, b) => (b.send_count ?? 0) - (a.send_count ?? 0))
			.slice(0, 6)
			.map((c) => {
				const email = c.email!.toLowerCase();
				if (c.name) nameByEmail.set(email, c.name);
				return { value: email, label: email, description: c.name };
			});
	}

	function cycleIdentity(): void {
		const list = identities.docs as Identity[];
		if (list.length < 2) return;
		const idx = list.findIndex((i) => String(i.id) === identityId);
		identityId = String(list[(idx + 1) % list.length].id);
	}

	// --- attachments ---
	function totalBytes(): number {
		return attachments.reduce((n, a) => n + a.size, 0);
	}
	async function addFiles(files: FileList | File[]): Promise<void> {
		for (const file of Array.from(files)) {
			if (totalBytes() + file.size > MAX_TOTAL_BYTES) {
				toast('Attachments exceed the 25 MB limit.');
				continue;
			}
			const id = crypto.randomUUID();
			attachments = [
				...attachments,
				{
					id,
					filename: file.name,
					size: file.size,
					mime_type: file.type || 'application/octet-stream',
					r2_key: '',
					uploading: true,
				},
			];
			try {
				const form = new FormData();
				form.set('file', file);
				const res = await fetch('/api/attachments/upload', { method: 'POST', body: form });
				if (!res.ok) {
					const b = (await res.json().catch(() => ({}))) as { message?: string };
					throw new Error(b.message || 'Upload failed');
				}
				const j = (await res.json()) as { r2_key: string };
				attachments = attachments.map((a) =>
					a.id === id ? { ...a, r2_key: j.r2_key, uploading: false } : a,
				);
			} catch (e) {
				attachments = attachments.filter((a) => a.id !== id);
				toast((e as Error).message);
			}
		}
	}
	function onFilePicked(e: Event): void {
		const input = e.target as HTMLInputElement;
		if (input.files?.length) void addFiles(input.files);
		input.value = '';
	}
	function onDrop(e: DragEvent): void {
		e.preventDefault();
		if (e.dataTransfer?.files?.length) void addFiles(e.dataTransfer.files);
	}
	function removeAttachment(id: string): void {
		attachments = attachments.filter((a) => a.id !== id);
	}
	function fmtSize(n: number): string {
		return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
	}

	async function send(): Promise<void> {
		const toList = toAddresses(to);
		const ccList = showCc ? toAddresses(cc) : [];
		const bccList = showBcc ? toAddresses(bcc) : [];
		if (!toList.length) { toast('Add at least one recipient.'); return; }
		if (!fromIdentity) { toast('No identity to send from. Connect an account first.'); return; }
		if (attachments.some((a) => a.uploading)) { toast('Wait for attachments to finish uploading.'); return; }
		sending = true;
		try {
			// Merge the identity's signature into the doc at send (WYSIWYG-neutral).
			const doc = mergeSignatureDoc(editor.doc, signatureDoc);
			const res = await fetch('/api/send', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					identity_id: fromIdentity.id,
					to: toList,
					cc: ccList,
					bcc: bccList,
					subject,
					doc,
					in_reply_to: init.in_reply_to,
					references: init.references,
					thread_id: init.thread_id,
					attachments: attachments
						.filter((a) => a.r2_key)
						.map((a) => ({ r2_key: a.r2_key, filename: a.filename, mime_type: a.mime_type, size: a.size })),
				}),
			});
			if (!res.ok) {
				const err = (await res.json().catch(() => ({}))) as { message?: string };
				throw new Error(err.message || `Send failed (${res.status})`);
			}
			// The sent message supersedes the draft — stop autosaving and drop it,
			// waiting for any in-flight save first so it can't re-create an orphan (§6).
			sent = true;
			void saver.discardAfterSend();
			toast('Sending… (undo from the outbox within your undo window)');
			onClose();
		} catch (e) {
			toast((e as Error).message);
		} finally {
			sending = false;
		}
	}

	// Ctrl/Cmd+Enter sends. The rich-text editor binds Mod-Enter to "insert a line"
	// on its own contenteditable, so a bubble-phase handler would run only AFTER
	// the newline is already in. Catch it in the CAPTURE phase — before the editor
	// (a descendant) ever sees the key — and stop propagation so the message sends
	// without a stray blank line. Handled here, not in onKeydown, for that reason.
	function onKeydownCapture(e: KeyboardEvent): void {
		if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
			e.preventDefault();
			e.stopPropagation();
			void send();
		}
	}

	function onKeydown(e: KeyboardEvent): void {
		const mod = e.ctrlKey || e.metaKey;
		if (mod && e.shiftKey && e.key.toLowerCase() === 'a') { e.preventDefault(); fileInput?.click(); }
		else if (mod && e.shiftKey && e.key.toLowerCase() === 'c') { e.preventDefault(); showCc = true; }
		else if (mod && e.shiftKey && e.key.toLowerCase() === 'b') { e.preventDefault(); showBcc = true; }
		else if (mod && e.key.toLowerCase() === 'j') { e.preventDefault(); cycleIdentity(); }
		// Escape is deliberately NOT handled here — the Modal owns it, so pressing
		// Escape closes only the compose dialog, never the mail behind it.
		// Ctrl/Cmd+Enter (send) lives in onKeydownCapture so the editor can't
		// insert a newline before we act.
	}
</script>

<!-- One recipient row (To / Cc / Bcc). `isTo` renders the always-present To row
     with its Cc/Bcc convenience toggles; Cc and Bcc reuse this inside <Expand>. -->
<!-- A suggestion row inside <Input>'s autocomplete panel: avatar + name + the
     email (which is also the chip value once picked). `opt.label` is the email,
     `opt.description` the display name. -->
{#snippet contactOption(opt: InputOption)}
	<span class="ac-opt">
		<Avatar name={opt.description || opt.label} src={contactAvatarUrl(opt.label)} size="0" />
		<span class="ac-text">
			{#if opt.description}<span class="ac-name">{opt.description}</span>{/if}
			<span class="ac-email">{opt.label}</span>
		</span>
	</span>
{/snippet}

<!-- `.compose-host` scopes the no-animation CSS override to this modal only, so
     the dialog and its backdrop appear instantly (snappy) instead of animating. -->
<div class="compose-host">
	<Modal bind:open onclose={onClose} class="compose-modal" title="New message" width="640px">
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="compose"
			bind:this={overlayEl}
			onkeydowncapture={onKeydownCapture}
			onkeydown={onKeydown}
			ondragover={(e) => e.preventDefault()}
			ondrop={onDrop}>
			<div class="fields">
				<div class="row from">
					<span class="rowlabel">From</span>
					<Button size="0" outline onclick={cycleIdentity} tooltip="Ctrl+J to cycle">
						{fromIdentity?.email ?? 'No identity'}
					</Button>
				</div>

				<!-- To is always visible; Cc/Bcc slide open (delightstack <Expand>) when
				     toggled instead of snapping in. Each is a delightstack <Input> in
				     chips + autocomplete mode: it owns chip add/remove, the suggestion
				     panel, and keyboard nav; `contactOptions` feeds it and `contactOption`
				     renders each row with an avatar. -->
				<div class="row">
					<label for="to">To</label>
					<div class="field">
						<Input
							id="to"
							multiple
							bind:value={to}
							onfilter={contactOptions}
							option={contactOption}
							placeholder="recipient@example.com" />
					</div>
					<!-- Convenience toggles (also Ctrl+Shift+C / Ctrl+Shift+B): kept out of
					     the Tab sequence so Tab flows To → Subject → body directly. -->
					<span class="toggles">
						{#if !showCc}<Button size="0" transparent tabindex={-1} onclick={() => (showCc = true)}>Cc</Button>{/if}
						{#if !showBcc}<Button size="0" transparent tabindex={-1} onclick={() => (showBcc = true)}>Bcc</Button>{/if}
					</span>
				</div>
				<Expand show={showCc}>
					<div class="row">
						<label for="cc">Cc</label>
						<div class="field">
							<Input id="cc" multiple bind:value={cc} onfilter={contactOptions} option={contactOption} />
						</div>
					</div>
				</Expand>
				<Expand show={showBcc}>
					<div class="row">
						<label for="bcc">Bcc</label>
						<div class="field">
							<Input id="bcc" multiple bind:value={bcc} onfilter={contactOptions} option={contactOption} />
						</div>
					</div>
				</Expand>

				<div class="row">
					<label for="subject">Subject</label>
					<input id="subject" class="subject" bind:value={subject} placeholder="Subject" />
				</div>
			</div>

			<div class="body">
				<EditorView {editor} />
				{#if signaturePreview}
					<div class="signature" aria-label="Signature">
						<div class="sig-marker">--</div>
						<pre>{signaturePreview}</pre>
					</div>
				{/if}
			</div>

			{#if attachments.length}
				<div class="attachments">
					{#each attachments as a (a.id)}
						<span class="att-chip" class:uploading={a.uploading}>
							<Icon name="paperclip" size={13} /> {a.filename} <span class="att-size">{fmtSize(a.size)}</span>
							{#if a.uploading}<span class="att-status">uploading…</span>{/if}
							<button onclick={() => removeAttachment(a.id)} aria-label="Remove attachment"><Icon name="x" size={13} /></button>
						</span>
					{/each}
				</div>
			{/if}
		</div>

		{#snippet footer()}
			<div class="footer-row">
				<span class="hint">
					<span class="hk"><kbd>Ctrl</kbd><kbd>↵</kbd> Send</span>
					<span class="hk"><kbd>Ctrl</kbd><kbd>J</kbd> Identity</span>
					<span class="hk"><kbd>Esc</kbd> Close</span>
				</span>
				<div class="footer-actions">
					<input bind:this={fileInput} type="file" multiple hidden onchange={onFilePicked} />
					<Button
						icon
						transparent
						onclick={() => fileInput?.click()}
						tooltip="Attach (Ctrl+Shift+A)"
						aria-label="Attach files">
						<Icon name="paperclip" size={18} />
					</Button>
					<Button accent disabled={!canSend} loading={sending} onclick={send}>
						{sending ? 'Sending…' : 'Send'}
					</Button>
				</div>
			</div>
		{/snippet}
	</Modal>
</div>

<style>
	/* Instant, snappy open/close: kill the Modal's built-in Svelte transitions
	   (they apply via inline `animation`, which a stylesheet `!important` beats)
	   on both the dialog panel and its backdrop. */
	:global(.compose-host .modal),
	:global(.compose-host .modal-bg) {
		animation: none !important;
	}

	/* The editor's block menus — the slash "/" menu, the "+" add-block menu, the
	   selection toolbar and the per-block settings popover — portal themselves to
	   <body> (to escape the editor's overflow) with a hardcoded low z-index (40–60).
	   Out there they share the root stacking context with this modal's panel, which
	   sits at --layer-modal + 1 (401), so the menus open *behind* the dialog and are
	   invisible. Lift them onto delightstack's --layer-popover (500) — the layer
	   meant to sit above modals. Scoped to direct <body> children so it only touches
	   the portalled editor menus, never same-named elements nested in the app (e.g.
	   the settings page's own `.settings`); !important beats the editor's own
	   Svelte-scoped `.slash-menu` rule, which has higher specificity. */
	:global(body > .slash-menu),
	:global(body > .menu-wrap),
	:global(body > .floating),
	:global(body > .settings),
	:global(body > .mobile-bar) {
		z-index: var(--layer-popover, 500) !important;
	}
	.compose {
		display: flex;
		flex-direction: column;
	}
	.fields { padding: 2px 0 var(--space-2); }
	.row {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		border-bottom: 1px solid var(--dm-hairline);
		padding: var(--space-2) 0;
	}
	.row label, .row .rowlabel { width: 48px; color: var(--color-text-disabled); font-size: var(--font-size-00); flex-shrink: 0; }
	/* The recipient <Input> owns its own chips, suggestion panel, and field chrome
	   (drawn from the design tokens); it just needs to fill the row. Its border
	   replaces the row hairline, so recipient rows drop theirs to avoid doubling. */
	.field { flex: 1; min-width: 0; }
	.row:has(.field) { border-bottom: none; }
	.subject {
		width: 100%; border: none; background: transparent; color: inherit; outline: none;
		padding: 4px 0; font: inherit; font-size: var(--font-size-1);
	}
	/* A suggestion row rendered into <Input>'s panel via the `option` snippet. */
	.ac-opt { display: flex; align-items: center; gap: 8px; min-width: 0; }
	.ac-text { display: flex; flex-direction: column; line-height: 1.25; min-width: 0; }
	.ac-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.ac-email { color: var(--color-text-disabled); font-size: var(--font-size-00); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	/* Favicon treatment (neutral backdrop + contain) for avatars in the panel. */
	.ac-opt :global(.avatar img) {
		background: var(--color-bg-3); object-fit: contain; padding: 2px; box-sizing: border-box;
	}
	.toggles { display: flex; gap: 4px; }
	.body { flex: 1; padding: var(--space-4) 0 var(--space-2); min-height: 220px; }
	.signature { margin-top: var(--space-4); color: var(--color-text-disabled); }
	.sig-marker { font-family: var(--font-mono); }
	.signature pre { margin: 0; white-space: pre-wrap; font: inherit; font-size: var(--font-size-00); }
	.attachments {
		display: flex; flex-wrap: wrap; gap: 6px; padding: var(--space-2) 0 0;
		border-top: 1px solid var(--color-border); margin-top: var(--space-2);
	}
	.att-chip {
		display: inline-flex; align-items: center; gap: 6px; background: var(--color-bg-2);
		border-radius: var(--radius-md); padding: 3px 8px; font-size: var(--font-size-00);
	}
	.att-chip.uploading { opacity: 0.6; }
	.att-size, .att-status { color: var(--color-text-disabled); }
	.att-chip button { display: inline-flex; align-items: center; background: none; border: none; padding: 0; color: var(--color-text-disabled); cursor: pointer; }
	.att-chip button:hover { color: var(--color-error); }

	/* Footer: keyboard hints on the left, Attach + Send actions pinned right. */
	.footer-row {
		display: flex; align-items: center; gap: var(--space-3); width: 100%;
	}
	.footer-actions { margin-left: auto; display: flex; align-items: center; gap: var(--space-2); }
	.hint { display: flex; gap: var(--space-3); font-size: var(--font-size-00); color: var(--color-text-disabled); }

	/* The email body starts blank — hide the editor's "Heading / Bullet list …"
	   quick-start chips that otherwise appear under the empty-doc placeholder. */
	.body :global(.quick-chips) { display: none; }
	.hk { display: inline-flex; align-items: center; gap: 3px; white-space: nowrap; }
	.hint kbd {
		font-family: var(--font-mono); font-size: 0.9em;
		background: var(--color-bg-2); border: 1px solid var(--color-border);
		border-radius: var(--radius-sm); padding: 0 4px;
	}
	@media (max-width: 767px) {
		.hint { display: none; }
		/* Compose fills the screen on a phone. The delightstack Modal already
		   turns into a full-width bottom sheet (title bar stuck at the bottom,
		   in thumb reach) — we only stretch it to full height so a long email
		   never composes through a letterbox. The .body carries inline width/
		   max-height from the width prop, hence the !important. */
		:global(.compose-host .modal .body) {
			width: 100vw !important;
			max-width: 100vw !important;
			min-height: 100dvh;
			max-height: 100dvh !important;
			border-radius: 0 !important;
			padding-top: env(safe-area-inset-top);
			padding-bottom: env(safe-area-inset-bottom);
		}
		/* iOS zooms any focused input under 16px — recipients, subject, editor. */
		:global(.compose-host input),
		.subject,
		.body {
			font-size: 16px;
		}
	}
</style>
