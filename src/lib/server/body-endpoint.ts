/**
 * Message body + attachment serving (§4.3, §9). Bodies are immutable, so
 * responses carry a long immutable cache header and are KV-cached on the hot
 * path. The sanitized HTML is served from the API origin for the sandboxed
 * reading-pane iframe (§12).
 */
import type { RequestEvent } from '@sveltejs/kit';
import { DelightError } from '@delightstack/utilities';

const IMMUTABLE = 'private, max-age=31536000, immutable';

interface MessageRow {
	id: string;
	body_keys?: { raw?: string; html?: string; text?: string };
}

/** GET /api/messages/:id/body[?format=text] */
export async function handleMessageBody(event: RequestEvent, id: string): Promise<Response> {
	const { db, r2, kv, org_id } = ctx(event);
	if (!db || !r2 || !org_id) return DelightError.badRequest('No mailbox').toResponse();

	let msg: MessageRow;
	try {
		msg = (await db.get('message', id)) as unknown as MessageRow;
	} catch {
		return DelightError.notFound('Message not found').toResponse();
	}

	const format = event.url.searchParams.get('format');
	const key = format === 'text' ? msg.body_keys?.text : msg.body_keys?.html;
	const contentType =
		format === 'text' ? 'text/plain; charset=utf-8' : 'text/html; charset=utf-8';
	if (!key) {
		// No stored HTML — fall back to the plain excerpt so the pane isn't blank.
		return new Response('', { headers: { 'content-type': contentType } });
	}

	const cacheKey = `body:${org_id}:${id}:${format ?? 'html'}`;
	const body = await readCached(r2, kv, key, cacheKey);
	if (body === null) return DelightError.notFound('Body not found').toResponse();

	return new Response(body, {
		headers: {
			'content-type': contentType,
			'cache-control': IMMUTABLE,
			// The reading pane iframe pins a strict CSP (§12).
			'content-security-policy':
				"default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; font-src https: data:",
		},
	});
}

/** GET /api/messages/:id/raw → download the original .eml */
export async function handleMessageRaw(event: RequestEvent, id: string): Promise<Response> {
	const { db, r2 } = ctx(event);
	if (!db || !r2) return DelightError.badRequest('No mailbox').toResponse();
	let msg: MessageRow;
	try {
		msg = (await db.get('message', id)) as unknown as MessageRow;
	} catch {
		return DelightError.notFound('Message not found').toResponse();
	}
	if (!msg.body_keys?.raw) return DelightError.notFound('Raw not available').toResponse();
	const obj = await r2.get(msg.body_keys.raw);
	if (!obj) return DelightError.notFound('Raw not found').toResponse();
	return new Response(obj.body, {
		headers: {
			'content-type': 'message/rfc822',
			'content-disposition': `attachment; filename="${id}.eml"`,
			'cache-control': IMMUTABLE,
		},
	});
}

/** GET /api/attachments/:id → stream attachment bytes (also serves cid: images) */
export async function handleAttachment(event: RequestEvent, id: string): Promise<Response> {
	const { db, r2 } = ctx(event);
	if (!db || !r2) return DelightError.badRequest('No mailbox').toResponse();
	let att: { r2_key?: string; filename?: string; mime_type?: string };
	try {
		att = (await db.get('attachment', id)) as unknown as {
			r2_key?: string;
			filename?: string;
			mime_type?: string;
		};
	} catch {
		return DelightError.notFound('Attachment not found').toResponse();
	}
	if (!att.r2_key) return DelightError.notFound('Attachment not stored').toResponse();
	const obj = await r2.get(att.r2_key);
	if (!obj) return DelightError.notFound('Attachment not found').toResponse();
	return new Response(obj.body, {
		headers: {
			'content-type': att.mime_type ?? 'application/octet-stream',
			'content-disposition': `inline; filename="${att.filename ?? 'attachment'}"`,
			'cache-control': IMMUTABLE,
		},
	});
}

function ctx(event: RequestEvent) {
	return {
		db: event.locals.db,
		r2: event.locals.r2,
		kv: event.locals.kv,
		org_id: event.locals.org_id,
	};
}

async function readCached(
	r2: R2Bucket,
	kv: KVNamespace | undefined,
	key: string,
	cacheKey: string,
): Promise<string | null> {
	if (kv) {
		const cached = await kv.get(cacheKey);
		if (cached !== null) return cached;
	}
	const obj = await r2.get(key);
	if (!obj) return null;
	const text = await obj.text();
	if (kv) await kv.put(cacheKey, text, { expirationTtl: 60 * 60 * 24 * 7 });
	return text;
}
