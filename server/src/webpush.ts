/**
 * Workers-compatible Web Push (RFC 8291 aes128gcm payload encryption + RFC 8292
 * VAPID) using only Web Crypto (§10.4). Used by MailboxServer to notify devices
 * of important new mail. Requires VAPID keys; push is skipped when absent.
 *
 * Not unit-tested here (needs a live push service + VAPID keypair); implemented
 * to the spec. Verify against a real endpoint before relying on it in production.
 */
import { fetchWithTimeout } from './http';

export interface PushSub {
	endpoint: string;
	keys: { p256dh: string; auth: string };
}
export interface VapidKeys {
	publicKey: string; // base64url, uncompressed P-256 point (65 bytes)
	privateKey: string; // base64url, raw d (32 bytes)
	subject: string; // mailto:you@example.com
}

export async function sendWebPush(
	sub: PushSub,
	payload: string,
	vapid: VapidKeys,
	ttl = 2419200,
): Promise<Response> {
	const endpoint = new URL(sub.endpoint);
	const audience = `${endpoint.protocol}//${endpoint.host}`;

	const [jwt, encrypted] = await Promise.all([
		vapidJwt(audience, vapid),
		encryptPayload(payload, sub.keys.p256dh, sub.keys.auth),
	]);

	return fetchWithTimeout(sub.endpoint, {
		method: 'POST',
		headers: {
			TTL: String(ttl),
			'Content-Encoding': 'aes128gcm',
			'Content-Type': 'application/octet-stream',
			Authorization: `vapid t=${jwt}, k=${vapid.publicKey}`,
		},
		body: encrypted,
	});
}

// --- VAPID JWT (ES256) ---
async function vapidJwt(audience: string, vapid: VapidKeys): Promise<string> {
	const header = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
	const claims = b64url(
		JSON.stringify({
			aud: audience,
			exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
			sub: vapid.subject,
		}),
	);
	const unsigned = `${header}.${claims}`;
	const key = await importVapidPrivateKey(vapid.privateKey, vapid.publicKey);
	const sig = await crypto.subtle.sign(
		{ name: 'ECDSA', hash: 'SHA-256' },
		key,
		new TextEncoder().encode(unsigned),
	);
	return `${unsigned}.${b64urlBytes(new Uint8Array(sig))}`;
}

async function importVapidPrivateKey(privateKey: string, publicKey: string): Promise<CryptoKey> {
	const d = fromB64url(privateKey);
	const pub = fromB64url(publicKey); // 65 bytes: 0x04 || x(32) || y(32)
	const jwk: JsonWebKey = {
		kty: 'EC',
		crv: 'P-256',
		d: b64urlBytes(d),
		x: b64urlBytes(pub.slice(1, 33)),
		y: b64urlBytes(pub.slice(33, 65)),
		ext: true,
	};
	return crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, [
		'sign',
	]);
}

// --- Payload encryption (RFC 8291, aes128gcm) ---
async function encryptPayload(
	payload: string,
	p256dhB64: string,
	authB64: string,
): Promise<Uint8Array> {
	const clientPublic = fromB64url(p256dhB64); // 65 bytes
	const authSecret = fromB64url(authB64); // 16 bytes
	const plaintext = new TextEncoder().encode(payload);

	// Ephemeral (server) ECDH keypair. (workers-types doesn't narrow the union.)
	const localKeys = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
		'deriveBits',
	])) as CryptoKeyPair;
	const localPublicRaw = new Uint8Array(
		(await crypto.subtle.exportKey('raw', localKeys.publicKey)) as ArrayBuffer,
	);

	const clientKey = await crypto.subtle.importKey(
		'raw',
		clientPublic,
		{ name: 'ECDH', namedCurve: 'P-256' },
		false,
		[],
	);
	const sharedSecret = new Uint8Array(
		await crypto.subtle.deriveBits(
			{ name: 'ECDH', public: clientKey } as never,
			localKeys.privateKey,
			256,
		),
	);

	// PRK = HKDF(auth, sharedSecret, "WebPush: info" || clientPub || serverPub, 32)
	const ikm = await hkdf(
		authSecret,
		sharedSecret,
		concat(new TextEncoder().encode('WebPush: info\0'), clientPublic, localPublicRaw),
		32,
	);

	const salt = crypto.getRandomValues(new Uint8Array(16));
	const cek = await hkdf(salt, ikm, new TextEncoder().encode('Content-Encoding: aes128gcm\0'), 16);
	const nonce = await hkdf(salt, ikm, new TextEncoder().encode('Content-Encoding: nonce\0'), 12);

	const aesKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
	// Append the 0x02 padding delimiter (single record).
	const padded = concat(plaintext, new Uint8Array([2]));
	const ciphertext = new Uint8Array(
		await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, padded),
	);

	// aes128gcm header: salt(16) || rs(4, big-endian) || idlen(1) || keyid(serverPub)
	const rs = 4096;
	const header = new Uint8Array(16 + 4 + 1 + localPublicRaw.length);
	header.set(salt, 0);
	new DataView(header.buffer).setUint32(16, rs, false);
	header[20] = localPublicRaw.length;
	header.set(localPublicRaw, 21);

	return concat(header, ciphertext);
}

async function hkdf(
	salt: Uint8Array,
	ikm: Uint8Array,
	info: Uint8Array,
	length: number,
): Promise<Uint8Array> {
	const key = await crypto.subtle.importKey('raw', ikm, { name: 'HKDF' }, false, ['deriveBits']);
	const bits = await crypto.subtle.deriveBits(
		{ name: 'HKDF', hash: 'SHA-256', salt, info },
		key,
		length * 8,
	);
	return new Uint8Array(bits);
}

// --- base64url helpers ---
function b64url(s: string): string {
	return b64urlBytes(new TextEncoder().encode(s));
}
function b64urlBytes(bytes: Uint8Array): string {
	let bin = '';
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromB64url(s: string): Uint8Array {
	const b64 = s
		.replace(/-/g, '+')
		.replace(/_/g, '/')
		.padEnd(s.length + ((4 - (s.length % 4)) % 4), '=');
	const bin = atob(b64);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}
function concat(...arrays: Uint8Array[]): Uint8Array {
	const total = arrays.reduce((n, a) => n + a.length, 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const a of arrays) {
		out.set(a, offset);
		offset += a.length;
	}
	return out;
}
