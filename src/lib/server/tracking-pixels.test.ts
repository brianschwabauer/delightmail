import { describe, expect, it } from 'vitest';
import { isTrackingPixel, stripTrackingPixels } from './tracking-pixels';

describe('isTrackingPixel', () => {
	it('1x1 attrs', () => {
		expect(
			isTrackingPixel('<img border="0" width="1" height="1" alt="" src="https://x.test/a.gif">'),
		).toBe(true);
	});
	it('tiny via style', () => {
		expect(
			isTrackingPixel('<img src="https://x.test/a" style="width:1px;height:1px;border:0">'),
		).toBe(true);
		expect(isTrackingPixel('<img src="https://x.test/a" style="width: 0px; height: 0px">')).toBe(
			true,
		);
	});
	it('hidden via style', () => {
		expect(isTrackingPixel('<img src="https://x.test/a" style="display:none">')).toBe(true);
		expect(isTrackingPixel('<img src="https://x.test/a" style="visibility: hidden">')).toBe(true);
		expect(
			isTrackingPixel('<img src="https://x.test/a" style="opacity:0;position:absolute">'),
		).toBe(true);
		expect(isTrackingPixel('<img src="https://x.test/a" style="max-height:0;max-width:0">')).toBe(
			true,
		);
	});
	it('beacon URLs', () => {
		expect(
			isTrackingPixel(
				'<img src="https://showtour.intercom-mail.com/via/o?h=abc" width="100" height="100">',
			),
		).toBe(true);
		expect(
			isTrackingPixel(
				'<img src="https://show--tour.intercom-mail.com/q/9MJnT37trBVoa_Gt6twe9w~~/AAAAARA~/x">',
			),
		).toBe(true);
		expect(isTrackingPixel('<img src="https://list-manage.com/track/open.php?u=1">')).toBe(true);
		expect(isTrackingPixel('<img src="https://u123.ct.sendgrid.net/wf/open?upn=abc">')).toBe(true);
		expect(isTrackingPixel('<img src="https://cdn.test/spacer.gif">')).toBe(true);
	});
	it('keeps real images', () => {
		expect(
			isTrackingPixel('<img src="https://cdn.test/hero.png" width="600" height="300" alt="Hero">'),
		).toBe(false);
		expect(
			isTrackingPixel(
				'<img src="https://cdn.test/logo.png" style="width:120px;height:auto;opacity:0.9">',
			),
		).toBe(false);
		expect(isTrackingPixel('<img src="https://cdn.test/photo.jpg">')).toBe(false);
		expect(isTrackingPixel('<img src="https://cdn.test/open-house.jpg" width="400">')).toBe(false);
		expect(isTrackingPixel('<img src="https://cdn.test/i/o/abc/photo.png" width="400">')).toBe(
			false,
		);
		// Percent widths are layout, not a size we can judge.
		expect(isTrackingPixel('<img src="https://cdn.test/a.png" width="100%">')).toBe(false);
	});
});

describe('stripTrackingPixels', () => {
	it('removes only the pixel tags', () => {
		const html =
			'<p>Hi</p><img src="https://cdn.test/hero.png" width="600"><img width="1" height="1" src="https://t.test/o?x">' +
			'<img src="https://t.test/a" style="display:none"><p>Bye</p>';
		expect(stripTrackingPixels(html)).toBe(
			'<p>Hi</p><img src="https://cdn.test/hero.png" width="600"><p>Bye</p>',
		);
	});
});
