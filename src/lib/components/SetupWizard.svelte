<script lang="ts">
	/**
	 * First-run onboarding (§4.1). Shown in place of the mail pane while the org has
	 * no accounts — an empty inbox with no explanation is indistinguishable from a
	 * broken one, and every path out of it lives on a settings page the user has no
	 * reason to visit yet.
	 *
	 * The three routes in are the three account kinds the server understands:
	 * `gmail` (OAuth), `cf_domain` (Cloudflare Email Routing → the server worker's
	 * email() handler), and `imap`.
	 */
	import { Button, Input, toast } from '@delightstack/components';
	import Icon from '$lib/components/Icon.svelte';

	const { onSkip }: { onSkip?: () => void } = $props();

	let step = $state<'choose' | 'domain' | 'domain_done'>('choose');
	let connecting = $state(false);
	let domain = $state('');
	let registering = $state(false);
	let registered = $state('');

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

	async function registerDomain() {
		const d = domain.trim().toLowerCase().replace(/^@/, '');
		if (!d) return;
		registering = true;
		try {
			const res = await fetch('/api/accounts/domain', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ domain: d }),
			});
			const body = (await res.json().catch(() => ({}))) as { message?: string };
			if (!res.ok) {
				toast(body.message || 'Could not register that domain.');
				return;
			}
			registered = d;
			step = 'domain_done';
		} catch (e) {
			toast((e as Error).message || 'Could not register that domain.');
		} finally {
			registering = false;
		}
	}
</script>

<div class="wizard">
	<div class="card">
		{#if step === 'choose'}
			<header>
				<span class="mark" aria-hidden="true"><Icon name="inbox" size={30} stroke={1.5} /></span>
				<h1>Your inbox is empty — because no mail is coming in yet</h1>
				<p class="sub">Connect a mailbox and it will start filling up. You can add more later.</p>
			</header>

			<ul class="options">
				<li>
					<span class="glyph" aria-hidden="true"><Icon name="mail" size={20} /></span>
					<div class="body">
						<h2>Gmail</h2>
						<p>Sync an existing Gmail account, both ways. Read, send, archive, and label.</p>
					</div>
					<Button disabled={connecting} onclick={connectGmail}>
						{connecting ? 'Redirecting…' : 'Connect'}
					</Button>
				</li>

				<li>
					<span class="glyph" aria-hidden="true"><Icon name="send" size={20} /></span>
					<div class="body">
						<h2>Your own domain</h2>
						<p>
							Receive mail at any address on a domain you own, via Cloudflare Email Routing.
							Every address becomes an alias automatically.
						</p>
					</div>
					<Button transparent onclick={() => (step = 'domain')}>Set up</Button>
				</li>

				<li>
					<span class="glyph" aria-hidden="true"><Icon name="archive" size={20} /></span>
					<div class="body">
						<h2>IMAP</h2>
						<p>Any other provider — Fastmail, iCloud, or a self-hosted server — with an app password.</p>
					</div>
					<Button transparent href="/settings/accounts">Open settings</Button>
				</li>
			</ul>

			{#if onSkip}
				<button class="skip" onclick={onSkip}>Skip for now — I'll do this later</button>
			{/if}
		{:else if step === 'domain'}
			<header>
				<span class="mark" aria-hidden="true"><Icon name="send" size={30} stroke={1.5} /></span>
				<h1>Which domain?</h1>
				<p class="sub">
					The domain itself — not a single address. Mail to <em>anything</em>@your-domain will land
					here, so you can invent an alias per site whenever you want one.
				</p>
			</header>

			<div class="domain-row">
				<Input bind:value={domain} placeholder="example.com" label="Domain" />
				<Button disabled={registering} onclick={registerDomain}>
					{registering ? 'Registering…' : 'Continue'}
				</Button>
			</div>

			<p class="note">
				The domain must be on Cloudflare, with Email Routing enabled. You'll point its mail at
				this app in the next step.
			</p>

			<button class="skip" onclick={() => (step = 'choose')}>Back</button>
		{:else}
			<header>
				<span class="mark done" aria-hidden="true"><Icon name="check" size={30} stroke={1.5} /></span>
				<h1>{registered} is registered</h1>
				<p class="sub">One manual step left, in the Cloudflare dashboard.</p>
			</header>

			<ol class="steps">
				<li>
					Open <strong>Cloudflare → {registered} → Email → Email Routing</strong>.
				</li>
				<li>
					Under <strong>Routing rules</strong>, edit the <strong>catch-all address</strong>: set its
					action to <strong>Send to a Worker</strong> and pick
					<strong>delightmail-server</strong>. If you currently forward this domain to another
					mailbox, this is the rule that replaces that forward.
				</li>
				<li>Make sure the catch-all rule is <strong>enabled</strong>, and save.</li>
			</ol>

			<p class="note">
				Mail sent to the domain from then on arrives here. Anything already forwarded elsewhere
				stays where it went — this only changes what happens next.
			</p>

			<div class="done-actions">
				<Button onclick={() => (step = 'choose')}>Connect something else</Button>
				<Button transparent href="/settings/accounts">Go to settings</Button>
			</div>
		{/if}
	</div>
</div>

<style>
	.wizard {
		flex: 1;
		min-width: 0;
		display: flex;
		align-items: flex-start;
		justify-content: center;
		overflow-y: auto;
		padding: var(--space-6) var(--space-4);
	}
	.card {
		width: 100%;
		max-width: 560px;
		display: flex;
		flex-direction: column;
		gap: var(--space-5);
	}
	header {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}
	.mark {
		display: grid;
		place-items: center;
		width: 52px;
		height: 52px;
		margin-bottom: var(--space-2);
		border-radius: var(--radius-lg);
		background: var(--color-bg-3);
		color: var(--color-primary);
	}
	.mark.done {
		color: var(--color-success);
	}
	h1 {
		margin: 0;
		font-size: var(--font-size-3);
		font-weight: 700;
		letter-spacing: -0.02em;
		line-height: 1.25;
	}
	.sub,
	.note {
		margin: 0;
		color: var(--color-text-muted);
		font-size: var(--font-size-0);
		line-height: 1.5;
	}
	.options {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
	}
	.options li {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		padding: var(--space-4);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-lg);
		background: var(--color-bg-2);
	}
	.glyph {
		display: grid;
		place-items: center;
		width: 36px;
		height: 36px;
		flex-shrink: 0;
		border-radius: var(--radius-md);
		background: var(--color-bg-3);
		color: var(--color-text-muted);
	}
	.body {
		flex: 1;
		min-width: 0;
	}
	.body h2 {
		margin: 0 0 2px;
		font-size: var(--font-size-1);
		font-weight: 600;
	}
	.body p {
		margin: 0;
		color: var(--color-text-disabled);
		font-size: var(--font-size-00);
		line-height: 1.45;
	}
	.domain-row {
		display: flex;
		align-items: flex-end;
		gap: var(--space-3);
	}
	.domain-row :global(> *:first-child) {
		flex: 1;
	}
	.steps {
		margin: 0;
		padding-left: var(--space-5);
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
		font-size: var(--font-size-0);
		line-height: 1.5;
	}
	.done-actions {
		display: flex;
		gap: var(--space-3);
	}
	.skip {
		align-self: flex-start;
		padding: 0;
		border: none;
		background: none;
		color: var(--color-text-disabled);
		font: inherit;
		font-size: var(--font-size-00);
		cursor: pointer;
		text-decoration: underline;
	}
	.skip:hover {
		color: var(--color-text);
	}
	@media (max-width: 767px) {
		.wizard {
			padding: var(--space-4) var(--space-3);
		}
		.options li {
			flex-wrap: wrap;
		}
	}
</style>
