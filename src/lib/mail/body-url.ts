/**
 * The one URL a message body is fetched from. The reader's iframe, the
 * neighbour prefetch and the background downloader must agree on it exactly,
 * because the service worker caches by URL.
 *
 * Bump BODY_VERSION whenever the served body changes shape (sanitizer repairs,
 * typesetting, the image rewrite): responses are cached immutable, so a new
 * version is the only way to reach bodies already cached on devices.
 */
export const BODY_VERSION = 7;

export function bodyUrl(message_id: string, scheme: 'light' | 'dark'): string {
	return `/api/messages/${encodeURIComponent(message_id)}/body?scheme=${scheme}&v=${BODY_VERSION}`;
}
