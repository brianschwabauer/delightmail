import { describe, it, expect } from 'vitest';
import {
	normalizeSubject,
	resolveThread,
	SUBJECT_THREAD_WINDOW_MS,
	type ThreadLookups,
	type ThreadCandidate,
} from './threading';

describe('normalizeSubject', () => {
	it('strips a single Re: prefix', () => {
		expect(normalizeSubject('Re: Hello')).toBe('hello');
	});
	it('strips nested Re:/Fwd: prefixes', () => {
		expect(normalizeSubject('Re: Fwd: RE: Quarterly plan')).toBe('quarterly plan');
	});
	it('strips localized and numbered prefixes', () => {
		expect(normalizeSubject('AW: Sujet')).toBe('sujet');
		expect(normalizeSubject('Re[2]: Ticket')).toBe('ticket');
	});
	it('strips leading [list] tags', () => {
		expect(normalizeSubject('[delightstack] PR merged')).toBe('pr merged');
		expect(normalizeSubject('Re: [dev] Build broke')).toBe('build broke');
	});
	it('collapses whitespace and lowercases', () => {
		expect(normalizeSubject('  Hello   World  ')).toBe('hello world');
	});
	it('handles empty / missing subjects', () => {
		expect(normalizeSubject('')).toBe('');
		expect(normalizeSubject(undefined)).toBe('');
		expect(normalizeSubject(null)).toBe('');
	});
	it('does not strip Re inside a word', () => {
		expect(normalizeSubject('Reminder: pay rent')).toBe('reminder: pay rent');
	});
});

function lookups(overrides: Partial<ThreadLookups> = {}): ThreadLookups {
	return {
		byGmailThreadId: () => undefined,
		byMessageId: () => undefined,
		bySubject: () => [],
		...overrides,
	};
}

describe('resolveThread', () => {
	it('joins by Gmail threadId first (highest priority)', () => {
		const res = resolveThread(
			{ gmail_thread_id: 'g123', subject: 'Anything', participant_emails: [], date: 0 },
			lookups({ byGmailThreadId: (id) => (id === 'g123' ? 'thread-1' : undefined) }),
		);
		expect(res).toMatchObject({ thread_id: 'thread-1', reason: 'gmail' });
	});

	it('joins by In-Reply-To when no gmail match', () => {
		const res = resolveThread(
			{ in_reply_to: '<a@x>', subject: 'Re: hi', participant_emails: [], date: 0 },
			lookups({ byMessageId: (id) => (id === '<a@x>' ? 'thread-2' : undefined) }),
		);
		expect(res).toMatchObject({ thread_id: 'thread-2', reason: 'references' });
	});

	it('walks References newest-first', () => {
		const seen: string[] = [];
		const res = resolveThread(
			{ references: ['<old@x>', '<new@x>'], subject: 'Re: hi', participant_emails: [], date: 0 },
			lookups({
				byMessageId: (id) => {
					seen.push(id);
					return id === '<new@x>' ? 'thread-3' : undefined;
				},
			}),
		);
		expect(res.thread_id).toBe('thread-3');
		// Newest reference is checked before older ones.
		expect(seen[0]).toBe('<new@x>');
	});

	it('falls back to subject + overlapping participant within the window', () => {
		const candidate: ThreadCandidate = {
			id: 'thread-4',
			subject_normalized: 'quarterly plan',
			participant_emails: ['sarah@example.com'],
			last_message_at: 1_000_000,
		};
		const res = resolveThread(
			{
				subject: 'Re: Quarterly plan',
				participant_emails: ['sarah@example.com', 'brian@x.com'],
				date: 1_000_000 + 1000,
			},
			lookups({ bySubject: (s) => (s === 'quarterly plan' ? [candidate] : []) }),
		);
		expect(res).toMatchObject({ thread_id: 'thread-4', reason: 'subject' });
	});

	it('does NOT join by subject when participants do not overlap', () => {
		const candidate: ThreadCandidate = {
			id: 'thread-5',
			subject_normalized: 'quarterly plan',
			participant_emails: ['someone@else.com'],
			last_message_at: 1_000_000,
		};
		const res = resolveThread(
			{ subject: 'Re: Quarterly plan', participant_emails: ['brian@x.com'], date: 1_000_100 },
			lookups({ bySubject: () => [candidate] }),
		);
		expect(res.reason).toBe('new');
	});

	it('does NOT join by subject outside the 14-day window', () => {
		const candidate: ThreadCandidate = {
			id: 'thread-6',
			subject_normalized: 'quarterly plan',
			participant_emails: ['sarah@example.com'],
			last_message_at: 0,
		};
		const res = resolveThread(
			{
				subject: 'Re: Quarterly plan',
				participant_emails: ['sarah@example.com'],
				date: SUBJECT_THREAD_WINDOW_MS + 1,
			},
			lookups({ bySubject: () => [candidate] }),
		);
		expect(res.reason).toBe('new');
	});

	it('is case-insensitive on participant overlap', () => {
		const candidate: ThreadCandidate = {
			id: 'thread-7',
			subject_normalized: 'hi',
			participant_emails: ['Sarah@Example.com'],
			last_message_at: 5,
		};
		const res = resolveThread(
			{ subject: 'Re: hi', participant_emails: ['sarah@example.COM'], date: 10 },
			lookups({ bySubject: () => [candidate] }),
		);
		expect(res.thread_id).toBe('thread-7');
	});

	it('creates a new thread when nothing matches', () => {
		const res = resolveThread(
			{ subject: 'Brand new', participant_emails: ['x@y.com'], date: 0 },
			lookups(),
		);
		expect(res).toMatchObject({ reason: 'new', subject_normalized: 'brand new' });
		expect(res.thread_id).toBeUndefined();
	});

	it('picks the most recent candidate when several match', () => {
		const candidates: ThreadCandidate[] = [
			{ id: 'old', subject_normalized: 'hi', participant_emails: ['a@x'], last_message_at: 100 },
			{ id: 'new', subject_normalized: 'hi', participant_emails: ['a@x'], last_message_at: 200 },
		];
		const res = resolveThread(
			{ subject: 'hi', participant_emails: ['a@x'], date: 205 },
			lookups({ bySubject: () => candidates }),
		);
		expect(res.thread_id).toBe('new');
	});
});
