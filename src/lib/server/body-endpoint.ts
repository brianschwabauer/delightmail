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
	const contentType = format === 'text' ? 'text/plain; charset=utf-8' : 'text/html; charset=utf-8';
	if (!key) {
		// No stored HTML — fall back to the plain excerpt so the pane isn't blank.
		return new Response('', { headers: { 'content-type': contentType } });
	}

	// Tenant guard: every R2 key is `{org_id}/…`. Never read a key outside the
	// caller's org, even if a tampered body_keys points elsewhere (§12 IDOR).
	if (!ownsKey(key, org_id)) return DelightError.notFound('Body not found').toResponse();

	const cacheKey = `body:${org_id}:${id}:${format ?? 'html'}`;
	const body = await readCached(r2, kv, key, cacheKey);
	if (body === null) return DelightError.notFound('Body not found').toResponse();

	return new Response(body, {
		headers: {
			'content-type': contentType,
			'x-content-type-options': 'nosniff',
			'cache-control': IMMUTABLE,
			// The reading pane iframe pins a strict CSP (§12).
			'content-security-policy':
				"default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; font-src https: data:",
		},
	});
}

/** GET /api/messages/:id/raw → download the original .eml */
export async function handleMessageRaw(event: RequestEvent, id: string): Promise<Response> {
	const { db, r2, org_id } = ctx(event);
	if (!db || !r2 || !org_id) return DelightError.badRequest('No mailbox').toResponse();
	let msg: MessageRow;
	try {
		msg = (await db.get('message', id)) as unknown as MessageRow;
	} catch {
		return DelightError.notFound('Message not found').toResponse();
	}
	if (!msg.body_keys?.raw || !ownsKey(msg.body_keys.raw, org_id)) {
		return DelightError.notFound('Raw not available').toResponse();
	}
	const obj = await r2.get(msg.body_keys.raw);
	if (!obj) return DelightError.notFound('Raw not found').toResponse();
	return new Response(obj.body, {
		headers: {
			'content-type': 'message/rfc822',
			'content-disposition': contentDisposition('attachment', `${id}.eml`),
			'x-content-type-options': 'nosniff',
			'cache-control': IMMUTABLE,
		},
	});
}

/** GET /api/attachments/:id → stream attachment bytes (also serves cid: images) */
export async function handleAttachment(event: RequestEvent, id: string): Promise<Response> {
	const { db, r2, org_id } = ctx(event);
	if (!db || !r2 || !org_id) return DelightError.badRequest('No mailbox').toResponse();
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
	if (!att.r2_key || !ownsKey(att.r2_key, org_id)) {
		return DelightError.notFound('Attachment not stored').toResponse();
	}
	const obj = await r2.get(att.r2_key);
	if (!obj) return DelightError.notFound('Attachment not found').toResponse();
	// Attachment bytes and their mime_type are attacker-controlled (they come
	// straight from inbound MIME) and are served from the app origin. Only render
	// safe raster images inline (cid: images resolve here); force everything else —
	// notably text/html and image/svg+xml, which execute script when rendered as a
	// document — to download so it can never run in our origin (§12 stored XSS).
	const mime = (att.mime_type ?? 'application/octet-stream').replace(/[\r\n]/g, '');
	const baseType = mime.split(';')[0].trim().toLowerCase();
	const disposition = INLINE_SAFE_TYPES.has(baseType) ? 'inline' : 'attachment';
	return new Response(obj.body, {
		headers: {
			'content-type': mime,
			'content-disposition': contentDisposition(disposition, att.filename),
			'x-content-type-options': 'nosniff',
			'content-security-policy': "default-src 'none'; sandbox",
			'cache-control': IMMUTABLE,
		},
	});
}

/** Every R2 key is `{org_id}/…` — reject anything outside the caller's org. */
function ownsKey(key: string, org_id: string): boolean {
	return key.startsWith(`${org_id}/`);
}

/**
 * Raster image types safe to render inline in the reading-pane iframe. Anything
 * not listed (text/html, image/svg+xml, PDFs, …) is served as a download so a
 * top-level open of the attachment URL can never execute in the app origin.
 */
const INLINE_SAFE_TYPES = new Set([
	'image/png',
	'image/jpeg',
	'image/gif',
	'image/webp',
	'image/bmp',
	'image/avif',
	'image/x-icon',
	'image/vnd.microsoft.icon',
]);

/** Build a header-injection-safe Content-Disposition with a UTF-8 filename. */
function contentDisposition(kind: 'inline' | 'attachment', filename?: string): string {
	const name = filename && filename.trim() ? filename : 'attachment';
	// ASCII fallback strips anything outside printable ASCII (incl. CR/LF) plus the
	// quote/backslash that could break out of the quoted string.
	const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || 'attachment';
	return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024; // 25 MB (§10.3)

/** POST /api/attachments/upload — store a compose attachment, return its R2 key. */
export async function handleAttachmentUpload(event: RequestEvent): Promise<Response> {
	const { r2, org_id } = ctx(event);
	if (!r2 || !org_id) return DelightError.badRequest('No mailbox').toResponse();
	let file: File | null = null;
	try {
		const form = await event.request.formData();
		const f = form.get('file');
		if (f instanceof File) file = f;
	} catch {
		/* not multipart */
	}
	if (!file) return DelightError.badRequest('No file uploaded').toResponse();
	if (file.size > MAX_ATTACHMENT_BYTES) {
		return DelightError.badRequest('Attachment exceeds the 25 MB limit.').toResponse();
	}
	const r2_key = `${org_id}/att/upload/${crypto.randomUUID()}`;
	const mime_type = file.type || 'application/octet-stream';
	await r2.put(r2_key, await file.arrayBuffer(), { httpMetadata: { contentType: mime_type } });
	return Response.json({ r2_key, filename: file.name || 'attachment', mime_type, size: file.size });
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
