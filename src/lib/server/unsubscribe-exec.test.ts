import { describe, it, expect, vi, afterEach } from 'vitest';
import { executeUnsubscribe } from './triage-endpoints';

/** A minimal fake of the MailboxServer surface the unsubscribe executor touches. */
function fakeDb() {
	const updates: Array<{ id: string; data: Record<string, unknown> }> = [];
	const created: Array<{ table: string; data: Record<string, unknown> }> = [];
	return {
		updates,
		created,
		db: {
			get: (_t: string, _id: string) => ({}),
			update: (_t: string, id: string, data: Record<string, unknown>) => {
				updates.push({ id, data });
				return {};
			},
			create: (table: string, data: Record<string, unknown>) => {
				created.push({ table, data });
				return {};
			},
		},
	};
}

afterEach(() => vi.unstubAllGlobals());

describe('executeUnsubscribe', () => {
	it('marks done on a successful RFC 8058 one-click POST', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })));
		const { db, updates } = fakeDb();
		const r = await executeUnsubscribe(
			db,
			{ id: 't1', method: 'http_oneclick', target: 'https://x/u', sender_domain: 'x.com' },
			false,
		);
		expect(r.ok).toBe(true);
		expect(updates[0].data.status).toBe('done');
		expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].method).toBe('POST');
	});

	it('downgrades to a manual link when the one-click POST fails', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
		const { db, updates } = fakeDb();
		const r = await executeUnsubscribe(
			db,
			{ id: 't2', method: 'http_oneclick', target: 'https://x/u', sender_domain: 'x.com' },
			false,
		);
		expect(r.ok).toBe(false);
		expect(r.manual).toBe('https://x/u');
		expect(updates[0].data.status).toBe('failed');
		expect(updates[0].data.method).toBe('link_manual');
	});

	it('downgrades to a manual link when the request throws', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network'); }));
		const { db, updates } = fakeDb();
		const r = await executeUnsubscribe(
			db,
			{ id: 't3', method: 'http_oneclick', target: 'https://x/u', sender_domain: 'x.com' },
			false,
		);
		expect(r.ok).toBe(false);
		expect(r.manual).toBe('https://x/u');
		expect(updates[0].data.status).toBe('failed');
	});

	it('block also creates a trash sender_rule for the domain', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })));
		const { db, created } = fakeDb();
		const r = await executeUnsubscribe(
			db,
			{ id: 't4', method: 'http_oneclick', target: 'https://x/u', sender_domain: 'spam.com' },
			true,
		);
		expect(r.blocked).toBe(true);
		const rule = created.find((c) => c.table === 'sender_rule');
		expect(rule?.data.action).toBe('trash');
		expect((rule?.data.matcher as { from_domain?: string }).from_domain).toBe('spam.com');
	});
});
