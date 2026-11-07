/**
 * Message body + attachment serving. Bodies are immutable, so
 * responses carry a long immutable cache header and are KV-cached on the hot
 * path. The sanitized HTML is served from the API origin for the sandboxed
 * reading-pane iframe.
 */
import type { RequestEvent } from '@sveltejs/kit';
import { DelightError } from '@delightstack/utilities';
import { classifyBody, flipColors } from './dark-mail';
import { stripTrackingPixels } from './tracking-pixels';
import { getImage, rewriteImageUrls } from '../mail/image-cache';

const IMMUTABLE = 'private, max-age=31536000, immutable';

/**
 * Bodies never change once stored, so the KV copy can live a long time. It used
 * to expire after 7 days, which made every older message pay the slow path
 * (MailboxServer wake + R2 read, 400–700ms in prod) on each first open.
 */
const BODY_KV_TTL_SECONDS = 60 * 60 * 24 * 365;
/** Let the edge cache hot KV reads instead of re-reading central storage (default is 60s). */
const BODY_KV_EDGE_TTL_SECONDS = 60 * 60 * 24 * 30;

interface MessageRow {
	id: string;
	body_keys?: { raw?: string; html?: string; text?: string };
}

/** GET /api/messages/:id/body[?format=text] */
export async function handleMessageBody(event: RequestEvent, id: string): Promise<Response> {
	const { db, r2, kv, org_id } = ctx(event);
	if (!db || !r2 || !org_id) return DelightError.badRequest('No mailbox').toResponse();

	const format = event.url.searchParams.get('format');
	const scheme = event.url.searchParams.get('scheme') === 'dark' ? 'dark' : 'light';
	const contentType = format === 'text' ? 'text/plain; charset=utf-8' : 'text/html; charset=utf-8';

	// KV first: the cache key is computable from request context alone (and the
	// org prefix comes from the session, so a hit is tenant-safe by
	// construction). Probing after the db.get meant every KV-warm request still
	// paid a MailboxServer DO wake for a row it didn't need. (KV stores the RAW
	// sanitized body; typography wraps at response time, so no cache versioning.)
	const cacheKey = `body:${org_id}:${id}:${format ?? 'html'}`;
	if (kv) {
		const cached = await kv.get(cacheKey, { cacheTtl: BODY_KV_EDGE_TTL_SECONDS });
		if (cached !== null) {
			return bodyResponse(
				format === 'text' ? cached : typeset(serveable(cached), scheme),
				contentType,
			);
		}
	}

	let msg: MessageRow;
	try {
		msg = (await db.get('message', id)) as unknown as MessageRow;
	} catch {
		return DelightError.notFound('Message not found').toResponse();
	}

	// Text-only mail (npm/GitHub notices, most transactional mail) has no HTML
	// body — serve the FULL stored text wrapped as minimal HTML instead of an
	// empty response, so the reading pane renders it typeset rather than blank
	// (the client can't always tell text-only mail apart: sparse search hits
	// lack body_keys, so it optimistically requests the HTML body).
	let key = format === 'text' ? msg.body_keys?.text : msg.body_keys?.html;
	let text_as_html = false;
	if (!key && format !== 'text' && msg.body_keys?.text) {
		key = msg.body_keys.text;
		text_as_html = true;
	}
	if (!key) {
		// Nothing stored at all — the pane falls back to the excerpt.
		return new Response('', { headers: { 'content-type': contentType } });
	}

	// Tenant guard: every R2 key is `{org_id}/…`. Never read a key outside the
	// caller's org, even if a tampered body_keys points elsewhere (IDOR).
	if (!ownsKey(key, org_id)) return DelightError.notFound('Body not found').toResponse();

	const body = await readStored(
		event,
		r2,
		kv,
		key,
		cacheKey,
		text_as_html ? textToHtml : undefined,
	);
	if (body === null) return DelightError.notFound('Body not found').toResponse();
	return bodyResponse(format === 'text' ? body : typeset(serveable(body), scheme), contentType);
}

/**
 * Serve-time repair of bodies sanitized by older ingest code. Stored bodies are
 * immutable, so sanitizer fixes can't reach mail already in R2/KV — undo the two
 * known defects here instead:
 * 1. The sanitizer used to prefix ids with `user-content-` (DOM-clobber guard,
 *    pointless in this script-free document), which broke every id selector in
 *    kept <style> blocks — e.g. a newsletter's `#body { background:#030303 }`
 *    dark-mode rule stopped matching while its `p { color:#fff !important }`
 *    still applied: white-on-white, invisible mail.
 * 2. Stripping <title> used to keep its text, leaking the subject line as bare
 *    text at the very top of the body (before the first tag, which for a full
 *    HTML email is a head-remnant <style>).
 * Also strips obvious tracking pixels (tracking-pixels.ts) — serve-time so it
 * reaches stored mail too. Bump the `v=` query in MessageBody.svelte when any of
 * this changes: responses are cached immutable.
 */
/** Stored body → what the reader gets: legacy repairs, then every remote image proxied. */
function serveable(html: string): string {
	return rewriteImageUrls(upgradeLegacyBody(html));
}

function upgradeLegacyBody(html: string): string {
	return stripTrackingPixels(
		html
			.replace(/(\b(?:id|name)=")user-content-/g, '$1')
			.replace(/(href="#)user-content-/g, '$1')
			.replace(/^\s*[^<]+?\s*(?=<style[\s>])/i, ''),
	);
}

/**
 * Serve-time typography for the reading pane. Plain and lightly-formatted
 * email otherwise renders at browser defaults inside the iframe — Times New
 * Roman, black-on-white, line-height 1.2 — the worst-typeset surface in the
 * app. Heavily-designed HTML mail overrides all of this with its own inline
 * styles/tables and is unharmed. In the dark scheme, classifyBody() decides:
 * designed mail keeps its white sheet, colorless mail gets the dark palette,
 * and personal mail that merely sets text colors gets the dark palette with
 * its colors re-mapped for it (see dark-mail.ts).
 */
function typeset(html: string, scheme: 'light' | 'dark'): string {
	const tier = classifyBody(html);
	// Mail the sender didn't design (a note from a person, a plain notification)
	// renders straight onto the reading pane — no white sheet, no card around it —
	// so it reads like a message rather than a form. Designed mail keeps its sheet.
	const bare = tier !== 'design';
	const dark = scheme === 'dark' && bare;
	const bg = bare ? 'transparent' : '#ffffff';
	const palette = dark ? `color:#dde1e6;background:${bg};` : `color:#1f2328;background:${bg};`;
	const link = dark ? '#8ab0ff' : '#3b5fc9';
	const quote = dark ? '#3a4048' : '#d0d4da';
	const quoteText = dark ? '#9aa4b0' : '#57606a';
	// Colours are re-mapped against the dark pane they will actually sit on.
	if (dark && tier === 'flip') html = flipColors(html, '#16181c');
	const padding = bare ? '2px 0 8px' : '20px 24px';
	return (
		// The reading pane reads this to drop the card around bare bodies.
		`<meta name="dm-tier" content="${tier}">` +
		`<style>` +
		// A transparent frame only shows the pane through it when its colour scheme
		// matches the page's; a mismatch makes the browser paint an opaque backdrop.
		`html{background:${bg};color-scheme:${dark ? 'dark' : 'light'}}` +
		`body{margin:0;padding:${padding};${palette}` +
		`font:15px/1.65 system-ui,-apple-system,'Segoe UI',sans-serif;` +
		`overflow-wrap:break-word;-webkit-text-size-adjust:100%}` +
		`a{color:${link}}` +
		`img{max-width:100%;height:auto}` +
		`blockquote{margin:0 0 0 2px;padding-left:12px;border-left:2px solid ${quote};color:${quoteText}}` +
		`pre{overflow-x:auto;font-size:0.9em}` +
		`table{max-width:100%}` +
		`</style>` +
		html
	);
}

function bodyResponse(body: string, contentType: string): Response {
	return new Response(body, {
		headers: {
			'content-type': contentType,
			'x-content-type-options': 'nosniff',
			'cache-control': IMMUTABLE,
			// The reading pane iframe pins a strict CSP. Images load only from our
			// own proxy ('self' — every remote URL is rewritten to /api/img), so a
			// body can never make the reader's browser contact a sender: no read
			// receipts, no IP or timing leaks, even for a URL the rewrite missed.
			// Google Fonts stylesheets are the one external CSS host allowed — big
			// senders (YouTube, marketing mail) link them, and blocking them only
			// cost rendering fidelity. Fixed host, no script risk.
			'content-security-policy':
				"default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https: data:",
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
	// document — to download so it can never run in our origin (stored XSS).
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

/**
 * GET /api/attachments/cid/:hash/:i → stream inline (cid:) image bytes.
 * Sanitized bodies reference attachments by the deterministic R2 layout
 * (`{org}/msg/{hash}/att/{i}`) because attachment row ids don't exist at
 * sanitize time. The org prefix ALWAYS comes from the caller's session — the
 * URL can only ever address objects inside the caller's own mailbox.
 */
export async function handleAttachmentByCid(
	event: RequestEvent,
	hash: string,
	index: string,
): Promise<Response> {
	const { r2, org_id } = ctx(event);
	if (!r2 || !org_id) return DelightError.badRequest('No mailbox').toResponse();
	if (!/^[0-9a-f]{1,64}$/.test(hash) || !/^\d{1,4}$/.test(index)) {
		return DelightError.notFound('Attachment not found').toResponse();
	}
	const obj = await r2.get(`${org_id}/msg/${hash}/att/${index}`);
	if (!obj) return DelightError.notFound('Attachment not found').toResponse();
	// Same stored-XSS containment as handleAttachment: only render safe raster
	// images inline; everything else downloads.
	const mime = (obj.httpMetadata?.contentType ?? 'application/octet-stream').replace(/[\r\n]/g, '');
	const baseType = mime.split(';')[0].trim().toLowerCase();
	const disposition = INLINE_SAFE_TYPES.has(baseType) ? 'inline' : 'attachment';
	return new Response(obj.body, {
		headers: {
			'content-type': mime,
			'content-disposition': contentDisposition(disposition),
			'x-content-type-options': 'nosniff',
			'content-security-policy': "default-src 'none'; sandbox",
			'cache-control': IMMUTABLE,
		},
	});
}

/**
 * GET /api/img?u=<remote url> — an email image from our cache, fetched from the
 * sender (server-side) and stored on first request. See mail/image-cache.ts.
 */
export async function handleImage(event: RequestEvent): Promise<Response> {
	const { r2, kv, org_id } = ctx(event);
	if (!r2 || !kv || !org_id) return DelightError.badRequest('No mailbox').toResponse();
	const url = event.url.searchParams.get('u');
	if (!url || url.length > 4096) return DelightError.badRequest('Missing image URL').toResponse();
	const exec = (event.platform as App.Platform | undefined)?.ctx;
	const image = await getImage(
		{ r2, kv },
		org_id,
		url,
		exec ? (p) => exec.waitUntil(p) : undefined,
	);
	if (!image) {
		return new Response(null, {
			status: 404,
			headers: { 'cache-control': 'private, max-age=3600' },
		});
	}
	return new Response(image.body, {
		headers: {
			'content-type': image.type,
			...(image.size ? { 'content-length': String(image.size) } : {}),
			'x-content-type-options': 'nosniff',
			// SVG can carry script; on a direct visit this keeps it inert.
			'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
			'content-disposition': 'inline',
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

const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024; // 25 MB

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

/**
 * Read a body from R2 and fill the KV cache for next time. The caller has
 * already missed KV. The KV write happens after the response is sent: awaiting
 * it added a KV write round trip to every first open.
 */
async function readStored(
	event: RequestEvent,
	r2: R2Bucket,
	kv: KVNamespace | undefined,
	key: string,
	cacheKey: string,
	transform?: (raw: string) => string,
): Promise<string | null> {
	const obj = await r2.get(key);
	if (!obj) return null;
	// Transform BEFORE caching so KV always holds the servable form (the KV-first
	// fast path returns the cached value verbatim, modulo typeset()).
	const text = transform ? transform(await obj.text()) : await obj.text();
	if (kv) {
		const put = kv
			.put(cacheKey, text, { expirationTtl: BODY_KV_TTL_SECONDS })
			.catch((err) => console.error('[body] KV cache write failed', err));
		const exec = (event.platform as App.Platform | undefined)?.ctx;
		if (exec) exec.waitUntil(put);
		else await put;
	}
	return text;
}

/** A stored plain-text body as minimal servable HTML (escaped, pre-wrapped). */
function textToHtml(text: string): string {
	const escaped = text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
	return `<div style="white-space:pre-wrap">${escaped}</div>`;
}
