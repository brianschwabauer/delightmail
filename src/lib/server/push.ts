/**
 * Web-push subscription endpoints (§10.4). Subscriptions are stored per device;
 * MailboxServer sends pushes for important new mail. VAPID keys are optional —
 * push is simply disabled when they're absent.
 */
import type { RequestEvent } from '@sveltejs/kit';
import { DelightError } from '@delightstack/utilities';

function env(event: RequestEvent): App.CloudflareEnv | undefined {
	return (event.platform as App.Platform | undefined)?.env;
}

/** GET /api/push/vapid — public key for the client to subscribe (or 404 if off). */
export function handleVapidKey(event: RequestEvent): Response {
	const key = env(event)?.VAPID_PUBLIC_KEY;
	if (!key) return DelightError.notFound('Push is not configured on this instance.').toResponse();
	return Response.json({ publicKey: key });
}

/** POST /api/push/subscribe — store a PushSubscription for this device. */
export async function handlePushSubscribe(event: RequestEvent): Promise<Response> {
	const db = event.locals.db;
	if (!db) return DelightError.badRequest('No mailbox').toResponse();
	const body = (await event.request.json().catch(() => null)) as {
		endpoint?: string;
		keys?: { p256dh?: string; auth?: string };
		device_label?: string;
	} | null;
	if (!body?.endpoint || !body.keys?.p256dh || !body.keys?.auth) {
		return DelightError.badRequest('Invalid subscription').toResponse();
	}

	// Upsert on endpoint (unique).
	const existing = await db.list('push_subscription', {
		where: { endpoint: body.endpoint },
		limit: 1,
	});
	if (existing.docs.length) {
		return Response.json({ ok: true, id: (existing.docs[0] as { id: string }).id });
	}
	const row = await db.create('push_subscription', {
		endpoint: body.endpoint,
		keys: { p256dh: body.keys.p256dh, auth: body.keys.auth },
		device_label: body.device_label ?? 'This device',
		failed_count: 0,
	});
	return Response.json({ ok: true, id: (row as { id: string }).id });
}

/** DELETE /api/push/subscribe — remove this device's subscription. */
export async function handlePushUnsubscribe(event: RequestEvent): Promise<Response> {
	const db = event.locals.db;
	if (!db) return DelightError.badRequest('No mailbox').toResponse();
	const body = (await event.request.json().catch(() => null)) as { endpoint?: string } | null;
	if (!body?.endpoint) return DelightError.badRequest('Missing endpoint').toResponse();
	const existing = await db.list('push_subscription', {
		where: { endpoint: body.endpoint },
		limit: 1,
	});
	if (existing.docs.length) await db.delete('push_subscription', (existing.docs[0] as { id: string }).id);
	return Response.json({ ok: true });
}
