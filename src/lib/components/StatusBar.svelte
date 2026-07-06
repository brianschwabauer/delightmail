<script lang="ts">
	import type { AuthClient } from '@delightstack/auth/client';
	import type { WebsocketClient } from '@delightstack/websocket/client';

	interface Props {
		auth: AuthClient;
		ws: WebsocketClient;
	}
	const { ws }: Props = $props();

	const online = $derived(ws.connected);
</script>

<footer class="statusbar">
	<span class="left">
		<span class="pill" class:offline={!online}>{online ? 'Live' : 'Offline'}</span>
	</span>
	<span class="hint">j/k navigate · x select · ? help · Ctrl+K commands</span>
</footer>

<style>
	.statusbar {
		--dm-statusbar-h: 28px;
		height: 28px;
		display: flex;
		align-items: center;
		gap: var(--size-3);
		padding: 0 var(--size-3);
		background: var(--color-bg-2);
		border-top: 1px solid var(--color-outline);
		font-size: var(--font-size-00, 0.72rem);
		color: var(--color-text-disabled);
		font-variant-numeric: tabular-nums;
	}
	.pill {
		color: var(--color-success, #1a7f4b);
		font-weight: 600;
	}
	.pill.offline {
		color: var(--color-warning, #b25d09);
	}
	.hint {
		margin-left: auto;
		font-family: var(--font-mono, ui-monospace, monospace);
	}
</style>
