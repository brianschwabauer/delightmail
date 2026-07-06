/// <reference types="@sveltejs/kit" />
/// <reference lib="webworker" />
/**
 * PWA service worker (§10.4). Precaches the app shell, serves immutable message
 * bodies + attachments cache-first (they never change), and network-only for
 * everything else — the real offline data layer is the DatabaseClient's IndexedDB
 * mirror, not the SW. Also displays web-push notifications and deep-links on click.
 */
import { build, files, version } from '$service-worker';

const sw = self as unknown as ServiceWorkerGlobalScope;

const SHELL_CACHE = `dm-shell-${version}`;
const BODY_CACHE = `dm-bodies-v1`;
const SHELL_ASSETS = [...build, ...files];

sw.addEventListener('install', (event) => {
	event.waitUntil(
		caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_ASSETS)).then(() => sw.skipWaiting()),
	);
});

sw.addEventListener('activate', (event) => {
	event.waitUntil(
		(async () => {
			for (const key of await caches.keys()) {
				if (key !== SHELL_CACHE && key !== BODY_CACHE) await caches.delete(key);
			}
			await sw.clients.claim();
		})(),
	);
});

sw.addEventListener('fetch', (event) => {
	const req = event.request;
	if (req.method !== 'GET') return;
	const url = new URL(req.url);
	if (url.origin !== location.origin) return;

	// Immutable message bodies + attachments → cache-first (they never change).
	if (
		/\/api\/messages\/[^/]+\/(body|raw)/.test(url.pathname) ||
		url.pathname.startsWith('/api/attachments/')
	) {
		event.respondWith(cacheFirst(req, BODY_CACHE));
		return;
	}

	// Precached shell assets → cache-first.
	if (SHELL_ASSETS.includes(url.pathname)) {
		event.respondWith(cacheFirst(req, SHELL_CACHE));
		return;
	}

	// Everything else (API + navigations) → network, falling back to the shell
	// so the app boots offline (its mirror then serves the data).
	if (req.mode === 'navigate') {
		event.respondWith(networkThenShell(req));
	}
});

async function cacheFirst(req: Request, cacheName: string): Promise<Response> {
	const cache = await caches.open(cacheName);
	const hit = await cache.match(req);
	if (hit) return hit;
	const res = await fetch(req);
	if (res.ok) cache.put(req, res.clone());
	return res;
}

async function networkThenShell(req: Request): Promise<Response> {
	try {
		return await fetch(req);
	} catch {
		const cache = await caches.open(SHELL_CACHE);
		const shell = await cache.match('/') ?? (await cache.match(SHELL_ASSETS[0]));
		return shell ?? new Response('Offline', { status: 503 });
	}
}

// --- Web push (§10.4) ---
sw.addEventListener('push', (event) => {
	if (!event.data) return;
	let payload: { title?: string; body?: string; thread_id?: string; badge?: number } = {};
	try {
		payload = event.data.json();
	} catch {
		payload = { title: 'New mail', body: event.data.text() };
	}
	event.waitUntil(
		(async () => {
			await sw.registration.showNotification(payload.title ?? 'New mail', {
				body: payload.body ?? '',
				icon: '/icon.svg',
				badge: '/icon.svg',
				data: { thread_id: payload.thread_id },
				tag: payload.thread_id ?? 'mail',
			});
			if (typeof payload.badge === 'number' && 'setAppBadge' in navigator) {
				await (navigator as unknown as { setAppBadge(n: number): Promise<void> })
					.setAppBadge(payload.badge)
					.catch(() => {});
			}
		})(),
	);
});

sw.addEventListener('notificationclick', (event) => {
	event.notification.close();
	const thread_id = (event.notification.data as { thread_id?: string })?.thread_id;
	const target = thread_id ? `/mail/inbox?t=${thread_id}` : '/mail/inbox';
	event.waitUntil(
		(async () => {
			const all = await sw.clients.matchAll({ type: 'window', includeUncontrolled: true });
			for (const client of all) {
				if ('focus' in client) {
					await client.focus();
					(client as WindowClient).navigate?.(target);
					return;
				}
			}
			await sw.clients.openWindow(target);
		})(),
	);
});

export {};
