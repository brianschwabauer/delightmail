import { describe, it, expect } from 'vitest';
import { sanitizeEmailHtml } from './sanitize';

describe('sanitizeEmailHtml — XSS corpus (every payload must come out inert)', () => {
	const attacks: Array<[string, string]> = [
		['inline script', '<script>alert(1)</script><p>hi</p>'],
		['event handler', '<img src="x" onerror="alert(1)">'],
		['javascript: href', '<a href="javascript:alert(1)">click</a>'],
		['iframe', '<iframe src="https://evil.com"></iframe>'],
		['object/embed', '<object data="evil.swf"></object><embed src="e">'],
		['form + input', '<form action="/steal"><input name="pw"></form>'],
		['svg onload', '<svg onload="alert(1)"></svg>'],
		['meta refresh', '<meta http-equiv="refresh" content="0;url=evil">'],
		['base tag', '<base href="https://evil.com/">'],
		['style expression', '<div style="width: expression(alert(1))">x</div>'],
	];

	for (const [name, html] of attacks) {
		it(`neutralizes ${name}`, () => {
			const out = sanitizeEmailHtml(html);
			expect(out).not.toMatch(/<script/i);
			expect(out).not.toMatch(/onerror=/i);
			expect(out).not.toMatch(/onload=/i);
			expect(out).not.toMatch(/<iframe/i);
			expect(out).not.toMatch(/<object/i);
			expect(out).not.toMatch(/<embed/i);
			expect(out).not.toMatch(/<form/i);
			expect(out).not.toMatch(/<meta/i);
			expect(out).not.toMatch(/<base/i);
			expect(out).not.toMatch(/javascript:/i);
		});
	}
});

describe('sanitizeEmailHtml — preserves legitimate email content', () => {
	it('keeps tables and inline styles', () => {
		const out = sanitizeEmailHtml(
			'<table><tr><td style="color:red">Cell</td></tr></table>',
		);
		expect(out).toMatch(/<table/);
		expect(out).toMatch(/<td/);
		expect(out).toMatch(/Cell/);
	});

	it('keeps https images', () => {
		const out = sanitizeEmailHtml('<img src="https://example.com/logo.png" alt="Logo">');
		expect(out).toMatch(/src="https:\/\/example\.com\/logo\.png"/);
	});

	it('upgrades http images to https', () => {
		const out = sanitizeEmailHtml('<img src="http://example.com/t.gif">');
		expect(out).toMatch(/src="https:\/\/example\.com\/t\.gif"/);
	});

	it('rewrites cid: images to the attachment endpoint', () => {
		const out = sanitizeEmailHtml('<img src="cid:logo123">', {
			cidBase: '/api/attachments',
			cidMap: { logo123: 'att-9' },
		});
		expect(out).toMatch(/src="\/api\/attachments\/att-9"/);
	});

	it('drops cid: images with no mapping', () => {
		const out = sanitizeEmailHtml('<img src="cid:missing">');
		expect(out).not.toMatch(/cid:/);
	});

	it('hardens links with target=_blank rel=noopener', () => {
		const out = sanitizeEmailHtml('<a href="https://example.com">link</a>');
		expect(out).toMatch(/target="_blank"/);
		expect(out).toMatch(/rel="noopener noreferrer"/);
	});

	it('returns empty string for empty input', () => {
		expect(sanitizeEmailHtml('')).toBe('');
	});
});
