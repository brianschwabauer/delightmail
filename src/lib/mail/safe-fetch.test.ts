import { describe, it, expect } from 'vitest';
import { isBlockedHost, validatePublicHttpsUrl } from './safe-fetch';

describe('isBlockedHost', () => {
	it('blocks localhost and internal zones', () => {
		for (const h of ['localhost', 'app.localhost', 'db.internal', 'printer.local', 'x.home.arpa']) {
			expect(isBlockedHost(h)).toBe(true);
		}
	});

	it('blocks private / loopback / link-local IPv4 (incl. cloud metadata)', () => {
		for (const h of [
			'127.0.0.1',
			'10.1.2.3',
			'192.168.0.1',
			'172.16.5.9',
			'169.254.169.254',
			'100.64.0.1',
			'0.0.0.0',
		]) {
			expect(isBlockedHost(h)).toBe(true);
		}
	});

	it('blocks IPv6 loopback / link-local / unique-local', () => {
		for (const h of ['::1', '[::1]', 'fe80::1', 'fc00::1', 'fd12:3456::1']) {
			expect(isBlockedHost(h)).toBe(true);
		}
	});

	it('allows public hosts and does not false-positive on fc*/fd* names', () => {
		for (const h of [
			'example.com',
			'unsub.mailer.io',
			'fcdn.example.com',
			'fdisk.example.org',
			'8.8.8.8',
			'203.0.113.10',
		]) {
			expect(isBlockedHost(h)).toBe(false);
		}
	});
});

describe('validatePublicHttpsUrl', () => {
	it('accepts a public https URL', () => {
		const v = validatePublicHttpsUrl('https://unsub.example.com/u?x=1');
		expect('url' in v && v.url.hostname).toBe('unsub.example.com');
	});

	it('rejects non-https schemes', () => {
		expect(validatePublicHttpsUrl('http://example.com')).toHaveProperty('reason');
		expect(validatePublicHttpsUrl('ftp://example.com')).toHaveProperty('reason');
	});

	it('rejects private/internal https targets', () => {
		expect(validatePublicHttpsUrl('https://169.254.169.254/latest/meta-data')).toHaveProperty(
			'reason',
		);
		expect(validatePublicHttpsUrl('https://localhost:8080/admin')).toHaveProperty('reason');
	});

	it('rejects garbage', () => {
		expect(validatePublicHttpsUrl('not a url')).toHaveProperty('reason');
	});
});
