import { describe, it, expect } from 'vitest';
import {
	mintMessageId,
	buildReferences,
	replySubject,
	replyAllRecipients,
	quoteText,
} from './compose';

describe('mintMessageId', () => {
	it('uses the sender domain', () => {
		expect(mintMessageId('brian@example.com', 'abc')).toBe('<abc@example.com>');
	});
	it('falls back to a local domain', () => {
		expect(mintMessageId('bogus', 'abc')).toBe('<abc@delightmail.local>');
	});
});

describe('buildReferences', () => {
	it('appends in-reply-to to the chain', () => {
		expect(buildReferences(['<a@x>'], '<b@x>')).toEqual(['<a@x>', '<b@x>']);
	});
	it('does not duplicate', () => {
		expect(buildReferences(['<a@x>'], '<a@x>')).toEqual(['<a@x>']);
	});
	it('handles no parent references', () => {
		expect(buildReferences(undefined, '<b@x>')).toEqual(['<b@x>']);
	});
});

describe('replySubject', () => {
	it('adds Re: without doubling', () => {
		expect(replySubject('Hello', 'reply')).toBe('Re: Hello');
		expect(replySubject('Re: Hello', 'reply')).toBe('Re: Hello');
	});
	it('adds Fwd: and strips existing prefix', () => {
		expect(replySubject('Re: Hello', 'forward')).toBe('Fwd: Hello');
	});
});

describe('replyAllRecipients', () => {
	it('replies to the sender, ccs the rest, excludes self', () => {
		const r = replyAllRecipients(
			{
				from: { email: 'sarah@x.com' },
				to: [{ email: 'me@x.com' }, { email: 'bob@x.com' }],
				cc: [{ email: 'carol@x.com' }],
			},
			['me@x.com'],
		);
		expect(r.to.map((a) => a.email)).toEqual(['sarah@x.com']);
		expect(r.cc.map((a) => a.email).sort()).toEqual(['bob@x.com', 'carol@x.com']);
	});
	it('prefers reply-to over from', () => {
		const r = replyAllRecipients(
			{ from: { email: 'noreply@x.com' }, reply_to: [{ email: 'real@x.com' }] },
			[],
		);
		expect(r.to.map((a) => a.email)).toEqual(['real@x.com']);
	});
});

describe('quoteText', () => {
	it('prefixes each line with >', () => {
		const q = quoteText('line1\nline2', { name: 'Sarah' }, 0);
		expect(q).toContain('> line1');
		expect(q).toContain('> line2');
		expect(q).toContain('Sarah wrote:');
	});
});
