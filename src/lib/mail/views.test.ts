import { describe, it, expect } from 'vitest';
import { viewToQuery, viewTitle } from './views';

describe('viewToQuery', () => {
	it('maps inbox to a folder eq filter ordered by last_message_at', () => {
		const q = viewToQuery('inbox');
		expect(q.where).toEqual({ folder: { eq: 'inbox' } });
		expect(q.order).toEqual([{ key: 'last_message_at', direction: 'DESC' }]);
	});

	it('maps filtered to the quarantine folder', () => {
		expect(viewToQuery('filtered').where).toEqual({ folder: { eq: 'quarantine' } });
	});

	it('maps starred to a boolean filter', () => {
		expect(viewToQuery('starred').where).toEqual({ starred: true });
	});

	it('maps sent/drafts/archive/spam/trash to their folders', () => {
		for (const v of ['sent', 'drafts', 'archive', 'spam', 'trash']) {
			expect(viewToQuery(v).where).toEqual({ folder: { eq: v } });
		}
	});

	it('applies an account scope filter when given', () => {
		const q = viewToQuery('inbox', { account_id: 'acc-1' });
		expect(q.where).toEqual({ folder: { eq: 'inbox' }, account_ids: 'acc-1' });
	});

	it('maps search to a term query', () => {
		const q = viewToQuery('search', { term: 'invoice' });
		expect(q.term).toBe('invoice');
	});

	it('maps label/<id> to a label filter', () => {
		expect(viewToQuery('label/work').where).toEqual({ label_ids: 'work' });
	});

	it('falls back to inbox for unknown views', () => {
		expect(viewToQuery('nonsense').where).toEqual({ folder: { eq: 'inbox' } });
	});
});

describe('viewTitle', () => {
	it('returns friendly titles', () => {
		expect(viewTitle('inbox')).toBe('Inbox');
		expect(viewTitle('filtered')).toBe('AI Filtered');
		expect(viewTitle('label/x')).toBe('Label');
	});
});
