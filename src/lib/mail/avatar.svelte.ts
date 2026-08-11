/**
 * Reactive wrapper over `contactAvatarUrl` that only hands out an image URL
 * once the image has actually loaded AND is sharp enough to show.
 *
 * Google's s2 favicon service never 404s — domains with no favicon get a
 * generic 16px globe, and plenty of real favicons only exist at 16px. Upscaled
 * into a 32–48px avatar they read as a blurry smudge, worse than initials. So
 * each candidate URL is decoded off-screen once per session; favicons below
 * MIN_FAVICON_PX are rejected and the Avatar falls back to its initials.
 * Gravatar URLs use `d=404`, so any successful load there is a real photo.
 */
import { SvelteMap } from 'svelte/reactivity';
import { contactAvatarUrl } from './avatar';

/** Below this natural size a favicon upscales into a blur — including the s2
 *  default globe, which is served at 16px no matter what `sz` asks for. */
const MIN_FAVICON_PX = 32;

/** url → usable? Reactive, so avatars appear as verdicts land. */
const verdicts = new SvelteMap<string, boolean>();
const checking = new Set<string>();

/** An avatar URL that is known to load and look sharp, or undefined (initials).
 *  Safe to call every render — verification runs once per URL per session. */
export function verifiedAvatarUrl(email?: string | null): string | undefined {
	const url = contactAvatarUrl(email);
	if (!url) return undefined;
	const ok = verdicts.get(url);
	if (ok === undefined) {
		verify(url);
		return undefined;
	}
	return ok ? url : undefined;
}

function verify(url: string) {
	if (checking.has(url) || typeof Image === 'undefined') return;
	checking.add(url);
	const img = new Image();
	img.onload = () => {
		const is_favicon = url.includes('/s2/favicons');
		verdicts.set(url, !is_favicon || img.naturalWidth >= MIN_FAVICON_PX);
	};
	img.onerror = () => verdicts.set(url, false);
	img.src = url;
}
