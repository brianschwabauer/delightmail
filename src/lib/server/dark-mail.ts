/**
 * Dark-scheme treatment for email bodies.
 *
 * Three tiers, decided from the sanitized HTML alone:
 * - `design`: the sender built a sheet (painted backgrounds, layout tables,
 *   logos, its own dark-mode rules). Rendered untouched on white.
 * - `plain`: declares no colors at all. Gets the reader's dark palette.
 * - `flip`: personal/transactional mail that sets text colors but assumes a
 *   white sheet (Apple Mail's `color:rgb(0,0,0)`, a grey signature). Gets the
 *   dark palette AND its colors re-mapped: lightness flipped in OKLCH so the
 *   hierarchy (body / muted / link) survives, hue and chroma kept.
 *
 * The asymmetry is deliberate: light-when-wrong is readable, dark-when-wrong
 * isn't, so every uncertain signal falls back to `design`.
 */

export type BodyTier = 'design' | 'plain' | 'flip';

/** Colors that don't paint anything and must never trip the classifier. */
const NO_PAINT = /^(?:transparent|inherit|initial|unset|none|currentcolor|revert(?:-layer)?)$/i;

const COLOR_TOKEN =
	/#[0-9a-f]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)|\b(?:white|black|gray|grey|silver|dimgray|dimgrey|darkgray|darkgrey|lightgray|lightgrey|gainsboro|whitesmoke|navy|blue|red|green|maroon|purple|windowtext)\b/gi;

const MAX_FLIP_COLORS = 6;
/** Images at or below this declared size are icons/pixels, not artwork. */
const ICON_PX = 32;

export function classifyBody(html: string): BodyTier {
	// Ships its own dark mode — it knows better than we do.
	if (/prefers-color-scheme|color-scheme\s*[:=]/i.test(html)) return 'design';

	// Any painted, non-white background is a designed sheet.
	for (const m of html.matchAll(/(?:bgcolor\s*=\s*"?|background(?:-color)?\s*:\s*)([^;">]+)/gi)) {
		const rgb = firstColor(m[1]);
		if (rgb === 'none') continue;
		if (rgb === null || !isWhite(rgb)) return 'design';
	}

	// Templated layout: fixed-width / centered tables, media queries, webfonts.
	if (/<table[^>]*(?:\swidth\s*=\s*"?[3-9]\d{2,}|max-width\s*:|align\s*=\s*"?center)/i.test(html)) {
		return 'design';
	}
	if (/@media|@font-face|@import/i.test(html)) return 'design';

	// Images: tracking pixels and small icons are fine; inline attachments
	// (pasted screenshots, photos) are content; anything else remote is a logo
	// drawn for a white sheet.
	for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
		const tag = m[0];
		if (/src="\/api\/attachments\//i.test(tag)) continue;
		if (/\.jpe?g(?:[?#"]|$)/i.test(tag)) continue;
		const w = dim(tag, 'width');
		const h = dim(tag, 'height');
		if ((w !== null && w <= ICON_PX) || (h !== null && h <= ICON_PX)) continue;
		// Open trackers (Salesforce, HubSpot…) ship as an undimensioned, alt-less
		// image; a logo someone meant you to see carries a size or an alt.
		if (w === null && h === null && /\salt\s*=\s*""/i.test(tag)) continue;
		return 'design';
	}

	const colors = new Set<string>();
	for (const m of html.matchAll(
		/(?:^|[;"'\s{])color\s*:\s*([^;"}]+)|<font\b[^>]*\scolor\s*=\s*"?([^" >]+)/gi,
	)) {
		const rgb = firstColor(m[1] ?? m[2]);
		if (rgb === 'none') continue;
		if (rgb === null) return 'design';
		// Light text implies a painted surface we failed to detect.
		if (toOklch(rgb).L > 0.75) return 'design';
		colors.add(rgb.join(','));
	}
	if (colors.size === 0) return 'plain';
	if (colors.size > MAX_FLIP_COLORS) return 'design';
	return 'flip';
}

/**
 * Re-map every color in inline styles, <style> rules and <font> tags for a
 * dark sheet: each color keeps its OKLCH contrast distance from the sheet
 * (`#000 → #fff`, `#393a3d → light grey`, muted stays muted), chromatic
 * colors never drop below L 0.7 so links stay legible,
 * white backgrounds become the reader's dark sheet, and colors that already
 * read on dark are left alone.
 */
export function flipColors(html: string, dark_bg: string): string {
	const sheet_L = toOklch(parseColor(dark_bg) ?? [22, 24, 28]).L;
	const flipToken = (token: string): string => {
		const rgb = parseColor(token);
		if (!rgb) return token;
		const { L, C, h } = toOklch(rgb);
		if (L >= 0.6) return token; // already works on dark
		// Keep the color's contrast distance from its sheet: on white that was
		// (1 - L); re-plant it the same distance above the dark sheet.
		let L2 = Math.min(1, sheet_L + (1 - L));
		if (C > 0.03) L2 = Math.max(L2, 0.7);
		return toHex(fromOklch(L2, C, h));
	};
	return html
		.replace(
			/(background(?:-color)?\s*:\s*)([^;"}]+)/gi,
			(_, k: string, v: string) =>
				k + v.replace(COLOR_TOKEN, (c) => (isWhite(parseColor(c)) ? dark_bg : c)),
		)
		.replace(
			/(bgcolor\s*=\s*"?)([^" >]+)/gi,
			(_, k: string, v: string) => k + (isWhite(parseColor(v)) ? dark_bg : v),
		)
		.replace(
			/((?:^|[;"'\s{])(?:color|border[a-z-]*|outline[a-z-]*|text-decoration-color)\s*:\s*)([^;"}]+)/gi,
			(_, k: string, v: string) => k + v.replace(COLOR_TOKEN, flipToken),
		)
		.replace(
			/(<font\b[^>]*\scolor\s*=\s*"?)([^" >]+)/gi,
			(_, k: string, v: string) => k + flipToken(v),
		);
}

function firstColor(value: string): Rgb | 'none' | null {
	const v = value.trim();
	if (NO_PAINT.test(v.replace(/\s*!important\s*$/i, ''))) return 'none';
	const token = v.match(COLOR_TOKEN)?.[0];
	if (!token) return /url\(|gradient\(/i.test(v) ? null : 'none';
	return parseColor(token);
}

function dim(tag: string, attr: 'width' | 'height'): number | null {
	const a = tag.match(new RegExp(`\\s${attr}\\s*=\\s*"?(\\d+)`, 'i'));
	if (a) return Number(a[1]);
	const s = tag.match(new RegExp(`${attr}\\s*:\\s*(\\d+)px`, 'i'));
	return s ? Number(s[1]) : null;
}

function isWhite(rgb: Rgb | null): boolean {
	return rgb !== null && rgb[0] >= 250 && rgb[1] >= 250 && rgb[2] >= 250;
}

// ---- color math -----------------------------------------------------------

type Rgb = [number, number, number];

const NAMED: Record<string, Rgb> = {
	white: [255, 255, 255],
	black: [0, 0, 0],
	windowtext: [0, 0, 0],
	gray: [128, 128, 128],
	grey: [128, 128, 128],
	silver: [192, 192, 192],
	dimgray: [105, 105, 105],
	dimgrey: [105, 105, 105],
	darkgray: [169, 169, 169],
	darkgrey: [169, 169, 169],
	lightgray: [211, 211, 211],
	lightgrey: [211, 211, 211],
	gainsboro: [220, 220, 220],
	whitesmoke: [245, 245, 245],
	navy: [0, 0, 128],
	blue: [0, 0, 255],
	red: [255, 0, 0],
	green: [0, 128, 0],
	maroon: [128, 0, 0],
	purple: [128, 0, 128],
};

export function parseColor(token: string): Rgb | null {
	const t = token.trim().toLowerCase();
	if (NAMED[t]) return NAMED[t];
	if (t[0] === '#') {
		const hex = t.slice(1);
		if (hex.length === 3 || hex.length === 4) {
			return [0, 1, 2].map((i) => parseInt(hex[i] + hex[i], 16)) as Rgb;
		}
		if (hex.length === 6 || hex.length === 8) {
			return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)) as Rgb;
		}
		return null;
	}
	const fn = t.match(/^(rgba?|hsla?)\(([^)]*)\)$/);
	if (!fn) return null;
	const parts = fn[2].split(/[\s,/]+/).filter(Boolean);
	if (parts.length < 3) return null;
	if (fn[1].startsWith('rgb')) {
		const ch = parts
			.slice(0, 3)
			.map((p) => (p.endsWith('%') ? (parseFloat(p) * 255) / 100 : parseFloat(p)));
		if (ch.some((n) => Number.isNaN(n))) return null;
		return ch.map((n) => Math.round(Math.min(255, Math.max(0, n)))) as Rgb;
	}
	const hh = parseFloat(parts[0]) / 360;
	const s = parseFloat(parts[1]) / 100;
	const l = parseFloat(parts[2]) / 100;
	if ([hh, s, l].some((n) => Number.isNaN(n))) return null;
	const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
	const p = 2 * l - q;
	const f = (tt: number) => {
		if (tt < 0) tt += 1;
		if (tt > 1) tt -= 1;
		if (tt < 1 / 6) return p + (q - p) * 6 * tt;
		if (tt < 1 / 2) return q;
		if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
		return p;
	};
	return [f(hh + 1 / 3), f(hh), f(hh - 1 / 3)].map((c) => Math.round(c * 255)) as Rgb;
}

const lin = (c: number) => {
	const v = c / 255;
	return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const gam = (v: number) => {
	const c = v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
	return Math.round(Math.min(1, Math.max(0, c)) * 255);
};

export function toOklch(rgb: Rgb): { L: number; C: number; h: number } {
	const [r, g, b] = rgb.map(lin);
	const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
	const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
	const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
	const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
	const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
	const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
	return { L, C: Math.hypot(a, bb), h: Math.atan2(bb, a) };
}

function oklabToLinear(L: number, a: number, b: number): [number, number, number] {
	const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
	const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
	const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
	return [
		4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
		-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
		-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
	];
}

/** OKLCH → sRGB, shrinking chroma until the color fits the gamut. */
export function fromOklch(L: number, C: number, h: number): Rgb {
	let c = C;
	for (let i = 0; i < 12; i++) {
		const lin3 = oklabToLinear(L, c * Math.cos(h), c * Math.sin(h));
		if (lin3.every((v) => v >= -0.0005 && v <= 1.0005)) return lin3.map(gam) as Rgb;
		c *= 0.8;
	}
	return oklabToLinear(L, 0, 0).map(gam) as Rgb;
}

const toHex = (rgb: Rgb) => '#' + rgb.map((n) => n.toString(16).padStart(2, '0')).join('');
