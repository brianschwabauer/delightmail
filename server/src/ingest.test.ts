import { describe, it, expect } from 'vitest';
import { ingestBatch, type DbLike, type NormalizedMessage } from './ingest';

/**
 * An in-memory fake of the MailboxServer surface ingest uses. It emulates just
 * the queries ingest issues (idempotency, gmail-thread lookup, subject lookup)
 * plus create/get/update over two tables.
 */
function fakeDb() {
	const stores: Record<string, Record<string, Record<string, unknown>>> = {
		thread: {},
		message: {},
		contact: {},
		attachment: {},
		label: {},
	};
	const threads = stores.thread;
	const messages = stores.message;
	const contacts = stores.contact;
	let seq = 0;
	const id = (p: string) => `${p}-${++seq}`;
	const storeFor = (entity: string) => (stores[entity] ??= {});

	const db: DbLike = {
		exec(sql, ...bindings) {
			if (/FROM message\s+WHERE rfc822_message_id = \? AND account_id = \? LIMIT 1/.test(sql)) {
				const m = Object.values(messages).find(
					(r) => r.rfc822_message_id === bindings[0] && r.account_id === bindings[1],
				);
				return m ? [{ id: m.id, thread_id: m.thread_id }] : [];
			}
			if (/FROM contact WHERE email = \?/.test(sql)) {
				const c = Object.values(contacts).find((r) => r.email === bindings[0]);
				return c ? [{ id: c.id, send_count: c.send_count, receive_count: c.receive_count }] : [];
			}
			if (/FROM label WHERE name = \?/.test(sql)) {
				const l = Object.values(storeFor('label')).find((r) => r.name === bindings[0]);
				return l ? [{ id: l.id, json: JSON.stringify(l) }] : [];
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
			const row = storeFor(entity)[String(gid)];
			if (!row) throw new Error(`not found ${entity} ${gid}`);
			return row;
		},
		create(entity, data) {
			const store = storeFor(entity);
			const gid = id(entity);
			store[gid] = { ...data, id: gid };
			return store[gid];
		},
		update(entity, gid, data) {
			const store = storeFor(entity);
			store[String(gid)] = { ...store[String(gid)], ...data };
			return store[String(gid)];
		},
	};

	return { db, threads, messages, contacts, attachments: stores.attachment, labels: stores.label };
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

	it('keeps the same message delivered to two accounts as two rows (per-account dedupe)', () => {
		const { db, messages } = fakeDb();
		const r1 = ingestBatch(db, [msg({ rfc822_message_id: '<shared@x>', account_id: 'acc-1' })]);
		const r2 = ingestBatch(db, [msg({ rfc822_message_id: '<shared@x>', account_id: 'acc-2' })]);
		expect(r1.ingested).toBe(1);
		expect(r2.ingested).toBe(1);
		expect(Object.keys(messages)).toHaveLength(2);
	});

	it('backfills provider ids on re-delivery of an already-ingested message', () => {
		const { db, messages } = fakeDb();
		ingestBatch(db, [msg({ rfc822_message_id: '<pid@x>', account_id: 'acc-1' })]);
		ingestBatch(db, [
			msg({ rfc822_message_id: '<pid@x>', account_id: 'acc-1', provider_ids: { gmail_id: 'G9' } }),
		]);
		const m = Object.values(messages).find((r) => r.rfc822_message_id === '<pid@x>');
		expect((m?.provider_ids as { gmail_id?: string })?.gmail_id).toBe('G9');
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

	it('records the sender as a contact (received, not yet known) on inbound mail', () => {
		const { db, contacts } = fakeDb();
		ingestBatch(db, [msg({ rfc822_message_id: '<c1@x>', from: { name: 'Ann', email: 'ann@x.com' } })]);
		const c = Object.values(contacts).find((r) => r.email === 'ann@x.com');
		expect(c?.receive_count).toBe(1);
		expect(c?.is_known_correspondent).toBe(false);
	});

	it('marks recipients of outbound mail as known correspondents', () => {
		const { db, contacts } = fakeDb();
		ingestBatch(db, [
			msg({ rfc822_message_id: '<c2@x>', is_outbound: true, folder: 'sent', to: [{ email: 'boss@x.com' }] }),
		]);
		const c = Object.values(contacts).find((r) => r.email === 'boss@x.com');
		expect(c?.send_count).toBe(1);
		expect(c?.is_known_correspondent).toBe(true);
	});

	it('creates attachment rows for a message with attachments', () => {
		const { db, attachments } = fakeDb();
		ingestBatch(db, [
			msg({
				rfc822_message_id: '<a1@x>',
				attachment_count: 1,
				attachments: [
					{ filename: 'a.pdf', mime_type: 'application/pdf', size_bytes: 10, r2_key: 'org/msg/h/att/0' },
				],
			}),
		]);
		const rows = Object.values(attachments);
		expect(rows).toHaveLength(1);
		expect(rows[0].filename).toBe('a.pdf');
		expect(rows[0].r2_key).toBe('org/msg/h/att/0');
	});

	it('maps user provider-labels onto label rows with provider_map + thread.label_ids', () => {
		const { db, threads, labels } = fakeDb();
		ingestBatch(db, [
			msg({
				rfc822_message_id: '<l1@x>',
				account_id: 'acc-1',
				labels: [{ name: 'Work', provider_id: 'Label_7' }],
			}),
		]);
		const label = Object.values(labels)[0];
		expect(label.name).toBe('Work');
		expect((label.provider_map as Array<{ provider_id: string }>)[0].provider_id).toBe('Label_7');
		const thread = Object.values(threads)[0];
		expect((thread.label_ids as string[])).toContain(label.id);
	});

	it('reuses an existing label and adds a second account to its provider_map', () => {
		const { db, labels } = fakeDb();
		ingestBatch(db, [msg({ rfc822_message_id: '<l2@x>', account_id: 'acc-1', labels: [{ name: 'Work', provider_id: 'A1' }] })]);
		ingestBatch(db, [msg({ rfc822_message_id: '<l3@x>', account_id: 'acc-2', labels: [{ name: 'Work', provider_id: 'B2' }] })]);
		expect(Object.keys(labels)).toHaveLength(1);
		const pm = Object.values(labels)[0].provider_map as Array<{ account_id: string }>;
		expect(pm.map((p) => p.account_id).sort()).toEqual(['acc-1', 'acc-2']);
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
