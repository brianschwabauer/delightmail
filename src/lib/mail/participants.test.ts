import { describe, it, expect } from 'vitest';
import { participantLabel, parseParticipantText, threadSenderLabel } from './participants';

const me = { emails: ['me@gmail.com'], domains: ['mydomain.com'] };

describe('participantLabel — the sender label on a thread row', () => {
	it('shows the sender by name, not the raw address', () => {
		const label = participantLabel(
			[
				{ name: 'Sarah Chen', email: 'sarah@northwind.co' },
				{ name: undefined, email: 'me@gmail.com' },
			],
			me,
		);
		expect(label).toBe('Sarah Chen');
	});

	it('drops every address you own, so your own name never fills the list', () => {
		const label = participantLabel(
			[
				{ name: 'Priya Patel', email: 'priya@acme.co' },
				{ name: 'Me', email: 'me@gmail.com' },
				{ name: 'Also me', email: 'hello@mydomain.com' }, // catch-all alias
			],
			me,
		);
		expect(label).toBe('Priya Patel');
	});

	it('keeps every other participant, in order (from first)', () => {
		const label = participantLabel(
			[
				{ name: 'Sarah Chen', email: 'sarah@northwind.co' },
				{ name: 'Marcus Webb', email: 'marcus@northwind.co' },
				{ name: undefined, email: 'me@gmail.com' },
			],
			me,
		);
		expect(label).toBe('Sarah Chen, Marcus Webb');
	});

	it('falls back to the address when a participant has no name', () => {
		expect(participantLabel([{ email: 'noreply@stripe.com' }], me)).toBe('noreply@stripe.com');
	});

	it('shows you when the thread is only you (note to self)', () => {
		expect(participantLabel([{ name: 'Me', email: 'me@gmail.com' }], me)).toBe('Me');
	});

	it('dedupes repeated display names', () => {
		const label = participantLabel(
			[
				{ name: 'Support', email: 'support@acme.co' },
				{ name: 'Support', email: 'help@acme.co' },
			],
			me,
		);
		expect(label).toBe('Support');
	});

	it('is empty for a thread with no participants', () => {
		expect(participantLabel(undefined, me)).toBe('');
		expect(participantLabel([], me)).toBe('');
	});

	it('treats every address as "other" when you own none', () => {
		expect(participantLabel([{ name: 'Sarah', email: 'sarah@northwind.co' }])).toBe('Sarah');
	});
});

describe('parseParticipantText — recovering participants from the search blob', () => {
	it('parses "Name email" entries', () => {
		expect(parseParticipantText('Sarah Chen sarah@northwind.co, demo@gmail.com')).toEqual([
			{ name: 'Sarah Chen', email: 'sarah@northwind.co' },
			{ name: undefined, email: 'demo@gmail.com' },
		]);
	});

	it('treats a token with no address as a bare name', () => {
		expect(parseParticipantText('Mom')).toEqual([{ name: 'Mom' }]);
	});

	it('is empty for empty input', () => {
		expect(parseParticipantText('')).toEqual([]);
		expect(parseParticipantText(undefined)).toEqual([]);
	});
});

describe('threadSenderLabel — what a thread row actually renders', () => {
	it('reads the search blob when a hit carries no structured participants', () => {
		const hit = { participant_text: 'Sarah Chen sarah@northwind.co, me@gmail.com' };
		expect(threadSenderLabel(hit, me)).toBe('Sarah Chen');
	});

	it('prefers structured participants when the full row is loaded', () => {
		const row = {
			participants: [{ name: 'Priya Patel', email: 'priya@acme.co' }],
			participant_text: 'ignored ignored@example.com',
		};
		expect(threadSenderLabel(row, me)).toBe('Priya Patel');
	});

	it('renders a comma-containing name correctly despite the lossy split', () => {
		const hit = { participant_text: 'Doe, John john@acme.co, me@gmail.com' };
		expect(threadSenderLabel(hit, me)).toBe('Doe, John');
	});

	it('is empty for a missing thread', () => {
		expect(threadSenderLabel(null, me)).toBe('');
	});
});
