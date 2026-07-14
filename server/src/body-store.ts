/**
 * R2 body storage. SQLite holds only metadata + an 8KB excerpt; the raw
 * MIME, sanitized HTML, and plain text live in R2 under an org-prefixed,
 * content-addressed key so it is stable before the DB row exists.
 *
 *   {org_id}/msg/{hash}/raw.eml | body.html | body.txt
 *
 * `hash` is a SHA-256 of the rfc822 message-id (URL-safe), so re-delivery
 * overwrites the same objects instead of orphaning them.
 */
export interface BodyKeys {
	raw?: string;
	html?: string;
	text?: string;
}

async function sha256Hex(input: string): Promise<string> {
	const data = new TextEncoder().encode(input);
	const digest = await crypto.subtle.digest('SHA-256', data);
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function messagePrefix(org_id: string, rfc822_message_id: string): Promise<string> {
	const hash = (await sha256Hex(rfc822_message_id)).slice(0, 40);
	return `${org_id}/msg/${hash}`;
}

export async function writeBodies(
	r2: R2Bucket,
	prefix: string,
	bodies: { raw?: string | ArrayBuffer | Uint8Array; html?: string; text?: string },
): Promise<BodyKeys> {
	const keys: BodyKeys = {};
	const ops: Promise<unknown>[] = [];

	if (bodies.raw !== undefined) {
		keys.raw = `${prefix}/raw.eml`;
		ops.push(
			r2.put(keys.raw, bodies.raw as ArrayBuffer, {
				httpMetadata: { contentType: 'message/rfc822' },
			}),
		);
	}
	if (bodies.html !== undefined) {
		keys.html = `${prefix}/body.html`;
		ops.push(
			r2.put(keys.html, bodies.html, {
				httpMetadata: { contentType: 'text/html; charset=utf-8' },
			}),
		);
	}
	if (bodies.text !== undefined) {
		keys.text = `${prefix}/body.txt`;
		ops.push(
			r2.put(keys.text, bodies.text, {
				httpMetadata: { contentType: 'text/plain; charset=utf-8' },
			}),
		);
	}

	await Promise.all(ops);
	return keys;
}

export interface StoredAttachment {
	filename: string;
	mime_type: string;
	size_bytes: number;
	content_id?: string;
	r2_key: string;
}

/**
 * Write attachment bytes to R2 under the message's org-prefixed prefix
 * (`{org}/msg/{hash}/att/{i}`), stable on re-delivery. Returns the metadata rows
 * ingest turns into `attachment` records.
 */
export async function writeAttachments(
	r2: R2Bucket,
	prefix: string,
	attachments: Array<{
		filename: string;
		mime_type: string;
		content: ArrayBuffer | Uint8Array | string;
		content_id?: string;
		size_bytes: number;
	}>,
): Promise<StoredAttachment[]> {
	const out: StoredAttachment[] = [];
	const ops: Promise<unknown>[] = [];
	attachments.forEach((a, i) => {
		const r2_key = `${prefix}/att/${i}`;
		ops.push(
			r2.put(r2_key, a.content as ArrayBuffer, { httpMetadata: { contentType: a.mime_type } }),
		);
		out.push({
			filename: a.filename,
			mime_type: a.mime_type,
			size_bytes: a.size_bytes,
			content_id: a.content_id,
			r2_key,
		});
	});
	await Promise.all(ops);
	return out;
}

/** Read a stored body, KV-cached (7d) on the hot path. */
export async function readBody(
	r2: R2Bucket,
	kv: KVNamespace | undefined,
	key: string,
	cacheKey?: string,
): Promise<string | null> {
	if (kv && cacheKey) {
		const cached = await kv.get(cacheKey);
		if (cached !== null) return cached;
	}
	const obj = await r2.get(key);
	if (!obj) return null;
	const text = await obj.text();
	if (kv && cacheKey) {
		await kv.put(cacheKey, text, { expirationTtl: 60 * 60 * 24 * 7 });
	}
	return text;
}
