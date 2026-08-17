<script lang="ts">
	import { Button, Input, toast } from '@delightstack/components';
	import { docToText, textToDoc } from '$lib/mail/compose';

	const { data } = $props();
	const { db } = $derived(data);

	const identities = db.list('identity', {
		limit: 100,
		order: [{ field: 'email', direction: 'ASC' }],
	});

	// Per-identity edit state, seeded lazily from the loaded docs. Identities
	// are created server-side (OAuth / domain register / catch-all) and email is
	// immutable — this page owns name, signature, and the default flag.
	let editing = $state<string | null>(null);
	let editName = $state('');
	let editSignature = $state('');
	let saving = $state(false);

	interface IdentityDoc {
		id: string;
		email?: string;
		name?: string;
		is_default?: boolean;
		auto_created?: boolean;
		signature_doc?: string;
	}
	const docs = $derived((identities.items ?? []) as unknown as IdentityDoc[]);

	async function startEdit(i: IdentityDoc) {
		editing = String(i.id);
		editName = i.name ?? '';
		// The sparse doc may not carry signature_doc — load the full row.
		try {
			const full = (await db.get('identity', i.id).load()) as IdentityDoc | undefined;
			editName = full?.name ?? editName;
			editSignature = full?.signature_doc
				? docToText(JSON.parse(full.signature_doc)).trimEnd()
				: '';
		} catch {
			editSignature = '';
		}
	}

	async function saveEdit(id: string) {
		saving = true;
		try {
			await db.update('identity', id, {
				name: editName.trim() || undefined,
				signature_doc: editSignature.trim() ? JSON.stringify(textToDoc(editSignature)) : '',
			} as never);
			toast('Identity saved.');
			editing = null;
		} catch (e) {
			toast((e as Error).message);
		} finally {
			saving = false;
		}
	}

	async function makeDefault(id: string) {
		try {
			// Single-writer UI: unset the others, set this one.
			for (const other of docs) {
				if (String(other.id) !== id && other.is_default) {
					await db.update('identity', other.id, { is_default: false } as never);
				}
			}
			await db.update('identity', id, { is_default: true } as never);
			toast('Default identity updated.');
		} catch (e) {
			toast((e as Error).message);
		}
	}
</script>

<svelte:head><title>Identities · Settings</title></svelte:head>

<h2>Identities</h2>
<p class="muted">
	Addresses you can send as. Compose picks the default; <kbd>Ctrl+J</kbd> cycles the rest.
	New addresses appear here automatically when an account connects or a catch-all
	alias first receives mail.
</p>

{#if docs.length}
	<ul class="ids">
		{#each docs as i (i.id)}
			<li>
				<div class="row">
					<span class="who">
						<strong>{i.email}</strong>
						{#if i.name}<small>{i.name}</small>{/if}
					</span>
					{#if i.is_default}
						<span class="badge">default</span>
					{:else}
						<Button size="0" transparent onclick={() => makeDefault(String(i.id))}>Make default</Button>
					{/if}
					<Button
						size="0"
						outline
						onclick={() => (editing === String(i.id) ? (editing = null) : void startEdit(i))}>
						{editing === String(i.id) ? 'Close' : 'Edit'}
					</Button>
				</div>
				{#if editing === String(i.id)}
					<div class="edit">
						<Input bind:value={editName} label="Display name" placeholder="Your name" />
						<label class="sig-label">
							<span>Signature (appended below a “--” marker when you send)</span>
							<textarea bind:value={editSignature} rows="4" placeholder={'Best,\nYour name'}
							></textarea>
						</label>
						<div class="edit-actions">
							<Button size="0" accent disabled={saving} onclick={() => saveEdit(String(i.id))}>
								{saving ? 'Saving…' : 'Save'}
							</Button>
							<Button size="0" transparent onclick={() => (editing = null)}>Cancel</Button>
						</div>
					</div>
				{/if}
			</li>
		{/each}
	</ul>
{:else}
	<div class="empty"><p class="muted">No identities yet — connect an account first.</p></div>
{/if}

<style>
	h2 {
		font-size: var(--font-size-3);
	}
	.muted {
		color: var(--color-text-disabled);
	}
	.ids {
		list-style: none;
		padding: 0;
		margin: var(--space-4) 0;
	}
	.ids li {
		padding: var(--space-3) 0;
		border-bottom: 1px solid var(--color-border);
	}
	.row {
		display: flex;
		align-items: center;
		gap: var(--space-3);
	}
	.who {
		flex: 1;
		display: flex;
		flex-direction: column;
		min-width: 0;
	}
	.who small {
		color: var(--color-text-disabled);
	}
	.badge {
		font-size: var(--font-size-00, 0.72rem);
		padding: 2px 8px;
		border-radius: 999px;
		background: color-mix(in oklab, var(--color-primary) 14%, var(--color-bg-2));
		color: var(--color-primary);
	}
	.edit {
		display: grid;
		gap: var(--space-2);
		margin-top: var(--space-3);
		max-width: 480px;
	}
	.sig-label {
		display: grid;
		gap: 6px;
		font-size: var(--font-size-0);
		color: var(--color-text-disabled);
	}
	.sig-label textarea {
		background: var(--color-bg-2);
		color: var(--color-text, inherit);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md, 8px);
		padding: var(--space-2);
		font: inherit;
		resize: vertical;
	}
	.edit-actions {
		display: flex;
		gap: var(--space-2);
	}
	.empty {
		padding: var(--space-5) 0;
	}
	kbd {
		font-size: 0.85em;
		padding: 1px 5px;
		border: 1px solid var(--color-border);
		border-radius: 4px;
		background: var(--color-bg-2);
	}
</style>
