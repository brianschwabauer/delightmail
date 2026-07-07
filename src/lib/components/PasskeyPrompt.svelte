<script lang="ts">
	import type { AuthClient } from '@delightstack/auth/client';
	import { Button, toast } from '@delightstack/components';
	import { onMount } from 'svelte';

	interface Props {
		auth: AuthClient;
	}
	const { auth }: Props = $props();

	let show = $state(false);
	let busy = $state(false);

	const DISMISS_KEY = 'dm-passkey-prompt-dismissed';

	onMount(async () => {
		if (typeof localStorage !== 'undefined' && localStorage.getItem(DISMISS_KEY)) return;
		if (!auth.passkey.isSupported()) return;
		try {
			const { count } = await auth.passkey.list();
			if (count === 0) show = true;
		} catch {
			/* ignore */
		}
	});

	async function register() {
		busy = true;
		try {
			await auth.passkey.register('This device');
			toast('Passkey registered — you can sign in without email next time.');
			show = false;
		} catch (e) {
			toast((e as { message?: string })?.message || 'Could not register passkey.');
		} finally {
			busy = false;
		}
	}

	function dismiss() {
		if (typeof localStorage !== 'undefined') localStorage.setItem(DISMISS_KEY, '1');
		show = false;
	}
</script>

{#if show}
	<div class="prompt" role="dialog" aria-label="Register a passkey">
		<div class="text">
			<strong>Set up a passkey</strong>
			<span>Sign in instantly next time — no email needed.</span>
		</div>
		<div class="actions">
			<Button disabled={busy} onclick={register}>{busy ? 'Setting up…' : 'Add passkey'}</Button>
			<button class="later" onclick={dismiss}>Later</button>
		</div>
	</div>
{/if}

<style>
	.prompt {
		position: fixed;
		right: var(--space-4);
		bottom: calc(28px + var(--space-3));
		z-index: 50;
		max-width: 320px;
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
		padding: var(--space-4);
		background: var(--color-bg-1);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-lg);
		box-shadow: var(--shadow-lg, 0 8px 24px rgba(0, 0, 0, 0.18));
	}
	.text {
		display: flex;
		flex-direction: column;
		gap: 2px;
		font-size: var(--font-size-0);
	}
	.text span {
		color: var(--color-text-disabled);
	}
	.actions {
		display: flex;
		align-items: center;
		gap: var(--space-2);
	}
	.later {
		background: none;
		border: none;
		color: var(--color-text-disabled);
		cursor: pointer;
		font: inherit;
	}
</style>
