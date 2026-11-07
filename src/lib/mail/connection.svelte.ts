import type { WebsocketClient } from '@delightstack/websocket/client';

/** How long a dropped connection may take to come back before we call it out. */
const GRACE_MS = 5_000;

/**
 * What the UI should say about the live connection. A page that has just
 * loaded, or a socket that blips and reconnects within a few seconds, is not
 * "offline" — showing it was alarming (and on every phone load, wrong). Only a
 * browser that reports no network, or a connection still down after the grace
 * period, is.
 */
export function connectionState(getWs: () => WebsocketClient) {
	let overdue = $state(false);
	let browserOnline = $state(typeof navigator === 'undefined' ? true : navigator.onLine);

	$effect(() => {
		const up = () => (browserOnline = true);
		const down = () => (browserOnline = false);
		window.addEventListener('online', up);
		window.addEventListener('offline', down);
		return () => {
			window.removeEventListener('online', up);
			window.removeEventListener('offline', down);
		};
	});

	$effect(() => {
		overdue = false;
		if (getWs().connected) return;
		const t = setTimeout(() => (overdue = true), GRACE_MS);
		return () => clearTimeout(t);
	});

	return {
		get label(): 'Live' | 'Connecting…' | 'Offline' {
			if (!browserOnline) return 'Offline';
			if (getWs().connected) return 'Live';
			return overdue ? 'Offline' : 'Connecting…';
		},
		/** True once it's worth telling the user (see above). */
		get offline(): boolean {
			return !browserOnline || (!getWs().connected && overdue);
		},
	};
}
