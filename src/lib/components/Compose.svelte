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
	import { Button, Modal, toast } from '@delightstack/components';
	import Icon from './Icon.svelte';
	import type { MailDatabaseClient } from '$lib/clients';
	import type { Address, Identity } from '$lib/schema';
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
	let toInput = $state('');
	let ccInput = $state('');
	let bccInput = $state('');
	let showCc = $state((init.cc?.length ?? 0) > 0);
	let showBcc = $state((init.bcc?.length ?? 0) > 0);
	let to = $state<Address[]>(init.to ?? []);
	let cc = $state<Address[]>(init.cc ?? []);
	let bcc = $state<Address[]>(init.bcc ?? []);
	let subject = $state(init.subject ?? '');
	let sending = $state(false);
	let attachments = $state<Attachment[]>([]);
	let fileInput = $state<HTMLInputElement>();
	let overlayEl = $state<HTMLElement>();

	// --- contact autocomplete (local Orama index, §10.3) ---
	let acField = $state<'to' | 'cc' | 'bcc' | null>(null);
	const acQuery = $derived(
		acField === 'to' ? toInput : acField === 'cc' ? ccInput : acField === 'bcc' ? bccInput : '',
	);
	const contactSearch = db.search('contact', () => ({ term: acQuery.trim(), limit: 6 }));
	const suggestions = $derived.by(() => {
		if (acQuery.trim().length < 1) return [];
		const chosen = new Set([...to, ...cc, ...bcc].map((a) => (a.email ?? '').toLowerCase()));
		return (contactSearch.docs as Array<{ email?: string; name?: string; send_count?: number }>)
			.filter((c) => c.email && !chosen.has(c.email.toLowerCase()))
			.sort((a, b) => (b.send_count ?? 0) - (a.send_count ?? 0))
			.slice(0, 6);
	});

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
	// least one recipient (a committed chip OR a still-typed valid address), a
	// sending identity, and no attachment mid-upload. (`parseAddress` is a hoisted
	// function declaration, so referencing it here before its definition is fine.)
	const canSend = $derived(
		!sending &&
			!!fromIdentity &&
			(to.length > 0 || parseAddress(toInput) !== null) &&
			!attachments.some((a) => a.uploading),
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
						to,
						cc: showCc ? cc : [],
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
			const first = overlayEl?.querySelector<HTMLInputElement>('.chips input');
			first?.focus();
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
	function fieldValue(field: 'to' | 'cc' | 'bcc'): string {
		return field === 'to' ? toInput : field === 'cc' ? ccInput : bccInput;
	}
	function setField(field: 'to' | 'cc' | 'bcc', v: string): void {
		if (field === 'to') toInput = v;
		else if (field === 'cc') ccInput = v;
		else bccInput = v;
	}
	function addAddress(field: 'to' | 'cc' | 'bcc', addr: Address): void {
		if (field === 'to') to = [...to, addr];
		else if (field === 'cc') cc = [...cc, addr];
		else bcc = [...bcc, addr];
	}
	function commitChip(field: 'to' | 'cc' | 'bcc'): void {
		const addr = parseAddress(fieldValue(field));
		if (addr) {
			addAddress(field, addr);
			setField(field, '');
		}
	}
	function pickSuggestion(field: 'to' | 'cc' | 'bcc', c: { email?: string; name?: string }): void {
		if (!c.email) return;
		addAddress(field, { name: c.name || undefined, email: c.email });
		setField(field, '');
	}
	function removeChip(field: 'to' | 'cc' | 'bcc', i: number): void {
		if (field === 'to') to = to.filter((_, idx) => idx !== i);
		else if (field === 'cc') cc = cc.filter((_, idx) => idx !== i);
		else bcc = bcc.filter((_, idx) => idx !== i);
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
		commitChip('to');
		commitChip('cc');
		commitChip('bcc');
		if (!to.length) { toast('Add at least one recipient.'); return; }
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
					to,
					cc: showCc ? cc : [],
					bcc: showBcc ? bcc : [],
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

	function onKeydown(e: KeyboardEvent): void {
		const mod = e.ctrlKey || e.metaKey;
		if (mod && e.key === 'Enter') { e.preventDefault(); void send(); }
		else if (mod && e.shiftKey && e.key.toLowerCase() === 'a') { e.preventDefault(); fileInput?.click(); }
		else if (mod && e.shiftKey && e.key.toLowerCase() === 'c') { e.preventDefault(); showCc = true; }
		else if (mod && e.shiftKey && e.key.toLowerCase() === 'b') { e.preventDefault(); showBcc = true; }
		else if (mod && e.key.toLowerCase() === 'j') { e.preventDefault(); cycleIdentity(); }
		// Escape is deliberately NOT handled here — the Modal owns it, so pressing
		// Escape closes only the compose dialog, never the mail behind it.
	}
</script>

<!-- `.compose-host` scopes the no-animation CSS override to this modal only, so
     the dialog and its backdrop appear instantly (snappy) instead of animating. -->
<div class="compose-host">
	<Modal bind:open onclose={onClose} class="compose-modal" title="New message" width="640px">
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="compose"
			bind:this={overlayEl}
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

				{#each [{ f: 'to', label: 'To', chips: to, input: toInput, show: true }, { f: 'cc', label: 'Cc', chips: cc, input: ccInput, show: showCc }, { f: 'bcc', label: 'Bcc', chips: bcc, input: bccInput, show: showBcc }] as row (row.f)}
					{#if row.show}
						<div class="row">
							<label for={row.f}>{row.label}</label>
							<div class="chips">
								{#each row.chips as a, i (i)}
									<span class="chip">{a.name || a.email}<button aria-label="Remove" onclick={() => removeChip(row.f as 'to' | 'cc' | 'bcc', i)}><Icon name="x" size={13} /></button></span>
								{/each}
								<div class="ac-wrap">
									<input
										id={row.f}
										value={fieldValue(row.f as 'to' | 'cc' | 'bcc')}
										placeholder={row.f === 'to' ? 'recipient@example.com' : ''}
										oninput={(e) => setField(row.f as 'to' | 'cc' | 'bcc', (e.target as HTMLInputElement).value)}
										onfocus={() => (acField = row.f as 'to' | 'cc' | 'bcc')}
										onblur={() => setTimeout(() => { if (acField === row.f) acField = null; }, 150)}
										onkeydown={(e) => {
											// Enter / comma commit the typed address and keep the caret in the
											// field. Tab ALSO commits any typed address but must NOT be
											// preventDefault-ed — the browser's default Tab has to move focus
											// to the next field so the whole form is keyboard-navigable.
											if (e.key === 'Enter' || e.key === ',') {
												e.preventDefault();
												commitChip(row.f as 'to' | 'cc' | 'bcc');
											} else if (e.key === 'Tab' && fieldValue(row.f as 'to' | 'cc' | 'bcc').trim()) {
												commitChip(row.f as 'to' | 'cc' | 'bcc');
											}
										}} />
									{#if acField === row.f && suggestions.length}
										<ul class="ac-menu">
											{#each suggestions as c (c.email)}
												<li>
													<button onmousedown={(e) => { e.preventDefault(); pickSuggestion(row.f as 'to' | 'cc' | 'bcc', c); }}>
														{#if c.name}<strong>{c.name}</strong>{/if}<span class="ac-email">{c.email}</span>
													</button>
												</li>
											{/each}
										</ul>
									{/if}
								</div>
							</div>
							{#if row.f === 'to'}
								<!-- Convenience toggles (also Ctrl+Shift+C / Ctrl+Shift+B): kept out of
								     the Tab sequence so Tab flows To → Subject → body directly. -->
								<span class="toggles">
									{#if !showCc}<Button size="0" transparent tabindex={-1} onclick={() => (showCc = true)}>Cc</Button>{/if}
									{#if !showBcc}<Button size="0" transparent tabindex={-1} onclick={() => (showBcc = true)}>Bcc</Button>{/if}
								</span>
							{/if}
						</div>
					{/if}
				{/each}

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
	.chips { display: flex; flex-wrap: wrap; gap: 5px; flex: 1; align-items: center; }
	.chip {
		display: inline-flex; align-items: center; gap: 4px;
		background: var(--dm-accent-soft); color: var(--color-text);
		border-radius: var(--radius-cap, 99px); padding: 2px 4px 2px 10px; font-size: var(--font-size-00);
	}
	.chip button { display: inline-flex; align-items: center; background: none; border: none; padding: 0; color: var(--color-text-disabled); cursor: pointer; line-height: 1; }
	.chip button:hover { color: var(--color-error); }
	.ac-wrap { position: relative; flex: 1; min-width: 140px; }
	.chips input, .subject {
		width: 100%; border: none; background: transparent; color: inherit; outline: none; padding: 4px 0; font: inherit;
	}
	.subject { font-size: var(--font-size-1); }
	.ac-menu {
		position: absolute; top: 100%; left: 0; z-index: 5; margin: 4px 0 0; padding: 4px; list-style: none;
		min-width: 240px; background: var(--color-bg-1); border: 1px solid var(--color-border);
		border-radius: var(--radius-md); box-shadow: var(--shadow-lg, 0 8px 24px rgba(0,0,0,0.3));
	}
	.ac-menu button {
		display: flex; gap: 6px; width: 100%; text-align: left; background: none; border: none; color: inherit;
		cursor: pointer; padding: 6px 8px; border-radius: var(--radius-sm); font-size: var(--font-size-0);
	}
	.ac-menu button:hover { background: var(--color-bg-3); }
	.ac-email { color: var(--color-text-disabled); }
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
	}
</style>
