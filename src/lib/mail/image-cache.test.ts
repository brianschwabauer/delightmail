import { describe, it, expect, vi, afterEach } from 'vitest';
import {
	cacheImages,
	extractImageUrls,
	fetchRemoteImage,
	getImage,
	IMAGE_MAX_BYTES,
	imageObjectKey,
	rewriteImageUrls,
} from './image-cache';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

function imageResponse(bytes: Uint8Array<ArrayBuffer>, type = 'image/png', status = 200): Response {
	return new Response(bytes, { status, headers: { 'content-type': type } });
}

/** In-memory R2 + KV, just enough for the cache. */
function fakeStores() {
	const objects = new Map<string, { bytes: Uint8Array; type?: string }>();
	const kv = new Map<string, string>();
	const r2 = {
		async head(key: string) {
			return objects.has(key) ? { key } : null;
		},
		async get(key: string) {
			const o = objects.get(key);
			if (!o) return null;
			return { body: o.bytes, size: o.bytes.byteLength, httpMetadata: { contentType: o.type } };
		},
		async put(key: string, bytes: Uint8Array, opts?: { httpMetadata?: { contentType?: string } }) {
			objects.set(key, { bytes, type: opts?.httpMetadata?.contentType });
		},
	};
	const kvns = {
		async get(key: string, opts?: { type?: string }) {
			const v = kv.get(key);
			if (v === undefined) return null;
			return opts?.type === 'json' ? JSON.parse(v) : v;
		},
		async put(key: string, value: string) {
			kv.set(key, value);
		},
	};
	return {
		objects,
		kv,
		stores: { r2: r2 as unknown as R2Bucket, kv: kvns as unknown as KVNamespace },
	};
}

afterEach(() => vi.unstubAllGlobals());

describe('extractImageUrls / rewriteImageUrls', () => {
	const html =
		'<img alt="logo" src="https://cdn.example.com/a.png?x=1&amp;y=2">' +
		'<td background="http://cdn.example.com/bg.jpg"></td>' +
		'<div style="background-image:url(&quot;https://cdn.example.com/c.gif&quot;)"></div>' +
		'<style>.h{background:url(https://cdn.example.com/d.webp)}</style>' +
		'<img src="/api/attachments/cid/abc/0">' +
		'<img src="data:image/png;base64,AAAA">';

	it('finds every remote image, decoded and upgraded to https', () => {
		expect(extractImageUrls(html)).toEqual([
			'https://cdn.example.com/a.png?x=1&y=2',
			'https://cdn.example.com/bg.jpg',
			'https://cdn.example.com/c.gif',
			'https://cdn.example.com/d.webp',
		]);
	});

	it('points every remote image at the proxy and leaves local ones alone', () => {
		const out = rewriteImageUrls(html);
		expect(out).not.toMatch(/https?:\/\/cdn\.example\.com/);
		expect(out).toContain(
			`src="/api/img?u=${encodeURIComponent('https://cdn.example.com/a.png?x=1&y=2')}"`,
		);
		expect(out).toContain(
			`background="/api/img?u=${encodeURIComponent('https://cdn.example.com/bg.jpg')}"`,
		);
		expect(out).toContain(`url(/api/img?u=${encodeURIComponent('https://cdn.example.com/c.gif')})`);
		expect(out).toContain(
			`url(/api/img?u=${encodeURIComponent('https://cdn.example.com/d.webp')})`,
		);
		expect(out).toContain('src="/api/attachments/cid/abc/0"');
		expect(out).toContain('src="data:image/png;base64,AAAA"');
	});

	it('does not touch links, only images', () => {
		const link = '<a href="https://example.com/x.png">x</a>';
		expect(rewriteImageUrls(link)).toBe(link);
	});
});

describe('fetchRemoteImage', () => {
	it('refuses private hosts and plain http without fetching', async () => {
		const fetch = vi.fn();
		vi.stubGlobal('fetch', fetch);
		expect(await fetchRemoteImage('https://169.254.169.254/latest/meta-data')).toBeNull();
		expect(await fetchRemoteImage('https://localhost/a.png')).toBeNull();
		expect(await fetchRemoteImage('http://cdn.example.com/a.png')).toBeNull();
		expect(fetch).not.toHaveBeenCalled();
	});

	it('re-validates every redirect hop', async () => {
		const fetch = vi.fn(
			async () =>
				new Response(null, { status: 302, headers: { location: 'https://10.0.0.5/a.png' } }),
		);
		vi.stubGlobal('fetch', fetch);
		expect(await fetchRemoteImage('https://cdn.example.com/a.png')).toBeNull();
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it('follows a public redirect', async () => {
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(null, { status: 301, headers: { location: '/real.png' } }),
			)
			.mockResolvedValueOnce(imageResponse(PNG));
		vi.stubGlobal('fetch', fetch);
		const got = await fetchRemoteImage('https://cdn.example.com/a.png');
		expect(got?.type).toBe('image/png');
		expect(fetch.mock.calls[1][0]).toBe('https://cdn.example.com/real.png');
	});

	it('rejects images over the size cap, by header or while streaming', async () => {
		const big = new Uint8Array(IMAGE_MAX_BYTES + 1);
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => imageResponse(big)),
		);
		expect(await fetchRemoteImage('https://cdn.example.com/huge.png')).toBeNull();

		const declared = new Response(PNG, {
			headers: { 'content-type': 'image/png', 'content-length': String(IMAGE_MAX_BYTES * 2) },
		});
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => declared),
		);
		expect(await fetchRemoteImage('https://cdn.example.com/liar.png')).toBeNull();
	});

	it('rejects non-images, but sniffs images sent as a generic type', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => imageResponse(new TextEncoder().encode('<html>'), 'text/html')),
		);
		expect(await fetchRemoteImage('https://cdn.example.com/page')).toBeNull();

		vi.stubGlobal(
			'fetch',
			vi.fn(async () => imageResponse(PNG, 'application/octet-stream')),
		);
		expect((await fetchRemoteImage('https://cdn.example.com/blob'))?.type).toBe('image/png');
	});
});

describe('getImage / cacheImages', () => {
	it('fetches once, then serves from the cache', async () => {
		const { stores } = fakeStores();
		const fetch = vi.fn(async () => imageResponse(PNG));
		vi.stubGlobal('fetch', fetch);
		expect((await getImage(stores, 'org1', 'https://cdn.example.com/a.png'))?.type).toBe(
			'image/png',
		);
		expect((await getImage(stores, 'org1', 'https://cdn.example.com/a.png'))?.type).toBe(
			'image/png',
		);
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it('stores identical images once, whatever URL they came from', async () => {
		const { stores, objects } = fakeStores();
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => imageResponse(PNG)),
		);
		await cacheImages(stores, 'org1', [
			'https://cdn.example.com/logo.png?u=alice',
			'https://cdn.example.com/logo.png?u=bob',
		]);
		expect([...objects.keys()]).toHaveLength(1);
		expect([...objects.keys()][0]).toMatch(/^img\/org1\/[0-9a-f]{64}$/);
	});

	it('keeps each org separate', async () => {
		const { stores, objects } = fakeStores();
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => imageResponse(PNG)),
		);
		await cacheImages(stores, 'org1', ['https://cdn.example.com/logo.png']);
		await cacheImages(stores, 'org2', ['https://cdn.example.com/logo.png']);
		expect([...objects.keys()].map((k) => k.split('/')[1]).sort()).toEqual(['org1', 'org2']);
	});

	it('remembers a failure instead of refetching it on every open', async () => {
		const { stores } = fakeStores();
		const fetch = vi.fn(async () => new Response('nope', { status: 404 }));
		vi.stubGlobal('fetch', fetch);
		expect(await getImage(stores, 'org1', 'https://cdn.example.com/gone.png')).toBeNull();
		expect(await getImage(stores, 'org1', 'https://cdn.example.com/gone.png')).toBeNull();
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it('refetches an image whose stored copy has expired', async () => {
		const { stores, objects } = fakeStores();
		const fetch = vi.fn(async () => imageResponse(PNG));
		vi.stubGlobal('fetch', fetch);
		await getImage(stores, 'org1', 'https://cdn.example.com/a.png');
		objects.clear(); // the R2 lifecycle rule removed it
		expect((await getImage(stores, 'org1', 'https://cdn.example.com/a.png'))?.type).toBe(
			'image/png',
		);
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(objects.size).toBe(1);
	});

	it('names objects under the img/ prefix the lifecycle rule targets', () => {
		expect(imageObjectKey('org1', 'abc')).toBe('img/org1/abc');
	});
});
