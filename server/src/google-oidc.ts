/**
 * Verify a Google-signed OIDC JWT (used for Pub/Sub push auth, §5.1, §12).
 * Fetches Google's public JWKS, verifies the RS256 signature, and checks
 * issuer / audience / service-account email. JWKS is cached in module memory
 * for the isolate's lifetime.
 */
import { fetchWithTimeout } from './http';

const GOOGLE_CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const VALID_ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);

interface Jwk {
	kid: string;
	n: string;
	e: string;
	alg?: string;
	kty: string;
}

let jwksCache: { keys: Jwk[]; fetchedAt: number } | null = null;
const JWKS_TTL_MS = 60 * 60 * 1000;

export interface OidcResult {
	ok: boolean;
	reason?: string;
	claims?: Record<string, unknown>;
}

export async function verifyGoogleOidc(
	token: string,
	opts: { audience?: string; serviceAccount?: string },
): Promise<OidcResult> {
	const parts = token.split('.');
	if (parts.length !== 3) return { ok: false, reason: 'malformed' };

	const [headerB64, payloadB64, sigB64] = parts;
	let header: { kid?: string; alg?: string };
	let claims: Record<string, unknown>;
	try {
		header = JSON.parse(b64urlToString(headerB64));
		claims = JSON.parse(b64urlToString(payloadB64));
	} catch {
		return { ok: false, reason: 'unparseable' };
	}

	if (header.alg !== 'RS256') return { ok: false, reason: 'alg' };
	if (!VALID_ISSUERS.has(String(claims.iss))) return { ok: false, reason: 'issuer' };
	if (opts.audience && claims.aud !== opts.audience) return { ok: false, reason: 'audience' };
	if (opts.serviceAccount && claims.email !== opts.serviceAccount) {
		return { ok: false, reason: 'service-account' };
	}
	if (typeof claims.exp === 'number' && claims.exp * 1000 < Date.now()) {
		return { ok: false, reason: 'expired' };
	}

	const jwk = await findKey(header.kid);
	if (!jwk) return { ok: false, reason: 'unknown-key' };

	const key = await crypto.subtle.importKey(
		'jwk',
		{ kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
		{ name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
		false,
		['verify'],
	);
	const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
	const sig = b64urlToBytes(sigB64);
	const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, sig, data);
	if (!valid) return { ok: false, reason: 'signature' };

	return { ok: true, claims };
}

async function findKey(kid: string | undefined): Promise<Jwk | undefined> {
	if (!kid) return undefined;
	if (!jwksCache || Date.now() - jwksCache.fetchedAt > JWKS_TTL_MS) {
		const res = await fetchWithTimeout(GOOGLE_CERTS_URL);
		const body = (await res.json()) as { keys: Jwk[] };
		jwksCache = { keys: body.keys, fetchedAt: Date.now() };
	}
	return jwksCache.keys.find((k) => k.kid === kid);
}

function b64urlToString(b64url: string): string {
	return new TextDecoder().decode(b64urlToBytes(b64url));
}

function b64urlToBytes(b64url: string): Uint8Array {
	const b64 = b64url
		.replace(/-/g, '+')
		.replace(/_/g, '/')
		.padEnd(b64url.length + ((4 - (b64url.length % 4)) % 4), '=');
	const bin = atob(b64);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}
