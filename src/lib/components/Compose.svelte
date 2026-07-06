<script lang="ts">
	import { tick, onMount } from 'svelte';
	import { Editor as EditorClass, defaultBlocks } from '@delightstack/editor';
	import { Editor } from '@delightstack/editor/components';
	import { Button, toast } from '@delightstack/components';
	import type { MailDatabaseClient } from '$lib/clients';
	import type { Address, Identity } from '$lib/schema';

	export interface ComposeInit {
		to?: Address[];
		cc?: Address[];
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

	const identities = db.search('identity', { limit: 50 });

	let identityId = $state(init.identity_id ?? '');
	let toInput = $state('');
	let ccInput = $state('');
	let showCc = $state((init.cc?.length ?? 0) > 0);
	let to = $state<Address[]>(init.to ?? []);
	let cc = $state<Address[]>(init.cc ?? []);
	let subject = $state(init.subject ?? '');
	let sending = $state(false);

	const editor = new EditorClass({
		placeholder: 'Write your message…',
		blocks: defaultBlocks(),
		content: (init.bodyDoc as never) ?? undefined,
	});

	onMount(() => {
		// Default to the first identity if none supplied.
		if (!identityId && identities.docs.length) {
			identityId = (identities.docs[0] as Identity).id;
		}
		return () => editor.destroy();
	});

	const fromIdentity = $derived(
		(identities.docs as Identity[]).find((i) => i.id === identityId) ??
			(identities.docs[0] as Identity | undefined),
	);

	function parseAddress(raw: string): Address | null {
		const trimmed = raw.trim().replace(/[,;]+$/, '');
		if (!trimmed) return null;
		const m = trimmed.match(/^(.*)<(.+@.+)>$/);
		if (m) return { name: m[1].trim() || undefined, email: m[2].trim() };
		if (/^[^@\s]+@[^@\s]+$/.test(trimmed)) return { email: trimmed };
		return null;
	}
	function commitChip(field: 'to' | 'cc') {
		const raw = field === 'to' ? toInput : ccInput;
		const addr = parseAddress(raw);
		if (addr) {
			if (field === 'to') { to = [...to, addr]; toInput = ''; }
			else { cc = [...cc, addr]; ccInput = ''; }
		}
	}
	function removeChip(field: 'to' | 'cc', i: number) {
		if (field === 'to') to = to.filter((_, idx) => idx !== i);
		else cc = cc.filter((_, idx) => idx !== i);
	}

	function cycleIdentity() {
		const list = identities.docs as Identity[];
		if (list.length < 2) return;
		const idx = list.findIndex((i) => i.id === identityId);
		identityId = list[(idx + 1) % list.length].id;
	}

	async function send() {
		commitChip('to');
		commitChip('cc');
		if (!to.length) return toast('Add at least one recipient.');
		if (!fromIdentity) return toast('No identity to send from. Connect an account first.');
		sending = true;
		try {
			const res = await fetch('/api/send', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					identity_id: fromIdentity.id,
					to,
					cc: showCc ? cc : [],
					subject,
					doc: editor.doc,
					in_reply_to: init.in_reply_to,
					references: init.references,
					thread_id: init.thread_id,
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

	function onKeydown(e: KeyboardEvent) {
		if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); void send(); }
		else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'j') { e.preventDefault(); cycleIdentity(); }
		else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
	}
</script>

<div class="overlay" role="dialog" aria-label="Compose message" onkeydown={onKeydown}>
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

		<div class="row">
			<label for="to">To</label>
			<div class="chips">
				{#each to as a, i (i)}
					<span class="chip">{a.name || a.email}<button onclick={() => removeChip('to', i)}>✕</button></span>
				{/each}
				<input
					id="to"
					bind:value={toInput}
					placeholder="recipient@example.com"
					onkeydown={(e) => (e.key === 'Enter' || e.key === ',' || e.key === 'Tab') && (e.preventDefault(), commitChip('to'))} />
			</div>
			{#if !showCc}<button class="cc-toggle" onclick={() => (showCc = true)}>Cc</button>{/if}
		</div>

		{#if showCc}
			<div class="row">
				<label for="cc">Cc</label>
				<div class="chips">
					{#each cc as a, i (i)}
						<span class="chip">{a.name || a.email}<button onclick={() => removeChip('cc', i)}>✕</button></span>
					{/each}
					<input
						id="cc"
						bind:value={ccInput}
						onkeydown={(e) => (e.key === 'Enter' || e.key === ',' || e.key === 'Tab') && (e.preventDefault(), commitChip('cc'))} />
				</div>
			</div>
		{/if}

		<div class="row">
			<label for="subject">Subject</label>
			<input id="subject" class="subject" bind:value={subject} placeholder="Subject" />
		</div>
	</div>

	<div class="body">
		<Editor {editor} />
	</div>

	<footer>
		<Button disabled={sending} onclick={send}>{sending ? 'Sending…' : 'Send'}</Button>
		<span class="hint">Ctrl+Enter to send · Ctrl+J identity · Esc close</span>
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
	.chips input, .subject {
		flex: 1; min-width: 120px; border: none; background: transparent; color: inherit; outline: none; padding: 4px 0; font: inherit;
	}
	.identity {
		background: var(--color-bg-2); border: 1px solid var(--color-outline); border-radius: var(--radius-2);
		padding: 2px 8px; color: inherit; cursor: pointer; font: inherit; font-size: var(--font-size-00, 0.75rem);
	}
	.body { flex: 1; overflow-y: auto; padding: var(--size-3); min-height: 180px; }
	footer {
		display: flex; align-items: center; gap: var(--size-3);
		padding: var(--size-2) var(--size-3); border-top: 1px solid var(--color-outline);
	}
	.hint { font-size: var(--font-size-00, 0.7rem); color: var(--color-text-disabled); font-family: var(--font-mono, monospace); }
</style>
