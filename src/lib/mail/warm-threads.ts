/**
 * Threads kept ready to show instantly. The list's neighbours (and anything the
 * cursor lands on) are "warmed": their message rows and the served HTML of the
 * message that opens expanded are held in memory, so switching to one renders
 * synchronously — no worker query, no body request, no iframe navigation —
 * within a frame or two instead of ~100ms+.
 *
 * Both maps are small LRUs; the device cache (service worker + background
 * downloader) remains the durable layer underneath, so warming a thread is
 * usually a local cache read.
 */
import type { MailDatabaseClient } from '$lib/clients';
import type { Message } from '$lib/schema';
import { bodyUrl } from './body-url';

const MAX_THREADS = 60;
const MAX_BODIES = 60;

const threads = new Map<string, Message[]>();
const bodies = new Map<string, string>();
const inflight = new Map<string, Promise<void>>();

function remember<V>(map: Map<string, V>, key: string, value: V, max: number) {
	map.delete(key);
	map.set(key, value);
	if (map.size > max) map.delete(map.keys().next().value!);
}

/** The thread's messages, oldest first, if warmed. */
export function warmMessages(thread_id: string): Message[] | undefined {
	return threads.get(thread_id);
}

/** Record a thread's messages (the reader calls this whenever it loads one). */
export function rememberMessages(thread_id: string, messages: Message[]): void {
	if (messages.length) remember(threads, thread_id, messages, MAX_THREADS);
}

/** The served body HTML for a body URL, if warmed. */
export function warmBody(url: string): string | undefined {
	return bodies.get(url);
}

/** Ready to render with no async work: messages and the expanded body are in memory. */
export function isWarm(thread_id: string, scheme: 'light' | 'dark'): boolean {
	const messages = threads.get(thread_id);
	const latest = messages?.at(-1);
	return !!latest && bodies.has(bodyUrl(String(latest.id), scheme));
}

/**
 * Load a thread's messages and the body of the message that opens expanded
 * (the latest), into memory. Safe to call repeatedly; concurrent calls share
 * one load. Failures are silent — the reader falls back to its normal path.
 */
export function warmThread(
	db: MailDatabaseClient,
	thread_id: string,
	scheme: 'light' | 'dark',
): Promise<void> {
	if (isWarm(thread_id, scheme)) return Promise.resolve();
	const key = `${thread_id}:${scheme}`;
	const pending = inflight.get(key);
	if (pending) return pending;
	const run = (async () => {
		try {
			let messages = threads.get(thread_id);
			if (!messages) {
				const res = await db
					.list('message', {
						where: { thread_id },
						order: [{ field: 'date', direction: 'ASC' }],
						limit: 200,
					})
					.load();
				messages = (res.items ?? []) as Message[];
				rememberMessages(thread_id, messages);
			}
			const latest = messages.at(-1);
			if (!latest) return;
			const url = bodyUrl(String(latest.id), scheme);
			if (bodies.has(url)) return;
			// Usually a service-worker cache hit (the background downloader got
			// there first); otherwise a normal fetch that also fills that cache.
			const res = await fetch(url, { credentials: 'same-origin' });
			if (!res.ok) return;
			// An error body is JSON; leave those to the reader's own fallback.
			if (!(res.headers.get('content-type') ?? '').startsWith('text/html')) return;
			remember(bodies, url, await res.text(), MAX_BODIES);
		} catch {
			/* best effort */
		} finally {
			inflight.delete(key);
		}
	})();
	inflight.set(key, run);
	return run;
}
