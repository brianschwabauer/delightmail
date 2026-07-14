<script lang="ts">
	import type { AuthClient } from '@delightstack/auth/client';
	import type { WebsocketClient } from '@delightstack/websocket/client';
	import { useFocus } from '$lib/mail/focus.svelte';

	interface Props {
		auth: AuthClient;
		ws: WebsocketClient;
	}
	const { ws }: Props = $props();

	const online = $derived(ws.connected);
	const focus = useFocus();
	const paneLabel = $derived(
		focus.is('folders') ? 'Folders' : focus.is('reading') ? 'Reading' : 'List',
	);
</script>

<footer class="statusbar">
	<span class="pill" class:offline={!online}>
		<span class="led" aria-hidden="true"></span>{online ? 'Live' : 'Offline'}
	</span>
	<span class="pane" aria-label="Focused pane">{paneLabel}</span>
	<span class="hints">
		<span class="hk"><kbd>h</kbd><kbd>j</kbd><kbd>k</kbd><kbd>l</kbd> Move</span>
		<span class="hk"><kbd>x</kbd> Select</span>
		<span class="hk"><kbd>?</kbd> Help</span>
		<span class="hk"><kbd>Ctrl</kbd><kbd>K</kbd> Commands</span>
	</span>
</footer>

<style>
	.statusbar {
		height: 28px;
		display: flex;
		align-items: center;
		gap: var(--space-3);
		padding: 0 var(--space-3);
		background: var(--color-bg-2);
		border-top: 1px solid var(--color-border);
		font-size: var(--font-size-00);
		color: var(--color-text-disabled);
	}
	.pill {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		color: var(--color-success, #1a7f4b);
		font-weight: var(--font-weight-semibold, 600);
	}
	.pill.offline {
		color: var(--color-warning, #b25d09);
	}
	.led {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: currentColor;
		box-shadow: 0 0 0 2px color-mix(in oklab, currentColor 25%, transparent);
	}
	.pane {
		color: var(--color-text-muted, var(--color-text-disabled));
		border-left: 1px solid var(--color-border);
		padding-left: var(--space-3);
	}
	.hints {
		margin-left: auto;
		display: flex;
		gap: var(--space-3);
	}
	.hk {
		display: inline-flex;
		align-items: center;
		gap: 3px;
		white-space: nowrap;
	}
	kbd {
		font-family: var(--font-mono);
		font-size: 0.92em;
		background: var(--color-bg-1);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-sm);
		padding: 0 4px;
		color: var(--color-text-muted, var(--color-text-disabled));
	}
	/* Mobile has no keyboard: the whole bar is shortcut hints + pane focus, so it
	   goes away entirely and the layout reclaims its 28px (mobile). The Live/
	   Offline signal is worth keeping — it moves into the list header instead. */
	@media (max-width: 767px) {
		.statusbar {
			display: none;
		}
	}
</style>
