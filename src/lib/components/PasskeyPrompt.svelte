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

	/** Epoch ms until which the prompt stays away ("Later"). */
	const SNOOZE_KEY = 'dm-passkey-prompt-snoozed-until';
	const SNOOZE_MS = 30 * 24 * 60 * 60 * 1000;
	/** Don't greet a fresh sign-in with a popup: wait until they've settled in. */
	const SHOW_AFTER_MS = 20_000;

	function snoozed(): boolean {
		try {
			// The old flag meant "never"; honour it as a snooze from now.
			if (localStorage.getItem('dm-passkey-prompt-dismissed')) {
				localStorage.removeItem('dm-passkey-prompt-dismissed');
				localStorage.setItem(SNOOZE_KEY, String(Date.now() + SNOOZE_MS));
			}
			return Number(localStorage.getItem(SNOOZE_KEY) ?? 0) > Date.now();
		} catch {
			return false;
		}
	}

	onMount(() => {
		if (snoozed() || !auth.passkey.isSupported()) return;
		const timer = setTimeout(async () => {
			try {
				const { count } = await auth.passkey.list();
				if (count === 0) show = true;
			} catch {
				/* ignore */
			}
		}, SHOW_AFTER_MS);
		return () => clearTimeout(timer);
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
		try {
			localStorage.setItem(SNOOZE_KEY, String(Date.now() + SNOOZE_MS));
		} catch {
			/* private mode — it just shows again next session */
		}
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
			<!-- One size for both, so the pair reads as a choice rather than a
			     big button with a stray link beside it. -->
			<Button size="0" loading={busy} onclick={register}>Add passkey</Button>
			<Button size="0" outline onclick={dismiss}>Not now</Button>
		</div>
	</div>
{/if}

<style>
	.prompt {
		--inset: var(--space-4);
		position: fixed;
		right: var(--space-4);
		bottom: calc(28px + var(--space-3));
		z-index: 50;
		max-width: 320px;
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
		padding: var(--inset);
		background: var(--color-bg-1);
		border: 1px solid var(--color-border);
		/* Concentric with the buttons in its bottom corner: their radius + the inset. */
		border-radius: calc(var(--radius-md) + var(--inset));
		box-shadow: var(--shadow-lg, 0 8px 24px rgba(0, 0, 0, 0.18));
		@supports (corner-shape: squircle) {
			corner-shape: squircle;
			border-radius: calc((var(--radius-md) + var(--inset)) * 2);
		}
	}
	/* Phones: no status bar, and the compose button owns the bottom-right
	   corner — sit full-width above it instead of covering it. */
	@media (max-width: 767px) {
		.prompt {
			left: var(--space-3);
			right: var(--space-3);
			max-width: none;
			bottom: calc(56px + var(--space-4) * 2 + env(safe-area-inset-bottom));
		}
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
</style>
