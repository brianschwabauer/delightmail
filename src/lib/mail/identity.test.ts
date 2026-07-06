import { describe, it, expect } from 'vitest';
import { resolveReplyIdentity, resolveComposeIdentity, type IdentityLike } from './identity';

const ids: IdentityLike[] = [
	{ id: '1', email: 'brian@showandtour.com', account_id: 'gmail-1', is_default: true },
	{ id: '2', email: 'brian@brianschwabauer.com', account_id: 'cf-1' },
	{ id: '3', email: 'hello@brianschwabauer.com', account_id: 'cf-1', auto_created: true },
];

describe('resolveReplyIdentity', () => {
	it('prefers the address the message was received as', () => {
		const r = resolveReplyIdentity(ids, { received_as: 'hello@brianschwabauer.com' });
		expect(r?.id).toBe('3');
	});

	it('falls back to an identity in To/Cc', () => {
		const r = resolveReplyIdentity(ids, {
			recipients: [{ email: 'brian@brianschwabauer.com' }],
		});
		expect(r?.id).toBe('2');
	});

	it('falls back to the account default', () => {
		const withAcctDefault: IdentityLike[] = [
			...ids,
			{ id: '4', email: 'other@cf.com', account_id: 'cf-1', is_default: true },
		];
		const r = resolveReplyIdentity(withAcctDefault, { account_id: 'cf-1' });
		expect(r?.account_id).toBe('cf-1');
		expect(r?.is_default).toBe(true);
	});

	it('falls back to the global default when nothing matches', () => {
		const r = resolveReplyIdentity(ids, { received_as: 'nobody@nowhere.com' });
		expect(r?.id).toBe('1');
	});

	it('returns undefined when there are no identities', () => {
		expect(resolveReplyIdentity([], {})).toBeUndefined();
	});
});

describe('resolveComposeIdentity', () => {
	it('uses the last-used identity when available', () => {
		expect(resolveComposeIdentity(ids, '2')?.id).toBe('2');
	});
	it('falls back to the default', () => {
		expect(resolveComposeIdentity(ids, 'nonexistent')?.id).toBe('1');
	});
	it('falls back to the first when no default', () => {
		const noDefault = ids.map((i) => ({ ...i, is_default: false }));
		expect(resolveComposeIdentity(noDefault)?.id).toBe('1');
	});
});
