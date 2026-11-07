/**
 * Our own copy of the remote images in email.
 *
 * Every remote image a body references is fetched by the server — never by the
 * reader's browser — and kept in R2, so opening an email touches no third-party
 * host at all: senders can't see when (or whether, or from where) you read it,
 * and images load from Cloudflare instead of whatever slow host the sender used.
 *
 * Storage is content-addressed and deduplicated per org:
 *
 *   KV  img:{org}:{sha256(url)}   →  { h: sha256(bytes), t: content-type }
 *   R2  img/{org}/{sha256(bytes)}  →  the bytes
 *
 * so the same logo sent in a thousand newsletters (each with its own tracking
 * URL) is stored once. Nothing is reference-counted: deleting an email never
 * deletes images. Instead every object expires — an R2 lifecycle rule on the
 * `img/` prefix removes objects a year after they were written, and the URL
 * pointers carry the same TTL in KV. An image that has expired is simply fetched
 * from the sender again the next time a body needs it and cached afresh.
 *
 * The org is part of every key, so one tenant's cache can never answer for
 * another's — sharing bytes across orgs would let one user probe whether another
 * received an image.
 *
 * Isomorphic: imported by the app worker (serving `/api/img`) and the server
 * worker (caching images when mail arrives).
 */
import { validatePublicHttpsUrl } from './safe-fetch';

/** Per-image byte cap. Larger images are not stored (and not served). */
export const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
/** At most this many images are cached per message at ingest. */
export const IMAGES_PER_MESSAGE = 40;
/** Pointer + object lifetime. Matches the R2 lifecycle rule on `img/`. */
export const IMAGE_TTL_SECONDS = 60 * 60 * 24 * 365;
/** A URL that failed is not retried for this long. */
const FAILURE_TTL_SECONDS = 60 * 60 * 6;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 4;

export interface ImageStores {
	r2: R2Bucket;
	kv: KVNamespace;
}

interface Pointer {
	/** sha256 of the bytes; absent for a remembered failure */
	h?: string;
	/** content type */
	t?: string;
	/** remembered failure */
	e?: 1;
}

export interface CachedImage {
	body: ReadableStream | ArrayBuffer;
	type: string;
	size?: number;
}

// ---------------------------------------------------------------------------
// URLs in bodies
// ---------------------------------------------------------------------------

/** The proxy path a body uses in place of a remote image URL. */
export function proxiedImageUrl(url: string): string {
	return `/api/img?u=${encodeURIComponent(url)}`;
}

const IMG_SRC = /(<img\b[^>]*?\ssrc=")(https?:\/\/[^"]+)(")/gi;
// url(...) in style attributes and <style> blocks. Quotes inside an attribute
// arrive as &quot;.
const CSS_URL = /url\(\s*(&quot;|"|'|)(https?:\/\/[^"')]+?)\1\s*\)/gi;
// The legacy `background="…"` attribute on table cells.
const BG_ATTR = /(\sbackground=")(https?:\/\/[^"]+)(")/gi;

/** HTML attribute text → the URL it encodes (sanitized output escapes `&`). */
function decodeAttr(value: string): string {
	return value
		.replaceAll('&amp;', '&')
		.replaceAll('&quot;', '"')
		.replaceAll('&#x27;', "'")
		.replaceAll('&#39;', "'");
}

/** Remote images are always fetched over https; plain http is upgraded. */
function normalize(url: string): string {
	return url.startsWith('http://') ? `https://${url.slice('http://'.length)}` : url;
}

/** Every remote image URL in a sanitized body, deduplicated, in document order. */
export function extractImageUrls(html: string): string[] {
	const out = new Set<string>();
	for (const re of [IMG_SRC, BG_ATTR]) {
		for (const m of html.matchAll(re)) out.add(normalize(decodeAttr(m[2])));
	}
	for (const m of html.matchAll(CSS_URL)) out.add(normalize(decodeAttr(m[2])));
	return [...out];
}

/**
 * Point every remote image in a body at our proxy. Done when the body is served
 * (not stored), so it reaches mail stored before this existed.
 */
export function rewriteImageUrls(html: string): string {
	const proxied = (raw: string) => proxiedImageUrl(normalize(decodeAttr(raw)));
	return html
		.replace(IMG_SRC, (_m, pre: string, url: string, post: string) => pre + proxied(url) + post)
		.replace(BG_ATTR, (_m, pre: string, url: string, post: string) => pre + proxied(url) + post)
		.replace(CSS_URL, (_m, _q: string, url: string) => `url(${proxied(url)})`);
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

async function sha256Hex(data: Uint8Array<ArrayBuffer> | string): Promise<string> {
	const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
	const digest = await crypto.subtle.digest('SHA-256', bytes);
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const pointerKey = (org_id: string, url_hash: string) => `img:${org_id}:${url_hash}`;
export const imageObjectKey = (org_id: string, content_hash: string) =>
	`img/${org_id}/${content_hash}`;

/**
 * Serve an image from the cache, fetching and storing it first if we don't
 * have it. `null` when the image can't be had (blocked URL, remote error,
 * not an image, too big) — remembered for a few hours so a dead tracking URL
 * isn't refetched on every open.
 */
export async function getImage(
	stores: ImageStores,
	org_id: string,
	url: string,
	waitUntil?: (p: Promise<unknown>) => void,
): Promise<CachedImage | null> {
	const url_hash = await sha256Hex(url);
	const key = pointerKey(org_id, url_hash);
	const pointer = await stores.kv.get<Pointer>(key, { type: 'json', cacheTtl: 60 * 60 * 24 });
	if (pointer?.e) return null;
	if (pointer?.h) {
		const obj = await stores.r2.get(imageObjectKey(org_id, pointer.h));
		if (obj) {
			return {
				body: obj.body,
				type: obj.httpMetadata?.contentType ?? pointer.t ?? 'application/octet-stream',
				size: obj.size,
			};
		}
		// Expired from R2 by the lifecycle rule — fall through and fetch it again.
	}
	const fetched = await fetchRemoteImage(url);
	if (!fetched) {
		const remember = stores.kv
			.put(key, JSON.stringify({ e: 1 } satisfies Pointer), {
				expirationTtl: FAILURE_TTL_SECONDS,
			})
			.catch(() => {});
		if (waitUntil) waitUntil(remember);
		else await remember;
		return null;
	}
	const store = storeImage(stores, org_id, key, fetched);
	if (waitUntil) waitUntil(store);
	else await store;
	return { body: fetched.bytes.buffer, type: fetched.type, size: fetched.bytes.byteLength };
}

/**
 * Fetch and store each image unless it is already cached. Used when mail
 * arrives, so the first open is already local. Bounded concurrency; failures
 * are recorded and otherwise ignored.
 */
export async function cacheImages(
	stores: ImageStores,
	org_id: string,
	urls: string[],
	concurrency = 4,
): Promise<{ cached: number; skipped: number; failed: number }> {
	const result = { cached: 0, skipped: 0, failed: 0 };
	const queue = urls.slice(0, IMAGES_PER_MESSAGE);
	const worker = async () => {
		for (let url = queue.shift(); url !== undefined; url = queue.shift()) {
			try {
				const key = pointerKey(org_id, await sha256Hex(url));
				const pointer = await stores.kv.get<Pointer>(key, { type: 'json' });
				if (
					pointer?.e ||
					(pointer?.h && (await stores.r2.head(imageObjectKey(org_id, pointer.h))))
				) {
					result.skipped++;
					continue;
				}
				const fetched = await fetchRemoteImage(url);
				if (!fetched) {
					await stores.kv.put(key, JSON.stringify({ e: 1 } satisfies Pointer), {
						expirationTtl: FAILURE_TTL_SECONDS,
					});
					result.failed++;
					continue;
				}
				await storeImage(stores, org_id, key, fetched);
				result.cached++;
			} catch (err) {
				console.error('[img] cache failed', url, err);
				result.failed++;
			}
		}
	};
	await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
	return result;
}

async function storeImage(
	stores: ImageStores,
	org_id: string,
	pointer_key: string,
	image: { bytes: Uint8Array<ArrayBuffer>; type: string },
): Promise<void> {
	const content_hash = await sha256Hex(image.bytes);
	const object_key = imageObjectKey(org_id, content_hash);
	// Deduplication: a logo shared by many emails is written once. A HEAD is
	// cheaper than rewriting the object.
	if (!(await stores.r2.head(object_key))) {
		await stores.r2.put(object_key, image.bytes, { httpMetadata: { contentType: image.type } });
	}
	await stores.kv.put(
		pointer_key,
		JSON.stringify({ h: content_hash, t: image.type } satisfies Pointer),
		{ expirationTtl: IMAGE_TTL_SECONDS },
	);
}

// ---------------------------------------------------------------------------
// Remote fetch
// ---------------------------------------------------------------------------

/** Image types we store and serve. SVG is allowed: it's served with a sandbox CSP. */
const IMAGE_TYPES = /^image\/(png|jpe?g|gif|webp|avif|bmp|svg\+xml|x-icon|vnd\.microsoft\.icon)$/;

/** Recognise an image by its first bytes when the server sends a generic type. */
function sniffImageType(bytes: Uint8Array): string | null {
	const b = bytes;
	if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
	if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
	if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
	if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57) {
		return 'image/webp';
	}
	return null;
}

/**
 * Fetch one untrusted image URL. Public https hosts only, every redirect hop
 * re-validated, a hard timeout, and a byte cap enforced while streaming — a
 * sender must not be able to make us store a huge file or reach an internal host.
 */
export async function fetchRemoteImage(
	raw: string,
): Promise<{ bytes: Uint8Array<ArrayBuffer>; type: string } | null> {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
	try {
		let target = raw;
		for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
			const v = validatePublicHttpsUrl(target);
			if ('reason' in v) return null;
			const res = await fetch(v.url.toString(), {
				redirect: 'manual',
				signal: ctrl.signal,
				headers: {
					accept: 'image/avif,image/webp,image/png,image/*;q=0.8',
					'user-agent': 'Mozilla/5.0 (compatible; DelightMailImageProxy/1.0)',
				},
			});
			if (res.status >= 300 && res.status < 400) {
				const location = res.headers.get('location');
				await res.body?.cancel();
				if (!location) return null;
				target = normalize(new URL(location, v.url).toString());
				continue;
			}
			if (!res.ok || !res.body) {
				await res.body?.cancel();
				return null;
			}
			const declared = Number(res.headers.get('content-length') ?? 0);
			if (declared > IMAGE_MAX_BYTES) {
				await res.body.cancel();
				return null;
			}
			const bytes = await readCapped(res.body, IMAGE_MAX_BYTES);
			if (!bytes || bytes.byteLength === 0) return null;
			const header_type = (res.headers.get('content-type') ?? '')
				.split(';')[0]
				.trim()
				.toLowerCase();
			const type = IMAGE_TYPES.test(header_type) ? header_type : sniffImageType(bytes);
			if (!type) return null;
			return { bytes, type };
		}
		return null;
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

async function readCapped(
	body: ReadableStream<Uint8Array>,
	max: number,
): Promise<Uint8Array<ArrayBuffer> | null> {
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > max) {
			await reader.cancel();
			return null;
		}
		chunks.push(value);
	}
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out;
}
