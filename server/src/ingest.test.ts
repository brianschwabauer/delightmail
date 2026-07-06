import { describe, it, expect } from 'vitest';
import { ingestBatch, type DbLike, type NormalizedMessage } from './ingest';

/**
 * An in-memory fake of the MailboxServer surface ingest uses. It emulates just
 * the queries ingest issues (idempotency, gmail-thread lookup, subject lookup)
 * plus create/get/update over two tables.
 */
function fakeDb() {
	const threads: Record<string, Record<string, unknown>> = {};
	const messages: Record<string, Record<string, unknown>> = {};
	let seq = 0;
	const id = (p: string) => `${p}-${++seq}`;

	const db: DbLike = {
		exec(sql, ...bindings) {
			if (/FROM message WHERE rfc822_message_id = \? LIMIT 1/.test(sql)) {
				const m = Object.values(messages).find((r) => r.rfc822_message_id === bindings[0]);
				return m ? [{ id: m.id, thread_id: m.thread_id }] : [];
			}
			if (/json_extract\(json, '\$\.provider_ids\.gmail_thread_id'\)/.test(sql)) {
				const m = Object.values(messages).find(
					(r) => (r.provider_ids as { gmail_thread_id?: string })?.gmail_thread_id === bindings[0],
				);
				return m ? [{ thread_id: m.thread_id }] : [];
			}
			if (/FROM thread\s+WHERE subject_normalized = \?/.test(sql)) {
				return Object.values(threads)
					.filter((t) => t.subject_normalized === bindings[0])
					.map((t) => ({
						id: t.id,
						last_message_at: t.last_message_at,
						json: JSON.stringify({ participants: t.participants ?? [] }),
					}));
			}
			return [];
		},
		get(entity, gid) {
			const store = entity === 'thread' ? threads : messages;
			const row = store[String(gid)];
			if (!row) throw new Error(`not found ${entity} ${gid}`);
			return row;
		},
		create(entity, data) {
			const store = entity === 'thread' ? threads : messages;
			const gid = id(entity);
			store[gid] = { ...data, id: gid };
			return store[gid];
		},
		update(entity, gid, data) {
			const store = entity === 'thread' ? threads : messages;
			store[String(gid)] = { ...store[String(gid)], ...data };
			return store[String(gid)];
		},
	};

	return { db, threads, messages };
}

function msg(overrides: Partial<NormalizedMessage>): NormalizedMessage {
	return {
		rfc822_message_id: `<${Math.random()}@x>`,
		account_id: 'acc-1',
		subject: 'Hello',
		date: 1_000_000,
		from: { name: 'A', email: 'a@x.com' },
		to: [{ email: 'me@x.com' }],
		references: [],
		...overrides,
	};
}

describe('ingestBatch', () => {
	it('creates a thread and message for a new email', () => {
		const { db, threads, messages } = fakeDb();
		const res = ingestBatch(db, [msg({ rfc822_message_id: '<1@x>', subject: 'Q3 plan' })]);
		expect(res.ingested).toBe(1);
		expect(Object.keys(threads)).toHaveLength(1);
		expect(Object.keys(messages)).toHaveLength(1);
	});

	it('is idempotent on rfc822_message_id (re-delivery is a no-op)', () => {
		const { db } = fakeDb();
		const m = msg({ rfc822_message_id: '<dup@x>' });
		const r1 = ingestBatch(db, [m]);
		const r2 = ingestBatch(db, [m]);
		expect(r1.ingested).toBe(1);
		expect(r2.ingested).toBe(0);
		expect(r2.skipped).toBe(1);
	});

	it('threads a reply into the parent via In-Reply-To', () => {
		const { db, threads } = fakeDb();
		ingestBatch(db, [msg({ rfc822_message_id: '<p@x>', subject: 'Plan' })]);
		ingestBatch(db, [
			msg({
				rfc822_message_id: '<r@x>',
				subject: 'Re: Plan',
				in_reply_to: '<p@x>',
				date: 1_000_500,
			}),
		]);
		expect(Object.keys(threads)).toHaveLength(1);
		const t = Object.values(threads)[0];
		expect(t.message_count).toBe(2);
	});

	it('threads by Gmail threadId across messages', () => {
		const { db, threads } = fakeDb();
		ingestBatch(db, [msg({ rfc822_message_id: '<g1@x>', gmail_thread_id: 'T1', provider_ids: { gmail_thread_id: 'T1' } })]);
		ingestBatch(db, [msg({ rfc822_message_id: '<g2@x>', gmail_thread_id: 'T1', provider_ids: { gmail_thread_id: 'T1' } })]);
		expect(Object.keys(threads)).toHaveLength(1);
	});

	it('increments unread_count only for unread inbound messages', () => {
		const { db, threads } = fakeDb();
		ingestBatch(db, [msg({ rfc822_message_id: '<u1@x>', is_read: false })]);
		const t = Object.values(threads)[0];
		expect(t.unread_count).toBe(1);
	});

	it('does not count outbound (sent) messages as unread', () => {
		const { db, threads } = fakeDb();
		ingestBatch(db, [msg({ rfc822_message_id: '<o1@x>', is_outbound: true, folder: 'sent' })]);
		const t = Object.values(threads)[0];
		expect(t.unread_count).toBe(0);
	});

	it('merges participants across messages in a thread', () => {
		const { db, threads } = fakeDb();
		ingestBatch(db, [msg({ rfc822_message_id: '<m1@x>', subject: 'Chat', from: { email: 'a@x.com' } })]);
		ingestBatch(db, [
			msg({
				rfc822_message_id: '<m2@x>',
				subject: 'Re: Chat',
				in_reply_to: '<m1@x>',
				from: { email: 'b@x.com' },
				date: 1_000_500,
			}),
		]);
		const t = Object.values(threads)[0];
		const emails = (t.participants as Array<{ email: string }>).map((p) => p.email);
		expect(emails).toContain('a@x.com');
		expect(emails).toContain('b@x.com');
	});
});
