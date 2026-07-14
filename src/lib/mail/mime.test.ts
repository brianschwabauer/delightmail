import { describe, it, expect } from 'vitest';
import {
	normalizeAddress,
	normalizeAddressList,
	parseReferences,
	extractHeadersSubset,
	htmlToPlainText,
	normalizeDate,
	toExcerpt,
	parseEmail,
} from './mime';

describe('normalizeAddress', () => {
	it('maps a mailbox to {name,email}', () => {
		expect(normalizeAddress({ name: 'Sarah Chen', address: 'sarah@example.com' })).toEqual({
			name: 'Sarah Chen',
			email: 'sarah@example.com',
		});
	});
	it('drops empty name', () => {
		expect(normalizeAddress({ name: '', address: 'x@y.com' })).toEqual({
			name: undefined,
			email: 'x@y.com',
		});
	});
	it('flattens a group to its first member', () => {
		expect(
			normalizeAddress({ name: 'Team', group: [{ name: 'A', address: 'a@x' }] } as never),
		).toEqual({ name: 'A', email: 'a@x' });
	});
	it('returns undefined for nothing', () => {
		expect(normalizeAddress(undefined)).toBeUndefined();
	});
});

describe('normalizeAddressList', () => {
	it('flattens groups and mailboxes together', () => {
		const out = normalizeAddressList([
			{ name: 'A', address: 'a@x' },
			{ name: 'G', group: [{ name: 'B', address: 'b@x' }] },
		] as never);
		expect(out).toEqual([
			{ name: 'A', email: 'a@x' },
			{ name: 'B', email: 'b@x' },
		]);
	});
});

describe('parseReferences', () => {
	it('splits angle-bracketed message ids', () => {
		expect(parseReferences('<a@x> <b@y>')).toEqual(['<a@x>', '<b@y>']);
	});
	it('returns [] for empty', () => {
		expect(parseReferences(undefined)).toEqual([]);
	});
});

describe('extractHeadersSubset', () => {
	it('pulls list + auth headers and spam verdicts', () => {
		const h = extractHeadersSubset([
			{ key: 'List-Unsubscribe', value: '<https://x/u>' },
			{ key: 'List-Id', value: 'news.example.com' },
			{ key: 'Authentication-Results', value: 'mx.google.com; spf=pass dkim=pass dmarc=fail' },
		]);
		expect(h.list_unsubscribe).toBe('<https://x/u>');
		expect(h.list_id).toBe('news.example.com');
		expect(h.spf).toBe('pass');
		expect(h.dkim).toBe('pass');
		expect(h.dmarc).toBe('fail');
	});
});

describe('htmlToPlainText', () => {
	it('strips tags and decodes entities', () => {
		expect(htmlToPlainText('<p>Hello&nbsp;<b>world</b> &amp; more</p>')).toBe(
			'Hello world & more',
		);
	});
	it('removes script/style content', () => {
		expect(htmlToPlainText('<style>a{}</style><script>evil()</script><p>ok</p>')).toBe('ok');
	});
	it('turns block ends into newlines', () => {
		expect(htmlToPlainText('<div>a</div><div>b</div>')).toBe('a\nb');
	});
});

describe('normalizeDate', () => {
	it('parses a valid date', () => {
		expect(normalizeDate('Wed, 01 Jan 2025 00:00:00 GMT')).toBe(Date.parse('2025-01-01T00:00:00Z'));
	});
	it('clamps a far-future date to receipt time', () => {
		const now = 1_000_000_000_000;
		expect(normalizeDate('Wed, 01 Jan 2099 00:00:00 GMT', now)).toBe(now);
	});
	it('falls back to receipt time on garbage', () => {
		const now = 42;
		expect(normalizeDate('not a date', now)).toBe(now);
		expect(normalizeDate(undefined, now)).toBe(now);
	});
});

describe('toExcerpt', () => {
	it('returns short text unchanged', () => {
		expect(toExcerpt('hello')).toBe('hello');
	});
	it('caps very long text near 8KB', () => {
		const long = 'x'.repeat(20000);
		expect(toExcerpt(long).length).toBeLessThanOrEqual(8192);
	});
});

const SAMPLE_EML = [
	'From: Sarah Chen <sarah@example.com>',
	'To: me@example.com',
	'Cc: Team <team@example.com>',
	'Subject: Re: Q3 planning doc',
	'Message-ID: <msg-123@example.com>',
	'In-Reply-To: <msg-100@example.com>',
	'References: <msg-90@example.com> <msg-100@example.com>',
	'List-Unsubscribe: <https://example.com/unsub>',
	'Date: Wed, 01 Jan 2025 09:41:00 GMT',
	'Content-Type: text/plain; charset=utf-8',
	'',
	'Hey Brian — one more thought on the timeline.',
	'',
].join('\r\n');

describe('parseEmail', () => {
	it('parses a real .eml into normalized fields', async () => {
		const p = await parseEmail(SAMPLE_EML);
		expect(p.rfc822_message_id).toBe('<msg-123@example.com>');
		expect(p.from).toEqual({ name: 'Sarah Chen', email: 'sarah@example.com' });
		expect(p.to[0].email).toBe('me@example.com');
		expect(p.cc[0].email).toBe('team@example.com');
		expect(p.subject).toBe('Re: Q3 planning doc');
		expect(p.in_reply_to).toBe('<msg-100@example.com>');
		expect(p.references).toEqual(['<msg-90@example.com>', '<msg-100@example.com>']);
		expect(p.headers_subset.list_unsubscribe).toBe('<https://example.com/unsub>');
		expect(p.text).toContain('one more thought');
		expect(p.date).toBe(Date.parse('2025-01-01T09:41:00Z'));
	});

	it('synthesizes a stable message id when none is present', async () => {
		const noId = SAMPLE_EML.replace('Message-ID: <msg-123@example.com>\r\n', '');
		const p1 = await parseEmail(noId, { receivedAt: 1000 });
		const p2 = await parseEmail(noId, { receivedAt: 1000 });
		expect(p1.rfc822_message_id).toMatch(/^<synthetic-/);
		expect(p1.rfc822_message_id).toBe(p2.rfc822_message_id);
	});
});
