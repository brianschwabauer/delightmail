/**
 * DB-integrated ingest orchestration. Takes normalized messages from the
 * sync adapters / email() handler and writes them into MailboxServer:
 *   raw/body already in R2 → metadata + excerpt into SQLite → threading →
 *   counters. Idempotent on rfc822_message_id (unique index).
 *
 * The pure threading algorithm lives in src/lib/mail/threading.ts.
 */
import type { Address } from '../../src/lib/schema';
import {
	resolveThread,
	normalizeSubject,
	type ThreadCandidate,
	type ThreadLookups,
} from '../../src/lib/mail/threading';

/** A source-agnostic message ready for ingest. */
export interface NormalizedMessage {
	rfc822_message_id: string;
	account_id: string;
	identity_email?: string;
	gmail_thread_id?: string;
	in_reply_to?: string;
	references?: string[];
	provider_ids?: Record<string, unknown>;
	from?: Address;
	to?: Address[];
	cc?: Address[];
	bcc?: Address[];
	reply_to?: Address[];
	subject?: string;
	snippet?: string;
	text_excerpt?: string;
	body_keys?: { raw?: string; html?: string; text?: string };
	date: number;
	is_read?: boolean;
	is_starred?: boolean;
	is_outbound?: boolean;
	folder?: string;
	headers_subset?: Record<string, unknown>;
	attachments?: Array<{
		filename: string;
		mime_type: string;
		size_bytes: number;
		content_id?: string;
		r2_key: string;
	}>;
	/** User (non-system) provider labels to map onto DelightMail labels. */
	labels?: Array<{ name: string; provider_id: string }>;
	attachment_count?: number;
	size_bytes?: number;
}

/** The subset of MailboxServer methods ingest uses (structural, avoids cycles). */
export interface DbLike {
	exec(sql: string, ...bindings: unknown[]): Array<Record<string, unknown>>;
	get(entity_type: string, id: string | number): Record<string, unknown>;
	create(entity_type: string, data: Record<string, unknown>): Record<string, unknown>;
	update(
		entity_type: string,
		id: string | number,
		data: Record<string, unknown>,
	): Record<string, unknown>;
}

export interface IngestResult {
	ingested: number;
	skipped: number;
	new_messages: Array<{
		id: string;
		thread_id: string;
		folder: string;
		from?: Address;
		subject?: string;
		is_outbound: boolean;
	}>;
}

export function ingestBatch(db: DbLike, batch: NormalizedMessage[]): IngestResult {
	const result: IngestResult = { ingested: 0, skipped: 0, new_messages: [] };

	for (const msg of batch) {
		// Idempotency is PER-ACCOUNT: the same message delivered to two
		// connected accounts stays two rows. Scoping the check by account_id is
		// what keeps the Gmail→DelightMail migration overlap from collapsing.
		const existing = db.exec(
			`SELECT id, thread_id FROM message
			 WHERE rfc822_message_id = ? AND account_id = ? LIMIT 1`,
			msg.rfc822_message_id,
			msg.account_id,
		) as Array<{ id: string; thread_id: string }>;
		if (existing.length) {
			result.skipped++;
			reconcileExistingMessage(db, existing[0], msg);
			continue;
		}

		const participants = collectParticipants(msg);
		const participant_emails = participants.map((p) => p.email ?? '').filter(Boolean);

		const lookups = makeLookups(db);
		const decision = resolveThread(
			{
				gmail_thread_id: msg.gmail_thread_id,
				in_reply_to: msg.in_reply_to,
				references: msg.references,
				subject: msg.subject,
				participant_emails,
				date: msg.date,
			},
			lookups,
		);

		const folder = (msg.folder ?? (msg.is_outbound ? 'sent' : 'inbox')) as string;
		// Resolve user provider-labels to DelightMail label rows (with provider_map).
		const label_ids = resolveLabelIds(db, msg);

		// Thread create + message insert + counter update must land together.
		// DatabaseServer.transaction is a *declarative batch* API and can't express
		// "create thread → reference its new id → update its counters", so we rely on
		// the DO's single-threaded, synchronous execution: this block runs to
		// completion with no interleaving, which is the atomicity guarantee we need.
		const run = (): { message_id: string; thread_id: string } => {
			let thread_id = decision.thread_id;
			if (!thread_id) {
				const thread = db.create('thread', {
					subject: msg.subject ?? '(no subject)',
					subject_normalized: decision.subject_normalized,
					snippet: msg.snippet ?? msg.text_excerpt?.slice(0, 120),
					participants,
					participant_text: participantText(participants),
					account_ids: [msg.account_id],
					message_count: 0,
					unread_count: 0,
					starred: msg.is_starred ?? false,
					has_attachments: (msg.attachment_count ?? 0) > 0,
					folder,
					last_message_at: msg.date,
					label_ids: label_ids.length ? label_ids : undefined,
					gmail_thread_ids: msg.gmail_thread_id
						? [{ account_id: msg.account_id, thread_id: msg.gmail_thread_id }]
						: undefined,
				});
				thread_id = thread.id as string;
			}

			const created = db.create('message', {
				thread_id,
				account_id: msg.account_id,
				identity_email: msg.identity_email,
				rfc822_message_id: msg.rfc822_message_id,
				in_reply_to: msg.in_reply_to,
				references: msg.references,
				provider_ids: msg.provider_ids,
				from: msg.from,
				from_text: msg.from ? addressText(msg.from) : undefined,
				to: msg.to,
				cc: msg.cc,
				bcc: msg.bcc,
				reply_to: msg.reply_to,
				subject: msg.subject,
				text_excerpt: msg.text_excerpt?.slice(0, 8192),
				body_keys: msg.body_keys,
				date: msg.date,
				is_read: msg.is_read ?? !!msg.is_outbound,
				is_starred: msg.is_starred ?? false,
				is_outbound: msg.is_outbound ?? false,
				folder,
				headers_subset: msg.headers_subset,
				attachment_count: msg.attachment_count ?? 0,
				size_bytes: msg.size_bytes ?? 0,
			});

			updateThreadCounters(db, thread_id, msg, participants, label_ids);

			// Attachment rows (bytes already in R2) for the reading-pane chips.
			for (const att of msg.attachments ?? []) {
				db.create('attachment', {
					message_id: created.id,
					filename: att.filename,
					mime_type: att.mime_type,
					size_bytes: att.size_bytes,
					content_id: att.content_id,
					r2_key: att.r2_key,
				});
			}
			return { message_id: created.id as string, thread_id };
		};
		const { message_id, thread_id } = run();

		// Contact autocomplete + the known-correspondent guardrail depend on this
		// running — without it the contact table stays empty and the guard
		// never fires. Inbound records the sender; outbound records recipients.
		maintainContacts(db, msg);

		result.ingested++;
		result.new_messages.push({
			id: message_id,
			thread_id,
			folder,
			from: msg.from,
			subject: msg.subject,
			is_outbound: msg.is_outbound ?? false,
		});
	}

	return result;
}

function makeLookups(db: DbLike): ThreadLookups {
	return {
		byGmailThreadId(gmail_thread_id) {
			const rows = db.exec(
				`SELECT thread_id FROM message
				 WHERE json_extract(json, '$.provider_ids.gmail_thread_id') = ? LIMIT 1`,
				gmail_thread_id,
			);
			return rows[0]?.thread_id as string | undefined;
		},
		byMessageId(rfc822_message_id) {
			const rows = db.exec(
				`SELECT thread_id FROM message WHERE rfc822_message_id = ? LIMIT 1`,
				rfc822_message_id,
			);
			return rows[0]?.thread_id as string | undefined;
		},
		bySubject(subject_normalized) {
			const rows = db.exec(
				`SELECT id, last_message_at, json FROM thread
				 WHERE subject_normalized = ? ORDER BY last_message_at DESC LIMIT 20`,
				subject_normalized,
			);
			return rows.map((r) => {
				const json = safeJson(r.json as string);
				const parts = (json.participants as Address[] | undefined) ?? [];
				return {
					id: r.id as string,
					subject_normalized,
					participant_emails: parts.map((p) => p.email ?? '').filter(Boolean),
					last_message_at: (r.last_message_at as number) ?? 0,
				} satisfies ThreadCandidate;
			});
		},
	};
}

/**
 * Reconcile an already-ingested message against a re-fetched copy (resync,
 * 404-recovery, backfill overlap). The dedup skip used to only backfill provider
 * ids and discard the authoritative flag/folder state, so read/archived changes
 * made while the history cursor was stale could never be repaired.
 * Note: a re-fetch that races an in-flight local action can momentarily revert it
 * — the version-guard for that race is a separate follow-up.
 */
function reconcileExistingMessage(
	db: DbLike,
	existing: { id: string; thread_id: string },
	msg: NormalizedMessage,
): void {
	if (msg.provider_ids && Object.keys(msg.provider_ids).length) {
		try {
			db.update('message', existing.id, { provider_ids: msg.provider_ids });
		} catch {
			/* best-effort */
		}
	}

	let cur: { is_read?: unknown; is_starred?: unknown; folder?: string };
	try {
		cur = db.get('message', existing.id) as never;
	} catch {
		return;
	}
	const nextRead = msg.is_read ?? !!msg.is_outbound;
	const nextStarred = msg.is_starred ?? false;
	const nextFolder = (msg.folder ?? (msg.is_outbound ? 'sent' : 'inbox')) as string;

	const patch: Record<string, unknown> = {};
	if (!!cur.is_read !== nextRead) patch.is_read = nextRead;
	if (!!cur.is_starred !== nextStarred) patch.is_starred = nextStarred;
	if (cur.folder !== nextFolder) patch.folder = nextFolder;
	if (!Object.keys(patch).length) return;

	try {
		db.update('message', existing.id, patch);
	} catch {
		return;
	}
	recomputeThreadFromMessages(db, existing.thread_id);
}

/** Recompute a thread's unread_count / folder / starred from its message rows,
 * after a flag reconcile. Thread lives in inbox if any message does,
 *  otherwise it follows its newest message. */
function recomputeThreadFromMessages(db: DbLike, thread_id: string): void {
	const rows = db.exec(
		`SELECT is_read, is_starred, is_outbound, folder FROM message WHERE thread_id = ?`,
		thread_id,
	) as Array<{ is_read?: unknown; is_starred?: unknown; is_outbound?: unknown; folder?: string }>;
	if (!rows.length) return;

	let unread = 0;
	let anyInbox = false;
	let anyStarred = false;
	for (const r of rows) {
		if (!r.is_outbound && !r.is_read) unread++;
		if (r.folder === 'inbox') anyInbox = true;
		if (r.is_starred) anyStarred = true;
	}
	const newest = db.exec(
		`SELECT folder FROM message WHERE thread_id = ? ORDER BY date DESC LIMIT 1`,
		thread_id,
	) as Array<{ folder?: string }>;
	const folder = anyInbox ? 'inbox' : (newest[0]?.folder ?? 'archive');

	try {
		db.update('thread', thread_id, { unread_count: unread, folder, starred: anyStarred });
	} catch {
		/* best-effort */
	}
}

function updateThreadCounters(
	db: DbLike,
	thread_id: string,
	msg: NormalizedMessage,
	participants: Address[],
	label_ids: string[],
): void {
	const thread = db.get('thread', thread_id) as {
		message_count?: number;
		unread_count?: number;
		participants?: Address[];
		account_ids?: string[];
		folder?: string;
		last_message_at?: number;
		has_attachments?: boolean;
		starred?: boolean;
		label_ids?: string[];
		gmail_thread_ids?: Array<{ account_id: string; thread_id: string }>;
	};
	const mergedLabels = [...new Set([...(thread.label_ids ?? []), ...label_ids])];

	const mergedParticipants = dedupeAddresses([...(thread.participants ?? []), ...participants]);
	const accountIds = new Set([...(thread.account_ids ?? []), msg.account_id]);
	const inbound = !msg.is_outbound;
	const wasArchived = thread.folder === 'archive';

	// A new inbound message promotes an archived thread back to inbox.
	const nextFolder =
		inbound && wasArchived && (msg.folder ?? 'inbox') === 'inbox' ? 'inbox' : thread.folder;

	const gmailIds = thread.gmail_thread_ids ?? [];
	if (msg.gmail_thread_id && !gmailIds.some((g) => g.thread_id === msg.gmail_thread_id)) {
		gmailIds.push({ account_id: msg.account_id, thread_id: msg.gmail_thread_id });
	}

	db.update('thread', thread_id, {
		message_count: (thread.message_count ?? 0) + 1,
		unread_count: (thread.unread_count ?? 0) + (inbound && !(msg.is_read ?? false) ? 1 : 0),
		participants: mergedParticipants,
		participant_text: participantText(mergedParticipants),
		account_ids: [...accountIds],
		folder: nextFolder,
		last_message_at: Math.max(thread.last_message_at ?? 0, msg.date),
		snippet: msg.snippet ?? msg.text_excerpt?.slice(0, 120),
		starred: thread.starred || (msg.is_starred ?? false),
		label_ids: mergedLabels.length ? mergedLabels : undefined,
		has_attachments: thread.has_attachments || (msg.attachment_count ?? 0) > 0,
		subject: msg.subject ?? undefined,
		subject_normalized: normalizeSubject(msg.subject),
		gmail_thread_ids: gmailIds.length ? gmailIds : undefined,
	});
}

/**
 * Ensure a DelightMail `label` row exists for each user provider-label on the
 * message, recording the provider id in `provider_map` for two-way sync, and
 * return the label row ids. No-op when the message carries no user labels.
 */
function resolveLabelIds(db: DbLike, msg: NormalizedMessage): string[] {
	if (!msg.labels?.length) return [];
	const ids: string[] = [];
	for (const l of msg.labels) {
		const id = ensureLabel(db, l.name, msg.account_id, l.provider_id);
		if (id) ids.push(id);
	}
	return ids;
}

function ensureLabel(
	db: DbLike,
	name: string,
	account_id: string,
	provider_id: string,
): string | undefined {
	const rows = db.exec(`SELECT id, json FROM label WHERE name = ? LIMIT 1`, name) as Array<{
		id: string;
		json?: string;
	}>;
	if (rows.length) {
		const id = rows[0].id;
		const existing =
			(safeJson(rows[0].json).provider_map as
				| Array<{ account_id: string; provider_id: string }>
				| undefined) ?? [];
		if (!existing.some((p) => p.account_id === account_id && p.provider_id === provider_id)) {
			db.update('label', id, {
				provider_map: [...existing, { account_id, provider_id }],
			});
		}
		return id;
	}
	const created = db.create('label', {
		name,
		provider_map: [{ account_id, provider_id }],
		position: 0,
	});
	return created.id as string;
}

/**
 * Maintain the contact table on every ingested message. Sending to someone marks
 * them a known correspondent ("never auto-trash known correspondents").
 */
export function maintainContacts(db: DbLike, msg: NormalizedMessage): void {
	const now = Date.now();
	if (msg.is_outbound) {
		for (const a of [...(msg.to ?? []), ...(msg.cc ?? [])]) upsertContact(db, a, true, now);
	} else if (msg.from) {
		upsertContact(db, msg.from, false, now);
	}
}

function upsertContact(db: DbLike, a: Address, sent: boolean, now: number): void {
	const email = (a.email ?? '').toLowerCase();
	if (!email) return;
	const rows = db.exec(
		`SELECT id, send_count, receive_count FROM contact WHERE email = ? LIMIT 1`,
		email,
	) as Array<{ id: string; send_count?: number; receive_count?: number }>;
	if (rows.length) {
		const r = rows[0];
		const send_count = (r.send_count ?? 0) + (sent ? 1 : 0);
		const receive_count = (r.receive_count ?? 0) + (sent ? 0 : 1);
		db.update('contact', r.id, {
			send_count,
			receive_count,
			last_interacted_at: now,
			is_known_correspondent: send_count > 0,
			...(a.name ? { name: a.name } : {}),
		});
	} else {
		db.create('contact', {
			email,
			name: a.name,
			send_count: sent ? 1 : 0,
			receive_count: sent ? 0 : 1,
			last_interacted_at: now,
			is_known_correspondent: sent,
		});
	}
}

function collectParticipants(msg: NormalizedMessage): Address[] {
	const all: Address[] = [];
	if (msg.from) all.push(msg.from);
	for (const list of [msg.to, msg.cc]) {
		if (list) all.push(...list);
	}
	return dedupeAddresses(all);
}

function dedupeAddresses(list: Address[]): Address[] {
	const seen = new Set<string>();
	const out: Address[] = [];
	for (const a of list) {
		const key = (a.email ?? '').toLowerCase();
		if (!key || seen.has(key)) continue;
		seen.add(key);
		out.push({ name: a.name, email: a.email });
	}
	return out;
}

function participantText(list: Address[]): string {
	return list.map((a) => [a.name, a.email].filter(Boolean).join(' ')).join(', ');
}

function addressText(a: Address): string {
	return [a.name, a.email].filter(Boolean).join(' ');
}

function safeJson(s: string | undefined): Record<string, unknown> {
	if (!s) return {};
	try {
		return JSON.parse(s);
	} catch {
		return {};
	}
}
