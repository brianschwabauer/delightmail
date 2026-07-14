/**
 * Client-side web-push subscription. Requests permission, subscribes via
 * the service worker using the server's VAPID public key, and registers the
 * subscription. iOS requires the PWA installed to Home Screen (16.4+).
 */
export async function isPushSupported(): Promise<boolean> {
	return (
		typeof navigator !== 'undefined' &&
		'serviceWorker' in navigator &&
		'PushManager' in window &&
		'Notification' in window
	);
}

export async function enablePush(): Promise<{ ok: boolean; reason?: string }> {
	if (!(await isPushSupported())) return { ok: false, reason: 'Push is not supported on this device.' };

	const vapidRes = await fetch('/api/push/vapid');
	if (!vapidRes.ok) return { ok: false, reason: 'Push is not configured on this instance.' };
	const { publicKey } = (await vapidRes.json()) as { publicKey: string };

	const permission = await Notification.requestPermission();
	if (permission !== 'granted') return { ok: false, reason: 'Notification permission denied.' };

	const reg = await navigator.serviceWorker.ready;
	const existing = await reg.pushManager.getSubscription();
	const sub =
		existing ??
		(await reg.pushManager.subscribe({
			userVisibleOnly: true,
			applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
		}));

	const json = sub.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
	const res = await fetch('/api/push/subscribe', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			endpoint: json.endpoint,
			keys: json.keys,
			device_label: navigator.platform || 'This device',
		}),
	});
	if (!res.ok) return { ok: false, reason: 'Could not register the subscription.' };
	return { ok: true };
}

function urlBase64ToUint8Array(base64: string): Uint8Array {
	const padded = base64.replace(/-/g, '+').replace(/_/g, '/');
	const withPad = padded.padEnd(padded.length + ((4 - (padded.length % 4)) % 4), '=');
	const raw = atob(withPad);
	const out = new Uint8Array(raw.length);
	for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
	return out;
}
