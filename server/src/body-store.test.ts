import { describe, it, expect } from 'vitest';
import { buildCidMap } from './body-store';
import { sanitizeEmailHtml } from '../../src/lib/mail/sanitize';

describe('buildCidMap', () => {
	const prefix = 'org123/msg/abcdef0123456789';

	it('maps content ids to deterministic cid/{hash}/{index} segments', () => {
		const map = buildCidMap(prefix, [
			{ content_id: '<logo@corp>' },
			{ content_id: undefined }, // regular attachment, no cid
			{ content_id: 'photo-1' },
		]);
		expect(map).toEqual({
			'logo@corp': 'cid/abcdef0123456789/0',
			'photo-1': 'cid/abcdef0123456789/2',
		});
	});

	it('produces srcs the sanitizer bakes into stored bodies', () => {
		const map = buildCidMap(prefix, [{ content_id: '<logo@corp>' }]);
		const out = sanitizeEmailHtml('<p>hi</p><img src="cid:logo@corp" alt="logo">', {
			cidBase: '/api/attachments',
			cidMap: map,
		});
		expect(out).toContain('src="/api/attachments/cid/abcdef0123456789/0"');
	});

	it('unmapped cids are still dropped (no broken images)', () => {
		const map = buildCidMap(prefix, [{ content_id: 'other' }]);
		const out = sanitizeEmailHtml('<img src="cid:unknown">', {
			cidBase: '/api/attachments',
			cidMap: map,
		});
		expect(out).not.toContain('cid:');
		expect(out).not.toContain('src=');
	});
});
