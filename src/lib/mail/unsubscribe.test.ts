import { describe, it, expect } from 'vitest';
import { parseListUnsubscribe, senderDomain, extractUnsubscribe } from './unsubscribe';

describe('parseListUnsubscribe', () => {
	it('extracts multiple entries', () => {
		expect(parseListUnsubscribe('<https://x/u>, <mailto:u@x>')).toEqual([
			'https://x/u',
			'mailto:u@x',
		]);
	});
	it('returns [] for empty', () => {
		expect(parseListUnsubscribe(undefined)).toEqual([]);
	});
});

describe('senderDomain', () => {
	it('extracts the domain lowercased', () => {
		expect(senderDomain('News@Marketing.EXAMPLE.com')).toBe('marketing.example.com');
	});
	it('returns empty for missing', () => {
		expect(senderDomain(undefined)).toBe('');
	});
});

describe('extractUnsubscribe', () => {
	it('prefers RFC 8058 one-click when the POST header is present', () => {
		const c = extractUnsubscribe({
			list_unsubscribe: '<https://x/unsub>, <mailto:u@x>',
			list_unsubscribe_post: 'List-Unsubscribe=One-Click',
			from_email: 'news@brand.com',
		});
		expect(c).toMatchObject({ method: 'http_oneclick', target: 'https://x/unsub', sender_domain: 'brand.com' });
	});

	it('falls back to mailto when no one-click', () => {
		const c = extractUnsubscribe({
			list_unsubscribe: '<mailto:u@x>',
			from_email: 'news@brand.com',
		});
		expect(c?.method).toBe('mailto');
		expect(c?.target).toBe('mailto:u@x');
	});

	it('uses a manual link when only an http entry exists without one-click', () => {
		const c = extractUnsubscribe({
			list_unsubscribe: '<https://x/unsub>',
			from_email: 'news@brand.com',
		});
		expect(c?.method).toBe('link_manual');
	});

	it('falls back to a body unsubscribe link when no header', () => {
		const c = extractUnsubscribe({
			from_email: 'news@brand.com',
			body_links: ['https://brand.com/home', 'https://brand.com/unsubscribe?id=9'],
		});
		expect(c?.method).toBe('link_manual');
		expect(c?.target).toContain('unsubscribe');
	});

	it('returns undefined when nothing is available', () => {
		expect(extractUnsubscribe({ from_email: 'x@y.com' })).toBeUndefined();
	});
});
