/**
 * Best-effort sender/contact avatar images, without a contacts API.
 *
 * We have no stored photos yet (Google People API is a later addition), so we
 * synthesize an image URL from the email address and let <Avatar src> load it,
 * quietly falling back to initials when it 404s or errors:
 *
 *   • company / service domains  → the site favicon (Cloudflare, GitHub,
 *     Stripe, newsletters — the machine senders that dominate an inbox)
 *   • personal mail providers     → Gravatar (the domain favicon would just be
 *     the provider's logo); `d=404` so it resolves to the person's photo when
 *     they have one, else the Avatar shows initials
 *   • no / malformed address      → undefined → initials
 *
 * No network happens here; these are plain URLs handed to the <img> the Avatar
 * renders. When real contact photos land (People API), prefer a stored
 * `contact.photo_url` and fall back to this.
 */
import { md5 } from './md5';

// Domains where the address belongs to a person, not a brand.
const PERSONAL_PROVIDERS = new Set([
	'gmail.com',
	'googlemail.com',
	'yahoo.com',
	'ymail.com',
	'rocketmail.com',
	'outlook.com',
	'hotmail.com',
	'live.com',
	'msn.com',
	'icloud.com',
	'me.com',
	'mac.com',
	'proton.me',
	'protonmail.com',
	'pm.me',
	'aol.com',
	'gmx.com',
	'gmx.net',
	'mail.com',
	'zoho.com',
	'fastmail.com',
	'fastmail.fm',
	'yandex.com',
	'yandex.ru',
	'hey.com',
	'tutanota.com',
	'tuta.io',
]);

/** The lowercased domain of an email address, or undefined if it isn't one. */
export function emailDomain(email?: string | null): string | undefined {
	if (!email) return undefined;
	const at = email.lastIndexOf('@');
	if (at < 1 || at === email.length - 1) return undefined;
	const domain = email.slice(at + 1).trim().toLowerCase();
	return domain || undefined;
}

// Common second-level public suffixes, so registrableDomain("bbc.co.uk") is
// "bbc.co.uk" and not "co.uk". A shortlist, not the full PSL — wrong guesses
// just cost one 404 and the Avatar falls back to initials.
const SECOND_LEVEL_TLDS = new Set([
	'co.uk', 'org.uk', 'ac.uk', 'gov.uk',
	'com.au', 'net.au', 'org.au',
	'co.nz', 'co.jp', 'or.jp', 'ne.jp',
	'com.br', 'com.mx', 'com.ar',
	'co.in', 'co.za', 'com.sg', 'com.hk', 'com.tw', 'co.kr',
]);

/**
 * The registrable (apex) domain of a hostname: "md.getsentry.com" →
 * "getsentry.com". Mail senders overwhelmingly send from marketing/transport
 * subdomains (md.*, em1234.*, mail.*) that either have NO favicon or a tiny
 * 16px one — the brand's real, larger favicon lives on the apex.
 */
export function registrableDomain(domain: string): string {
	const parts = domain.split('.');
	if (parts.length <= 2) return domain;
	const last_two = parts.slice(-2).join('.');
	const take = SECOND_LEVEL_TLDS.has(last_two) ? 3 : 2;
	return parts.slice(-take).join('.');
}

/**
 * An avatar image URL for an email address, or undefined when we have nothing
 * better than initials. Safe to call every render — it only builds a string.
 */
export function contactAvatarUrl(email?: string | null): string | undefined {
	const domain = emailDomain(email);
	if (!domain) return undefined;
	if (PERSONAL_PROVIDERS.has(domain)) {
		const hash = md5((email as string).trim().toLowerCase());
		return `https://www.gravatar.com/avatar/${hash}?s=128&d=404`;
	}
	// Look the favicon up on the APEX domain, not the sending subdomain —
	// e.g. Sentry mails from md.getsentry.com, whose own favicon is a blurry
	// 16px; getsentry.com serves the real 48px mark. (Google's s2 service caps
	// most sites well below the requested 128 — see also the `sz` param.)
	const apex = registrableDomain(domain);
	return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(apex)}&sz=128`;
}
