<script lang="ts">
	import { Button, Input, Callout } from '@delightstack/components';
	import { onMount } from 'svelte';

	const { data } = $props();
	const { auth } = $derived(data);

	let email = $state('');
	let code = $state('');
	let stage = $state<'email' | 'code'>('email');
	let error = $state('');
	let notice = $state('');
	let busy = $state(false);
	let passkeySupported = $state(false);

	onMount(() => {
		passkeySupported = auth.passkey.isSupported();
		// Offer passkey autofill (conditional UI) if the browser supports it.
		auth.passkey.isAutofillSupported().then((ok) => {
			if (ok) {
				auth.signIn
					.passkey({ autofill: true })
					.then(() => (window.location.href = '/mail/inbox'))
					.catch(() => {
						/* user dismissed autofill — ignore */
					});
			}
		});
	});

	async function requestLink(e: Event) {
		e.preventDefault();
		const addr = email.trim();
		if (!addr) return;
		error = '';
		notice = '';
		busy = true;
		try {
			await auth.signIn.emailMagicLink({ email: addr });
			stage = 'code';
			notice = `We emailed a sign-in link and code to ${addr}.`;
		} catch (magicErr) {
			// First contact (§8): no account yet → create a passwordless account,
			// which signs the owner in directly. Only allowed emails get this far
			// (the signup gate rejects others). Subsequent sign-ins use magic
			// link or passkey.
			try {
				await auth.signUp.email({ name: addr.split('@')[0], email: addr });
				window.location.href = '/mail/inbox';
			} catch (signupErr) {
				error =
					(signupErr as { message?: string })?.message ||
					(magicErr as { message?: string })?.message ||
					'Could not sign in. Check the email address and try again.';
			}
		} finally {
			busy = false;
		}
	}

	async function verifyCode(e: Event) {
		e.preventDefault();
		if (!code.trim()) return;
		error = '';
		busy = true;
		try {
			await auth.signIn.emailCode({ email: email.trim(), code: code.trim() });
			window.location.href = '/mail/inbox';
		} catch (e) {
			error = (e as { message?: string })?.message || 'That code did not work.';
		} finally {
			busy = false;
		}
	}

	async function signInWithPasskey() {
		error = '';
		busy = true;
		try {
			await auth.signIn.passkey();
			window.location.href = '/mail/inbox';
		} catch (e) {
			error = (e as { message?: string })?.message || 'Passkey sign-in failed.';
		} finally {
			busy = false;
		}
	}
</script>

<svelte:head><title>Sign in · Mail</title></svelte:head>

<div class="auth-page">
	<div class="auth-card">
		<div class="brand">Mail</div>
		<p class="subtitle">A calm, fast, keyboard-first inbox.</p>

		{#if error}<Callout error>{error}</Callout>{/if}
		{#if notice}<Callout>{notice}</Callout>{/if}

		{#if stage === 'email'}
			<form onsubmit={requestLink}>
				<Input
					label="Email"
					type="email"
					bind:value={email}
					required
					placeholder="you@example.com" />
				<Button type="submit" full_width disabled={busy}>
					{busy ? 'Sending…' : 'Email me a sign-in link'}
				</Button>
			</form>
		{:else}
			<form onsubmit={verifyCode}>
				<Input
					label="Sign-in code"
					bind:value={code}
					required
					placeholder="6-character code" />
				<Button type="submit" full_width disabled={busy}>
					{busy ? 'Verifying…' : 'Verify code'}
				</Button>
				<button type="button" class="link" onclick={() => (stage = 'email')}>
					Use a different email
				</button>
			</form>
		{/if}

		{#if passkeySupported}
			<div class="divider"><span>or</span></div>
			<Button full_width transparent disabled={busy} onclick={signInWithPasskey}>
				Sign in with a passkey
			</Button>
		{/if}
	</div>
</div>

<style>
	.auth-page {
		display: flex;
		align-items: center;
		justify-content: center;
		min-height: 100dvh;
		padding: var(--space-5);
	}
	.auth-card {
		width: 100%;
		max-width: 380px;
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
	}
	.brand {
		font-size: var(--font-size-5);
		font-weight: 800;
		letter-spacing: -0.03em;
	}
	.subtitle {
		color: var(--color-text-disabled);
		margin: 0;
	}
	form {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
	}
	.divider {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		color: var(--color-text-disabled);
		font-size: var(--font-size-0);
	}
	.divider::before,
	.divider::after {
		content: '';
		flex: 1;
		height: 1px;
		background: var(--color-border);
	}
	.link {
		background: none;
		border: none;
		color: var(--color-action, var(--color-primary));
		cursor: pointer;
		font: inherit;
		padding: 0;
	}
</style>
