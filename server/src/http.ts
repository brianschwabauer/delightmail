/**
 * fetch with a bounded timeout. Every server-initiated request must
 * time out, otherwise a hung or slow upstream ties up the calling Durable Object
 * alarm for the full Workers subrequest wall-clock. On timeout the request is
 * aborted and fetch rejects (AbortError), so callers' existing retry/error
 * handling applies unchanged.
 */
const DEFAULT_TIMEOUT_MS = 15_000;

export async function fetchWithTimeout(
	input: string | URL | Request,
	init: RequestInit = {},
	timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), timeoutMs);
	try {
		return await fetch(input, { ...init, signal: ctrl.signal });
	} finally {
		clearTimeout(timer);
	}
}
