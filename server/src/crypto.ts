/**
 * AES-GCM encryption for stored mail credentials. The key is the 32-byte
 * hex `CREDENTIALS_ENCRYPTION_KEY` env secret. Ciphertext is stored as
 * base64(iv[12] || ciphertext) so a single string round-trips through SQLite.
 */

function hexToBytes(hex: string): Uint8Array {
	const clean = hex.trim().replace(/^0x/, '');
	const out = new Uint8Array(clean.length / 2);
	for (let i = 0; i < out.length; i++) {
		out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
	}
	return out;
}

async function importKey(keyHex: string | undefined): Promise<CryptoKey> {
	// Must be EXACTLY 64 hex chars = 32 bytes = AES-256. The old check counted
	// characters (`length < 32`), so a 32-char key silently became AES-128, and a
	// non-hex passphrase parsed to mostly-zero bytes (parseInt → NaN → 0) — either
	// way, stored credentials would be protected by far less entropy than intended.
	if (!keyHex || !/^[0-9a-f]{64}$/i.test(keyHex.trim().replace(/^0x/, ''))) {
		throw new Error(
			'CREDENTIALS_ENCRYPTION_KEY must be a 64-char hex string (32 bytes). ' +
				'Generate one with: openssl rand -hex 32',
		);
	}
	const raw = hexToBytes(keyHex);
	return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

function toBase64(bytes: Uint8Array): string {
	let bin = '';
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin);
}

function fromBase64(b64: string): Uint8Array {
	const bin = atob(b64);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

export async function encryptSecret(
	plaintext: string,
	keyHex: string | undefined,
): Promise<string> {
	const key = await importKey(keyHex);
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const data = new TextEncoder().encode(plaintext);
	const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data));
	const combined = new Uint8Array(iv.length + ct.length);
	combined.set(iv, 0);
	combined.set(ct, iv.length);
	return toBase64(combined);
}

export async function decryptSecret(
	ciphertext: string,
	keyHex: string | undefined,
): Promise<string | null> {
	try {
		const key = await importKey(keyHex);
		const combined = fromBase64(ciphertext);
		const iv = combined.slice(0, 12);
		const ct = combined.slice(12);
		const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
		return new TextDecoder().decode(pt);
	} catch (err) {
		console.error('[crypto] decrypt failed:', err);
		return null;
	}
}
