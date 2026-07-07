import { describe, it, expect } from 'vitest';
import {
	mintMessageId,
	buildReferences,
	replySubject,
	replyAllRecipients,
	quoteText,
	docToText,
	mergeSignatureDoc,
	buildQuoteDoc,
} from './compose';

const para = (t: string) => ({ type: 'paragraph', content: [{ type: 'text', text: t }] });

describe('docToText', () => {
	it('flattens paragraphs to newline-separated text', () => {
		const doc = { type: 'doc', content: [para('hello'), para('world')] };
		expect(docToText(doc).trim()).toBe('hello\nworld');
	});
});

describe('mergeSignatureDoc', () => {
	it('appends the signature below a -- marker without touching the body', () => {
		const body = { type: 'doc', content: [para('my message')] };
		const sig = { type: 'doc', content: [para('Brian')] };
		const merged = mergeSignatureDoc(body, sig);
		expect(merged.content?.[0]).toEqual(para('my message'));
		expect(docToText(merged)).toContain('-- ');
		expect(docToText(merged)).toContain('Brian');
	});
	it('is a no-op when there is no signature', () => {
		const body = { type: 'doc', content: [para('x')] };
		expect(mergeSignatureDoc(body, null).content).toHaveLength(1);
	});
});

describe('buildQuoteDoc', () => {
	it('produces an empty paragraph then a blockquote with attribution', () => {
		const doc = buildQuoteDoc({ from: { name: 'Ann', email: 'a@x' }, date: 0, text: 'hi\nthere' });
		expect(doc.content?.[0]).toEqual({ type: 'paragraph' });
		expect(doc.content?.[1]?.type).toBe('blockquote');
		expect(docToText(doc)).toContain('Ann');
		expect(docToText(doc)).toContain('hi');
	});
});

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
