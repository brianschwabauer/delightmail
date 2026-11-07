import { describe, it, expect } from 'vitest';
import { accountColor, accountDetails } from './account-color';

describe('accountColor', () => {
	it('keeps an explicit colour', () => {
		expect(accountColor('a', '#ff0000')).toBe('#ff0000');
	});

	it('derives a stable colour from the id', () => {
		expect(accountColor('acct-1')).toBe(accountColor('acct-1'));
		expect(accountColor('acct-1')).toMatch(/^oklch\(/);
	});

	it('spreads different accounts across different hues', () => {
		const colours = new Set(['a1', 'b2', 'c3', 'd4', 'e5', 'f6'].map((id) => accountColor(id)));
		expect(colours.size).toBeGreaterThan(2);
	});
});

describe('accountDetails', () => {
	it('says nothing when every label is unique', () => {
		expect(
			accountDetails([
				{ id: '1', label: 'me@gmail.com', kind: 'gmail' },
				{ id: '2', label: 'example.com', kind: 'cf_domain' },
			]).size,
		).toBe(0);
	});

	it('tells the same address apart by protocol', () => {
		const d = accountDetails([
			{ id: '1', label: 'me@work.com', kind: 'gmail' },
			{ id: '2', label: 'Me@Work.com', kind: 'imap' },
		]);
		expect(d.get('1')).toBe('Gmail');
		expect(d.get('2')).toBe('IMAP');
	});

	it('numbers the same address connected twice the same way (or when the kind is unknown)', () => {
		const d = accountDetails([
			{ id: '1', label: 'demo@gmail.com', kind: 'gmail' },
			{ id: '2', label: 'demo@gmail.com', kind: 'gmail' },
			{ id: '3', label: 'other@gmail.com', kind: 'gmail' },
		]);
		expect(d.get('1')).toBe('1');
		expect(d.get('2')).toBe('2');
		expect(d.has('3')).toBe(false);
	});
});
