<script lang="ts">
	import { Button, Input, toast } from '@delightstack/components';

	const { data } = $props();
	const { db } = $derived(data);

	const accounts = db.list('account', { limit: 50 });
	let connecting = $state(false);
	let domain = $state('');
	let addingDomain = $state(false);

	// --- IMAP ---
	let imap = $state({ email: '', imap_host: '', imap_port: 993, password: '' });
	let imapBusy = $state(false);
	let imapTestResult = $state('');

	async function testImap() {
		imapBusy = true;
		imapTestResult = '';
		try {
			const res = await fetch('/api/accounts/imap/test', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(imap),
			});
			const body = (await res.json()) as { ok: boolean; error?: string; folders?: string[] };
			imapTestResult = body.ok
				? `Connected — ${body.folders?.length ?? 0} folders found.`
				: body.error || 'Connection failed.';
		} catch (e) {
			imapTestResult = (e as Error).message;
		} finally {
			imapBusy = false;
		}
	}
	async function addImap() {
		if (!imap.email || !imap.imap_host || !imap.password) return toast('Fill in all IMAP fields.');
		imapBusy = true;
		try {
			const res = await fetch('/api/accounts/imap', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(imap),
			});
			const body = (await res.json()) as { account_id?: string; message?: string };
			if (body.account_id) {
				toast(`Added ${imap.email}.`);
				imap = { email: '', imap_host: '', imap_port: 993, password: '' };
			} else toast(body.message || 'Could not add the account.');
		} catch (e) {
			toast((e as Error).message);
		} finally {
			imapBusy = false;
		}
	}

	async function connectDomain() {
		if (!domain.trim()) return;
		addingDomain = true;
		try {
			const res = await fetch('/api/accounts/domain', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ domain: domain.trim() }),
			});
			const body = (await res.json().catch(() => ({}))) as { next_steps?: string; message?: string };
			if (!res.ok) return toast(body.message || 'Could not register the domain.');
			toast(body.next_steps || 'Domain registered.');
			domain = '';
		} catch (e) {
			toast((e as Error).message);
		} finally {
			addingDomain = false;
		}
	}

	async function connectGmail() {
		connecting = true;
		try {
			const res = await fetch('/api/accounts/google/start', { method: 'POST' });
			if (!res.ok) {
				const err = (await res.json().catch(() => ({}))) as { message?: string };
				toast(err.message || 'Gmail connect is not configured on this instance.');
				return;
			}
			const { url } = (await res.json()) as { url: string };
			window.location.href = url;
		} catch (e) {
			toast((e as Error).message || 'Could not start Gmail connect.');
		} finally {
			connecting = false;
		}
	}

	function statusLabel(a: { status: string; status_detail?: string | null }): string {
		if (a.status === 'backfilling') return 'Backfilling…';
		if (a.status === 'live') return 'Live';
		if (a.status === 'error') return a.status_detail || 'Error';
		if (a.status === 'connecting') return 'Connecting…';
		if (a.status === 'paused') return 'Paused';
		return a.status;
	}

	// --- lifecycle (pause / resume / resync / remove) ---
	let busyId = $state<string | null>(null);
	let confirmDeleteId = $state<string | null>(null);

	async function lifecycle(id: string, action: 'pause' | 'resume' | 'resync') {
		busyId = id;
		try {
			const res = await fetch(`/api/accounts/${encodeURIComponent(id)}/${action}`, {
				method: 'POST',
			});
			if (!res.ok) {
				const b = (await res.json().catch(() => ({}))) as { message?: string };
				toast(b.message || `Could not ${action} the account.`);
			} else {
				toast(
					action === 'resync'
						? 'Re-syncing from scratch — watch the status here.'
						: action === 'pause'
							? 'Sync paused.'
							: 'Sync resumed.',
				);
			}
		} catch (e) {
			toast((e as Error).message);
		} finally {
			busyId = null;
		}
	}

	async function removeAccount(id: string) {
		confirmDeleteId = null;
		busyId = id;
		try {
			const res = await fetch(`/api/accounts/${encodeURIComponent(id)}`, { method: 'DELETE' });
			if (!res.ok) {
				const b = (await res.json().catch(() => ({}))) as { message?: string };
				toast(b.message || 'Could not remove the account.');
			} else {
				toast('Account removed. Its synced mail stays in your archive.');
			}
		} catch (e) {
			toast((e as Error).message);
		} finally {
			busyId = null;
		}
	}
</script>

<svelte:head><title>Accounts · Settings</title></svelte:head>

<h2>Mail accounts</h2>
<p class="muted">Connect Gmail, a custom domain, or an IMAP mailbox.</p>

{#if accounts.items.length}
	<ul class="accounts">
		{#each accounts.items as a (a.id)}
			<li>
				<div class="acct-row">
					<span class="dot" style:background={a.color || 'var(--color-primary)'}></span>
					<span class="email">
						<strong>{a.display_name || a.email}</strong>
						<small>{a.kind}</small>
					</span>
					<span class="status" class:err={a.status === 'error'}>{statusLabel(a as never)}</span>
					<span class="acct-actions">
						{#if a.status === 'paused'}
							<Button size="0" transparent disabled={busyId === String(a.id)}
								onclick={() => lifecycle(String(a.id), 'resume')}>Resume</Button>
						{:else}
							<Button size="0" transparent disabled={busyId === String(a.id)}
								onclick={() => lifecycle(String(a.id), 'pause')}>Pause</Button>
						{/if}
						<Button size="0" transparent disabled={busyId === String(a.id)}
							onclick={() => lifecycle(String(a.id), 'resync')}>Resync</Button>
						<Button size="0" transparent disabled={busyId === String(a.id)}
							onclick={() => (confirmDeleteId = String(a.id))}>Remove</Button>
					</span>
				</div>
				{#if confirmDeleteId === String(a.id)}
					<div class="confirm">
						<span>Remove {a.email}? Sync stops and its credentials are destroyed; mail already
							synced stays in your archive.</span>
						<Button size="0" error onclick={() => removeAccount(String(a.id))}>Remove</Button>
						<Button size="0" transparent onclick={() => (confirmDeleteId = null)}>Cancel</Button>
					</div>
				{/if}
			</li>
		{/each}
	</ul>
{:else if !db.synced}
	<!-- The local index answers instantly with zero rows before the initial sync
	     lands — "no accounts" is only a fact once the sync has completed. -->
	<div class="empty"><p class="muted">Loading accounts…</p></div>
{:else}
	<div class="empty"><p class="muted">No accounts connected yet.</p></div>
{/if}

<div class="add">
	<Button disabled={connecting} onclick={connectGmail}>
		{connecting ? 'Redirecting…' : 'Connect a Gmail account'}
	</Button>
</div>

<div class="add domain">
	<h3>Custom domain</h3>
	<p class="hint muted">
		Route a domain's mail here via Cloudflare Email Routing (catch-all → Send to Worker).
	</p>
	<div class="domain-row">
		<Input bind:value={domain} placeholder="example.com" />
		<Button disabled={addingDomain} onclick={connectDomain}>
			{addingDomain ? 'Registering…' : 'Add domain'}
		</Button>
	</div>
</div>

<div class="add domain">
	<h3>IMAP / SMTP</h3>
	<p class="hint muted">
		Any provider (Fastmail, iCloud, self-hosted…). Uses an app password. IMAP polling is gated on
		the R1 socket spike — the connection test tells you if it works on this deployment.
	</p>
	<div class="imap-grid">
		<Input bind:value={imap.email} placeholder="you@example.com" label="Email" />
		<Input bind:value={imap.imap_host} placeholder="imap.example.com" label="IMAP host" />
		<Input type="number" bind:value={imap.imap_port} label="Port" />
		<Input type="password" bind:value={imap.password} placeholder="app password" label="Password" />
	</div>
	<div class="imap-actions">
		<Button transparent disabled={imapBusy} onclick={testImap}>Test connection</Button>
		<Button disabled={imapBusy} onclick={addImap}>Add IMAP account</Button>
	</div>
	{#if imapTestResult}<p class="hint muted">{imapTestResult}</p>{/if}
</div>

<style>
	h2 {
		font-size: var(--font-size-3);
	}
	.muted {
		color: var(--color-text-disabled);
	}
	.accounts {
		list-style: none;
		padding: 0;
		margin: var(--space-4) 0;
	}
	.accounts li {
		padding: var(--space-3) 0;
		border-bottom: 1px solid var(--color-border);
	}
	.acct-row {
		display: flex;
		align-items: center;
		gap: var(--space-3);
	}
	.acct-actions {
		display: flex;
		gap: var(--space-1);
		flex-shrink: 0;
	}
	.confirm {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: var(--space-2);
		margin-top: var(--space-2);
		padding: var(--space-2) var(--space-3);
		border: 1px solid color-mix(in oklab, var(--color-error, #c0392b) 35%, var(--color-border));
		border-radius: var(--radius-md);
		background: color-mix(in oklab, var(--color-error, #c0392b) 7%, var(--color-bg-1));
		font-size: var(--font-size-0);
	}
	.confirm span {
		flex: 1;
		min-width: 240px;
	}
	.dot {
		width: 10px;
		height: 10px;
		border-radius: 50%;
		flex-shrink: 0;
	}
	.email {
		flex: 1;
		display: flex;
		flex-direction: column;
	}
	.email small {
		color: var(--color-text-disabled);
	}
	.status {
		font-size: var(--font-size-00, 0.72rem);
		color: var(--color-text-disabled);
	}
	.status.err {
		color: var(--color-error, #c0392b);
	}
	.empty {
		padding: var(--space-5) 0;
	}
	.add {
		margin-top: var(--space-4);
	}
	.add.domain h3 {
		font-size: var(--font-size-1);
		margin-bottom: var(--space-1);
	}
	.domain-row {
		display: flex;
		gap: var(--space-2);
		align-items: center;
		max-width: 420px;
	}
	.domain-row :global(.input),
	.domain-row :global(label) {
		flex: 1;
	}
	.hint {
		margin-top: var(--space-2);
		font-size: var(--font-size-0);
	}
	.imap-grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: var(--space-2);
		max-width: 480px;
		margin: var(--space-2) 0;
	}
	.imap-actions {
		display: flex;
		gap: var(--space-2);
	}
</style>
