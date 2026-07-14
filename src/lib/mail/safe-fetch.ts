/**
 * SSRF-guarded outbound fetch for server-initiated requests to URLs taken from
 * untrusted email content — specifically the List-Unsubscribe one-click POST
 * A sender fully controls that URL, so without guards the worker
 * becomes a request-forgery primitive and a live-address oracle. We require
 * https, refuse private/loopback/link-local targets, never follow redirects
 * (they could retarget an internal host), and bound the request with a timeout.
 *
 * Pure / isomorphic (global fetch + URL) so both the app and server workers can
 * import it. Note: this blocks IP-literal and localhost targets but cannot see
 * through DNS rebinding (a public hostname resolving to a private IP) — Workers
 * fetch does not expose the resolved address.
 */

/** Hostnames / IP literals a server request must never be tricked into hitting. */
export function isBlockedHost(hostname: string): boolean {
	const h = hostname.toLowerCase().replace(/^\[|\]$/g, ''); // strip IPv6 brackets
	if (!h) return true;
	if (h === 'localhost' || h.endsWith('.localhost')) return true;
	if (h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.home.arpa')) return true;

	// IPv6 literal (contains a colon).
	if (h.includes(':')) {
		if (h === '::1' || h === '::') return true; // loopback / unspecified
		if (h.startsWith('fe80')) return true; // link-local
		if (h.startsWith('fc') || h.startsWith('fd')) return true; // unique-local fc00::/7
		if (h.startsWith('::ffff:')) return true; // IPv4-mapped — could embed a private v4
		return false;
	}

	// IPv4 literal → reject private / loopback / link-local / CGNAT / multicast.
	const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
	if (v4) {
		const a = Number(v4[1]);
		const b = Number(v4[2]);
		if (a === 0 || a === 10 || a === 127) return true;
		if (a === 169 && b === 254) return true; // link-local incl. 169.254.169.254 metadata
		if (a === 172 && b >= 16 && b <= 31) return true;
		if (a === 192 && b === 168) return true;
		if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
		if (a >= 224) return true; // multicast / reserved
	}
	return false;
}

/** Validate an untrusted URL for a server-side request: public https only. */
export function validatePublicHttpsUrl(raw: string): { url: URL } | { reason: string } {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return { reason: 'invalid URL' };
	}
	if (url.protocol !== 'https:')
		return { reason: `scheme ${url.protocol} not allowed (https only)` };
	if (isBlockedHost(url.hostname)) return { reason: `host ${url.hostname} is private/internal` };
	return { url };
}

export interface SafeFetchResult {
	ok: boolean;
	status: number;
	/** Set with a reason when the request was refused before ever being sent. */
	blocked?: string;
}

/**
 * POST to an untrusted List-Unsubscribe one-click endpoint safely. Any redirect
 * (3xx) counts as failure so it is never chased to a rewritten target.
 */
export async function safeUnsubscribePost(
	raw: string,
	opts: { timeoutMs?: number } = {},
): Promise<SafeFetchResult> {
	const v = validatePublicHttpsUrl(raw);
	if ('reason' in v) return { ok: false, status: 0, blocked: v.reason };

	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 10_000);
	try {
		const res = await fetch(v.url, {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: 'List-Unsubscribe=One-Click',
			redirect: 'manual',
			signal: ctrl.signal,
		});
		return { ok: res.status >= 200 && res.status < 300, status: res.status };
	} catch {
		return { ok: false, status: 0 };
	} finally {
		clearTimeout(timer);
	}
}
