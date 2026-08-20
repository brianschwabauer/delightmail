/**
 * Strip obvious tracking pixels from a sanitized HTML body at serve time.
 *
 * Deliberately a heuristic, not a blocklist: an <img> is dropped when it is
 * tiny (≤ 2px in either dimension), hidden (display:none / visibility:hidden /
 * opacity:0), or its URL smells like an open beacon. Real images a sender
 * also uses for tracking (logos, hero images) are left alone — that's out of
 * scope. Runs on the sanitizer's output, so attributes are well-formed and a
 * regex per tag is enough; no DOM needed in the worker.
 */

const IMG_TAG = /<img\b[^>]*>/gi;
const ATTR = (name: string) =>
	new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
const WIDTH_ATTR = ATTR('width');
const HEIGHT_ATTR = ATTR('height');
const STYLE_ATTR = ATTR('style');
const SRC_ATTR = ATTR('src');

const TINY = 2;

/** Host/path shapes used almost exclusively for open tracking. Kept short on
 *  purpose — every entry here is a URL no legitimate image is served from. */
const BEACON_URL =
	/(?:\/(?:open|o|track|trk|pixel|beacon|imp|wf\/open|e\/o|via\/o)(?:[?#]|$)|\/(?:open|track|pixel|beacon)\/|\/(?:open|track|pixel|beacon|spacer|blank|1x1|clear)\.(?:gif|png)(?:[?#]|$)|[?&](?:open|opened|track|pixel)=|list-manage\.com\/track\/open|mailchimp\.com\/track\/open|sendgrid\.net\/wf\/open|mandrillapp\.com\/track\/open|click\.[^/]+\/(?:o|open)\/|intercom-mail\.com\/via\/o\b|intercom-mail\.com\/q\/|hubspotemail\.net\/e\/o|mailgun\.[a-z]+\/o\/|awstrack\.me\/I0\/|open\.convertkit|cmail\d*\.com\/t\/[^/]+\/o\/)/i;

function attr(tag: string, re: RegExp): string | null {
	const m = re.exec(tag);
	if (!m) return null;
	return (m[1] ?? m[2] ?? m[3] ?? '').trim();
}

/** Parse a CSS/HTML length to px; null when unknown/relative (%, auto, em…). */
function px(v: string | null): number | null {
	if (v === null) return null;
	const m = /^(\d+(?:\.\d+)?)(px)?$/i.exec(v.trim());
	return m ? Number(m[1]) : null;
}

function styleProp(style: string, prop: string): string | null {
	const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;!]+)`, 'i').exec(style);
	return m ? m[1].trim() : null;
}

export function isTrackingPixel(tag: string): boolean {
	const style = attr(tag, STYLE_ATTR) ?? '';
	const w = px(styleProp(style, 'width')) ?? px(attr(tag, WIDTH_ATTR));
	const h = px(styleProp(style, 'height')) ?? px(attr(tag, HEIGHT_ATTR));
	// Tiny in either dimension (1×1, 0×0, 1×N spacers used as beacons).
	if ((w !== null && w <= TINY) || (h !== null && h <= TINY)) return true;
	// Hidden outright. Nobody hides a picture they want you to see.
	if (/\bdisplay\s*:\s*none\b/i.test(style)) return true;
	if (/\bvisibility\s*:\s*hidden\b/i.test(style)) return true;
	const opacity = styleProp(style, 'opacity');
	if (opacity !== null && Number(opacity) === 0) return true;
	if (/\bmax-(?:width|height)\s*:\s*0(?:px)?\b/i.test(style)) return true;
	const src = attr(tag, SRC_ATTR) ?? '';
	if (BEACON_URL.test(src)) return true;
	return false;
}

export function stripTrackingPixels(html: string): string {
	return html.replace(IMG_TAG, (tag) => (isTrackingPixel(tag) ? '' : tag));
}
