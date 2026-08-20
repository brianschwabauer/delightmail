import { describe, expect, it } from 'vitest';
import { classifyBody, flipColors, parseColor, toOklch } from './dark-mail';

const BG = '#16181c';

describe('classifyBody', () => {
	it('plain text with no colors', () => {
		expect(classifyBody('<div style="white-space:pre-wrap">hi</div>')).toBe('plain');
	});
	it('Apple Mail reply: black text on white → flip', () => {
		const html =
			'<div style="color: rgb(0, 0, 0); background-color: rgb(255, 255, 255)">Hi</div>' +
			'<blockquote style="border-left: 3px solid rgb(200,200,200)">q</blockquote>';
		expect(classifyBody(html)).toBe('flip');
	});
	it('grey signature with small svg icons → flip', () => {
		const html =
			'<p style="color:rgb(51,51,51)">Body</p><img src="https://x/icon.svg" width="19" height="19">' +
			'<span style="color:rgb(117,117,117)">muted</span><a style="color:rgb(127,70,92)">link</a>';
		expect(classifyBody(html)).toBe('flip');
	});
	it('pasted inline screenshot is content, not a logo', () => {
		expect(
			classifyBody('<p style="color:#000">see</p><img src="/api/attachments/cid/abc/1">'),
		).toBe('flip');
	});
	it('painted background → design', () => {
		expect(classifyBody('<td style="background:#F0F4F9;color:#1f1f1f">x</td>')).toBe('design');
		expect(classifyBody('<table bgcolor="#f9f9f9"><tr><td>x</td></tr></table>')).toBe('design');
	});
	it('layout table → design', () => {
		expect(classifyBody('<table width="600" style="color:#333"><tr><td>x</td></tr></table>')).toBe(
			'design',
		);
	});
	it('remote logo → design', () => {
		expect(
			classifyBody(
				'<p style="color:#333">x</p><img src="https://cdn/logo.png" style="height:40px">',
			),
		).toBe('design');
	});
	it('light text implies a hidden painted surface → design', () => {
		expect(classifyBody('<a style="color:#FFF">CTA</a>')).toBe('design');
	});
	it('own dark-mode rules → design', () => {
		expect(classifyBody('<style>@media (prefers-color-scheme: dark){p{color:#fff}}</style>')).toBe(
			'design',
		);
	});
	it('transparent / inherit never count', () => {
		expect(classifyBody('<p style="background:transparent;color:inherit">x</p>')).toBe('plain');
	});
});

describe('flipColors', () => {
	it('flips black to white and white backgrounds to the sheet', () => {
		const out = flipColors(
			'<div style="color: rgb(0, 0, 0); background-color: rgb(255, 255, 255)">x</div>',
			BG,
		);
		expect(out).toBe(`<div style="color: #ffffff; background-color: ${BG}">x</div>`);
	});
	it('keeps hierarchy: body lighter than muted after the flip', () => {
		const out = flipColors('<p style="color:#393a3d"><span style="color:#6b6c72">m</span></p>', BG);
		const [body, muted] = [...out.matchAll(/color:(#[0-9a-f]{6})/g)].map(
			(m) => toOklch(parseColor(m[1])!).L,
		);
		expect(body).toBeGreaterThan(0.85);
		expect(muted).toBeLessThan(body);
		expect(muted).toBeGreaterThan(0.6);
	});
	it('lifts chromatic colors to a legible floor and keeps hue', () => {
		const out = flipColors('<a style="color:#077dc6">l</a>', BG);
		const rgb = parseColor(out.match(/color:(#[0-9a-f]{6})/)![1])!;
		const o = toOklch(rgb);
		expect(o.L).toBeGreaterThanOrEqual(0.69);
		expect(rgb[2]).toBeGreaterThan(rgb[0]); // still blue
	});
	it('leaves colors that already read on dark, and background-color untouched by the color rule', () => {
		expect(flipColors('<p style="color:#ddd;background-color:#222">x</p>', BG)).toBe(
			'<p style="color:#ddd;background-color:#222">x</p>',
		);
	});
	it('handles <font color> and border shorthand', () => {
		const out = flipColors(
			'<font color="#000000">x</font><hr style="border-top:1px solid #000">',
			BG,
		);
		expect(out).toContain('<font color="#ffffff">');
		expect(out).toContain('border-top:1px solid #ffffff');
	});
});
