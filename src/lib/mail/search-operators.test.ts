import { describe, it, expect } from 'vitest';
import { parseSearchInput, hasOperators } from './search-operators';

describe('parseSearchInput', () => {
	it('plain text passes through unchanged', () => {
		const p = parseSearchInput('quarterly invoice');
		expect(p.term).toBe('quarterly invoice');
		expect(hasOperators(p)).toBe(false);
	});

	it('extracts from:', () => {
		const p = parseSearchInput('from:alice@example.com invoice');
		expect(p.from).toBe('alice@example.com');
		expect(p.term).toBe('invoice');
	});

	it('extracts has:attachment / is:unread / is:starred', () => {
		const p = parseSearchInput('has:attachment is:unread is:starred report');
		expect(p.hasAttachment).toBe(true);
		expect(p.unread).toBe(true);
		expect(p.starred).toBe(true);
		expect(p.term).toBe('report');
	});

	it('extracts in:<folder> for known folders only', () => {
		expect(parseSearchInput('in:archive tax').folder).toBe('archive');
		const unknown = parseSearchInput('in:nowhere tax');
		expect(unknown.folder).toBeUndefined();
		expect(unknown.term).toBe('in:nowhere tax');
	});

	it('unknown operator values stay searchable as text', () => {
		const p = parseSearchInput('is:blue has:cheese');
		expect(hasOperators(p)).toBe(false);
		expect(p.term).toBe('is:blue has:cheese');
	});

	it('operators alone leave an empty term', () => {
		const p = parseSearchInput('is:unread');
		expect(p.term).toBe('');
		expect(p.unread).toBe(true);
	});

	it('is case-insensitive on the operator, preserves term case', () => {
		const p = parseSearchInput('FROM:Bob Hello World');
		expect(p.from).toBe('bob');
		expect(p.term).toBe('Hello World');
	});
});
