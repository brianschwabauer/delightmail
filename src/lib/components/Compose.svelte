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
	import { Button, toast } from '@delightstack/components';
	import type { MailDatabaseClient } from '$lib/clients';
	import type { Address, Identity } from '$lib/schema';
	import { mergeSignatureDoc, docToText } from '$lib/mail/compose';

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
	}

	interface Props {
		db: MailDatabaseClient;
		init: ComposeInit;
		onClose: () => void;
	}
	const { db, init, onClose }: Props = $props();

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

	onMount(() => {
		if (!identityId && identities.docs.length) {
			identityId = String((identities.docs[0] as Identity).id);
		}
		return () => editor.destroy();
	});

	const fromIdentity = $derived(
		(identities.docs as Identity[]).find((i) => String(i.id) === identityId) ??
			(identities.docs[0] as Identity | undefined),
	);

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
		else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
	}
</script>

<div
	class="overlay"
	role="dialog"
	aria-label="Compose message"
	onkeydown={onKeydown}
	ondragover={(e) => e.preventDefault()}
	ondrop={onDrop}>
	<header>
		<span class="title">New message</span>
		<button class="close" onclick={onClose} aria-label="Close">✕</button>
	</header>

	<div class="fields">
		<div class="row from">
			<label for="from">From</label>
			<button id="from" class="identity" onclick={cycleIdentity} title="Ctrl+J to cycle">
				{fromIdentity?.email ?? 'No identity'}
			</button>
		</div>

		{#each [{ f: 'to', label: 'To', chips: to, input: toInput, show: true }, { f: 'cc', label: 'Cc', chips: cc, input: ccInput, show: showCc }, { f: 'bcc', label: 'Bcc', chips: bcc, input: bccInput, show: showBcc }] as row (row.f)}
			{#if row.show}
				<div class="row">
					<label for={row.f}>{row.label}</label>
					<div class="chips">
						{#each row.chips as a, i (i)}
							<span class="chip">{a.name || a.email}<button onclick={() => removeChip(row.f as 'to' | 'cc' | 'bcc', i)}>✕</button></span>
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
									if (e.key === 'Enter' || e.key === ',' || e.key === 'Tab') {
										e.preventDefault();
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
						<span class="toggles">
							{#if !showCc}<button class="cc-toggle" onclick={() => (showCc = true)}>Cc</button>{/if}
							{#if !showBcc}<button class="cc-toggle" onclick={() => (showBcc = true)}>Bcc</button>{/if}
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
					📎 {a.filename} <span class="att-size">{fmtSize(a.size)}</span>
					{#if a.uploading}<span class="att-status">uploading…</span>{/if}
					<button onclick={() => removeAttachment(a.id)} aria-label="Remove attachment">✕</button>
				</span>
			{/each}
		</div>
	{/if}

	<footer>
		<Button disabled={sending} onclick={send}>{sending ? 'Sending…' : 'Send'}</Button>
		<button class="attach-btn" onclick={() => fileInput?.click()} title="Ctrl+Shift+A">Attach</button>
		<input bind:this={fileInput} type="file" multiple hidden onchange={onFilePicked} />
		<span class="hint">Ctrl+Enter send · Ctrl+J identity · Ctrl+Shift+A attach · Esc close</span>
	</footer>
</div>

<style>
	.overlay {
		position: fixed;
		right: var(--size-4);
		bottom: 0;
		width: min(640px, 96vw);
		max-height: 82vh;
		display: flex;
		flex-direction: column;
		background: var(--color-bg-1);
		border: 1px solid var(--color-outline);
		border-bottom: none;
		border-radius: var(--radius-3) var(--radius-3) 0 0;
		box-shadow: var(--shadow-4, 0 20px 60px rgba(0, 0, 0, 0.4));
		z-index: 110;
	}
	header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: var(--size-2) var(--size-3);
		background: var(--color-bg-2);
		border-bottom: 1px solid var(--color-outline);
		border-radius: var(--radius-3) var(--radius-3) 0 0;
	}
	.title { font-weight: 600; font-size: var(--font-size-0); }
	.close, .cc-toggle {
		background: none; border: none; color: var(--color-text-disabled); cursor: pointer; font: inherit;
	}
	.fields { padding: var(--size-2) var(--size-3); }
	.row {
		display: flex;
		align-items: center;
		gap: var(--size-2);
		border-bottom: 1px solid var(--color-outline);
		padding: 4px 0;
	}
	.row label { width: 48px; color: var(--color-text-disabled); font-size: var(--font-size-00, 0.72rem); flex-shrink: 0; }
	.chips { display: flex; flex-wrap: wrap; gap: 4px; flex: 1; align-items: center; }
	.chip {
		display: inline-flex; align-items: center; gap: 4px;
		background: var(--color-bg-2); border-radius: 99px; padding: 1px 4px 1px 8px; font-size: var(--font-size-00, 0.75rem);
	}
	.chip button { background: none; border: none; color: var(--color-text-disabled); cursor: pointer; }
	.ac-wrap { position: relative; flex: 1; min-width: 120px; }
	.chips input, .subject {
		width: 100%; border: none; background: transparent; color: inherit; outline: none; padding: 4px 0; font: inherit;
	}
	.ac-menu {
		position: absolute; top: 100%; left: 0; z-index: 5; margin: 2px 0 0; padding: 4px; list-style: none;
		min-width: 220px; background: var(--color-bg-1); border: 1px solid var(--color-outline);
		border-radius: var(--radius-2); box-shadow: var(--shadow-3, 0 8px 24px rgba(0,0,0,0.3));
	}
	.ac-menu button {
		display: flex; gap: 6px; width: 100%; text-align: left; background: none; border: none; color: inherit;
		cursor: pointer; padding: 4px 6px; border-radius: var(--radius-1); font-size: var(--font-size-00, 0.75rem);
	}
	.ac-menu button:hover { background: var(--color-bg-3, var(--color-bg-2)); }
	.ac-email { color: var(--color-text-disabled); }
	.toggles { display: flex; gap: 4px; }
	.identity {
		background: var(--color-bg-2); border: 1px solid var(--color-outline); border-radius: var(--radius-2);
		padding: 2px 8px; color: inherit; cursor: pointer; font: inherit; font-size: var(--font-size-00, 0.75rem);
	}
	.body { flex: 1; overflow-y: auto; padding: var(--size-3); min-height: 180px; }
	.signature { margin-top: var(--size-3); color: var(--color-text-disabled); }
	.sig-marker { font-family: var(--font-mono, monospace); }
	.signature pre { margin: 0; white-space: pre-wrap; font: inherit; font-size: var(--font-size-00, 0.8rem); }
	.attachments {
		display: flex; flex-wrap: wrap; gap: 6px; padding: var(--size-2) var(--size-3);
		border-top: 1px solid var(--color-outline);
	}
	.att-chip {
		display: inline-flex; align-items: center; gap: 6px; background: var(--color-bg-2);
		border-radius: var(--radius-2); padding: 2px 6px; font-size: var(--font-size-00, 0.72rem);
	}
	.att-chip.uploading { opacity: 0.6; }
	.att-size, .att-status { color: var(--color-text-disabled); }
	.att-chip button { background: none; border: none; color: var(--color-text-disabled); cursor: pointer; }
	footer {
		display: flex; align-items: center; gap: var(--size-3);
		padding: var(--size-2) var(--size-3); border-top: 1px solid var(--color-outline);
	}
	.attach-btn {
		background: var(--color-bg-2); border: 1px solid var(--color-outline); border-radius: var(--radius-2);
		padding: 4px 10px; color: inherit; cursor: pointer; font: inherit; font-size: var(--font-size-00, 0.75rem);
	}
	.hint { font-size: var(--font-size-00, 0.7rem); color: var(--color-text-disabled); font-family: var(--font-mono, monospace); }
</style>
