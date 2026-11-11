/**
 * Keeps recent mail readable instantly, and offline: downloads the bodies of
 * recent conversations into the same Cache Storage the service worker serves
 * them from, so opening one is a local read (~ms) instead of a network fetch
 * (40ms warm, 400ms+ when the server has to read storage).
 *
 * Runs in the background at low priority: a few requests at a time, only while
 * the tab is visible and online, newest conversations first. New mail is
 * fetched as soon as it is announced. Bodies are immutable and keyed by URL
 * (mail/body-url.ts), so anything already cached is skipped with a cheap lookup.
 */
import type { MailDatabaseClient } from '#lib/clients.ts';
import { bodyUrl } from './body-url';
import { resolvedScheme } from '#lib/theme.ts';

/** Must match BODY_CACHE in service-worker.ts. */
const CACHE_NAME = 'dm-bodies';
/** Conversations this recent are kept on the device. */
const KEEP_DAYS = 90;
/** Upper bound on conversations walked per pass. */
const MAX_THREADS = 1500;
/** Parallel downloads — low enough never to compete with what the user opens. */
const CONCURRENCY = 3;
/** Image warm-up is limited to the newest messages; the rest load on open. */
const IMAGE_WARM_MESSAGES = 150;
/** A full pass is re-run this often to pick up anything that arrived meanwhile. */
const REPASS_MS = 10 * 60 * 1000;

interface ThreadDoc {
	id: string | number;
	last_message_at?: number;
	folder?: string;
}
interface MessageDoc {
	id: string | number;
	thread_id?: string | number;
	date?: number;
	folder?: string;
}

export function startBodyDownloader(db: MailDatabaseClient): {
	/** Fetch one message's body now (e.g. it just arrived). */
	add: (message_id: string) => void;
	stop: () => void;
} {
	let stopped = false;
	let cache: Cache | null = null;
	const queue: Array<{ id: string; images: boolean }> = [];
	const queued = new Set<string>();
	let running = 0;
	let timer: ReturnType<typeof setTimeout> | null = null;

	const canWork = () =>
		!stopped && navigator.onLine && document.visibilityState === 'visible' && !saveData();

	function enqueue(id: string, images: boolean, front = false) {
		if (queued.has(id)) return;
		queued.add(id);
		if (front) queue.unshift({ id, images });
		else queue.push({ id, images });
		pump();
	}

	function pump() {
		while (running < CONCURRENCY && queue.length && canWork()) {
			const next = queue.shift()!;
			running++;
			void download(next.id, next.images).finally(() => {
				running--;
				pump();
			});
		}
	}

	async function download(id: string, images: boolean) {
		try {
			cache ??= await caches.open(CACHE_NAME);
			const url = bodyUrl(id, resolvedScheme());
			let res = await cache.match(url);
			if (!res) {
				const fresh = await fetch(url, { priority: 'low', credentials: 'same-origin' });
				if (!fresh.ok) return;
				// With a controlling service worker, its cache-first handler has
				// already stored it; otherwise (first visit) store it ourselves.
				if (!navigator.serviceWorker?.controller) await cache.put(url, fresh.clone());
				res = fresh;
			}
			if (images) await warmImages(await res.text());
		} catch {
			/* best-effort — the reader fetches on open as before */
		}
	}

	/** Pull the body's images (already proxied to /api/img) into the cache too. */
	async function warmImages(html: string) {
		const srcs = new Set<string>();
		for (const m of html.matchAll(/(?:src="|url\()(\/api\/img\?u=[^")]+)/g)) {
			srcs.add(m[1].replaceAll('&amp;', '&'));
		}
		for (const src of srcs) {
			if (!canWork()) return;
			if (await cache!.match(src)) continue;
			try {
				const res = await fetch(src, { priority: 'low', credentials: 'same-origin' });
				if (res.ok && !navigator.serviceWorker?.controller) await cache!.put(src, res);
			} catch {
				/* skip */
			}
		}
	}

	/** Walk recent conversations newest-first and queue every message in them. */
	async function pass() {
		if (stopped) return;
		try {
			const since = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000;
			const threads = (
				(await db
					.list('thread', {
						order: [{ field: 'last_message_at', direction: 'DESC' }],
						limit: MAX_THREADS,
					} as never)
					.load()) as unknown as { hits?: Array<{ document?: ThreadDoc }> }
			).hits
				?.map((h) => h.document)
				.filter(
					(t): t is ThreadDoc =>
						!!t && (t.last_message_at ?? 0) >= since && t.folder !== 'spam' && t.folder !== 'trash',
				);
			if (!threads?.length) return;
			let warmed = 0;
			// Messages for 50 conversations per query (thread_id takes a list).
			for (let i = 0; i < threads.length && !stopped; i += 50) {
				const ids = threads.slice(i, i + 50).map((t) => String(t.id));
				const res = (await db
					.list('message', { where: { thread_id: { in: ids } }, limit: 1000 } as never)
					.load()) as unknown as { hits?: Array<{ document?: MessageDoc }> };
				const messages = (res.hits ?? [])
					.map((h) => h.document)
					.filter((m): m is MessageDoc => !!m && m.folder !== 'drafts')
					// Newest first inside the batch too, so the conversation you are
					// most likely to open next is ready first.
					.sort((a, b) => (b.date ?? 0) - (a.date ?? 0));
				for (const m of messages) enqueue(String(m.id), warmed++ < IMAGE_WARM_MESSAGES);
			}
		} catch (err) {
			console.warn('[bodies] background download pass failed', err);
		} finally {
			if (!stopped) timer = setTimeout(pass, REPASS_MS);
		}
	}

	const resume = () => pump();
	window.addEventListener('online', resume);
	document.addEventListener('visibilitychange', resume);

	// Ask the browser not to evict our caches under storage pressure. Granted
	// silently for installed PWAs and frequently-used sites; harmless otherwise.
	void navigator.storage?.persist?.().catch(() => false);

	// Start once the page has settled so the first paint and the open thread
	// aren't competing with downloads.
	const idle =
		'requestIdleCallback' in window
			? window.requestIdleCallback(() => void pass(), { timeout: 5000 })
			: setTimeout(() => void pass(), 3000);

	return {
		add: (message_id) => enqueue(message_id, true, true),
		stop: () => {
			stopped = true;
			queue.length = 0;
			if (timer) clearTimeout(timer);
			if ('requestIdleCallback' in window) window.cancelIdleCallback(idle as number);
			else clearTimeout(idle as number);
			window.removeEventListener('online', resume);
			document.removeEventListener('visibilitychange', resume);
		},
	};
}

function saveData(): boolean {
	return !!(navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData;
}
