/**
 * DelightMail data model — the single source of truth for every mail table.
 *
 * Imported by BOTH workers: the SvelteKit app worker (typed CRUD + the
 * DatabaseClient mirror) and the server worker (MailboxServer extends
 * DatabaseServer<typeof tables>).
 *
 * DSL notes (verified against @delightstack/database):
 * - Auto `id` (string PK) + `created_at`/`updated_at` (epoch-ms numbers).
 * - `.searchable()` puts a field in the Orama index → it is both fuzzy-searchable
 *   AND usable in a `where` filter, and is mirrored to clients. Keep the set
 * small. Enums/booleans/arrays/FKs support `.searchable()` but NOT
 *   `.indexable()`; `.indexable()` (strings/numbers) only adds a SQLite index for
 *   server-side `exec()` lookups.
 * - `.sortable()` implies searchable and enables `order`.
 * - Date-like sortable fields are epoch-ms numbers so cursor pagination is scalar.
 * - Arbitrary-key maps → arrays of typed pairs; opaque editor JSON → JSON string.
 */
import { Database } from '@delightstack/database';

/** The field-builder passed to a `Database.table` callback (not exported by name). */
type Builder = Parameters<Parameters<typeof Database.table>[1]>[0];

const FOLDERS = [
	{ value: 'inbox', label: 'Inbox' },
	{ value: 'archive', label: 'Archive' },
	{ value: 'trash', label: 'Trash' },
	{ value: 'spam', label: 'Spam' },
	{ value: 'sent', label: 'Sent' },
	{ value: 'drafts', label: 'Drafts' },
	{ value: 'snoozed', label: 'Snoozed' },
	{ value: 'quarantine', label: 'AI Filtered' },
];

const CATEGORIES = [
	{ value: 'primary', label: 'Primary' },
	{ value: 'updates', label: 'Updates' },
	{ value: 'promotions', label: 'Promotions' },
	{ value: 'social', label: 'Social' },
	{ value: 'newsletters', label: 'Newsletters' },
	{ value: 'receipts', label: 'Receipts' },
	{ value: 'forums', label: 'Forums' },
];

/** A `{name,email}` address pair used across from/to/cc/participants. */
const addressShape = (s: Builder) => ({
	name: s.string().optional(),
	email: s.string().optional(),
});

// ---------------------------------------------------------------------------
// account — a connected mail source
// ---------------------------------------------------------------------------
export const accountTable = Database.table('account', (s) => ({
	id: s.primaryKey(),
	kind: s.enum([
		{ value: 'gmail', label: 'Gmail' },
		{ value: 'imap', label: 'IMAP' },
		{ value: 'cf_domain', label: 'Custom Domain' },
	]),
	// Not `.email()` — for cf_domain accounts this holds the bare domain.
	email: s.string().label('Email').searchable(),
	display_name: s.string().label('Display name').optional(),
	color: s.string().label('Color').optional(),
	status: s
		.enum([
			{ value: 'connecting', label: 'Connecting' },
			{ value: 'backfilling', label: 'Backfilling' },
			{ value: 'live', label: 'Live' },
			{ value: 'error', label: 'Error' },
			{ value: 'paused', label: 'Paused' },
		])
		.default('connecting'),
	status_detail: s.string().optional(),
	config: s
		.object({
			imap_host: s.string().optional(),
			imap_port: s.number().optional(),
			imap_secure: s.boolean().optional(),
			smtp_host: s.string().optional(),
			smtp_port: s.number().optional(),
			smtp_secure: s.boolean().optional(),
			username: s.string().optional(),
			gmail_address: s.string().optional(),
			domain: s.string().optional(),
			forward_to: s.string().optional(),
		})
		.optional(),
	sync_cursor_info: s
		.object({
			history_id: s.string().optional(),
			last_poll_at: s.number().optional(),
			backfill_percent: s.number().optional(),
		})
		.optional(),
}));

// ---------------------------------------------------------------------------
// identity — an address the user can send as
// ---------------------------------------------------------------------------
export const identityTable = Database.table('identity', (s) => ({
	id: s.primaryKey(),
	account_id: s
		.foreignKey({ type: 'string', table: 'account', column: 'id' })
		.onDelete('CASCADE'),
	email: s.string().email().searchable(),
	name: s.string().optional(),
	signature_doc: s.string().optional(),
	is_default: s.boolean().default(false),
	auto_created: s.boolean().default(false),
}));

// ---------------------------------------------------------------------------
// thread — conversation (the unit the list UI renders)
// ---------------------------------------------------------------------------
export const threadTable = Database.table('thread', (s) => ({
	id: s.primaryKey(),
	subject: s.string().searchable(),
	// Re:/Fwd:/[list]-stripped, lowercased subject — the threading match key.
	subject_normalized: s.string().optional().indexable(),
	snippet: s.string().optional(),
	participants: s.array(s.object(addressShape(s))).optional(),
	participant_text: s.string().searchable().optional(),
	account_ids: s.array(s.string()).searchable().optional(),
	// sortable/searchable: these drive the LIST UI (unread dot, count pill,
	// paperclip) and search operators (is:unread, has:attachment) — a field
	// must be in the Orama index to appear in sparse docs or be filterable.
	message_count: s.number().sortable().default(0),
	unread_count: s.number().sortable().default(0),
	starred: s.boolean().searchable().default(false),
	has_attachments: s.boolean().searchable().default(false),
	folder: s.enum(FOLDERS).searchable().default('inbox'),
	label_ids: s.array(s.string()).searchable().optional(),
	category: s.enum(CATEGORIES).searchable().optional(),
	last_message_at: s.number().sortable().default(0),
	snoozed_until: s.number().sortable().optional(),
	gmail_thread_ids: s
		.array(s.object({ account_id: s.string(), thread_id: s.string() }))
		.optional(),
}));

// ---------------------------------------------------------------------------
// message — one email
// ---------------------------------------------------------------------------
export const messageTable = Database.table('message', (s) => ({
	id: s.primaryKey(),
	thread_id: s
		.foreignKey({ type: 'string', table: 'thread', column: 'id' })
		.onDelete('CASCADE')
		.searchable(),
	account_id: s
		.foreignKey({ type: 'string', table: 'account', column: 'id' })
		.onDelete('CASCADE'),
	identity_email: s.string().optional(),
	// Indexed for idempotency lookups but NOT globally unique: the same message
	// delivered to two connected accounts is two rows (dedupe is per-account by
	// design) — ingest scopes the idempotency check by account_id.
	rfc822_message_id: s.string().indexable(),
	in_reply_to: s.string().optional(),
	references: s.array(s.string()).optional(),
	provider_ids: s
		.object({
			gmail_id: s.string().optional(),
			gmail_thread_id: s.string().optional(),
			imap_uid: s.number().optional(),
			imap_folder: s.string().optional(),
			uidvalidity: s.number().optional(),
		})
		.optional(),
	from: s.object(addressShape(s)).optional(),
	from_text: s.string().searchable().optional(),
	to: s.array(s.object(addressShape(s))).optional(),
	cc: s.array(s.object(addressShape(s))).optional(),
	bcc: s.array(s.object(addressShape(s))).optional(),
	reply_to: s.array(s.object(addressShape(s))).optional(),
	subject: s.string().searchable().optional(),
	// First ~8KB of extracted plain text — the ONLY body content in SQLite.
	text_excerpt: s.string().searchable().optional(),
	body_keys: s
		.object({
			raw: s.string().optional(),
			html: s.string().optional(),
			text: s.string().optional(),
		})
		.optional(),
	date: s.number().sortable().default(0),
	is_read: s.boolean().searchable().default(false),
	is_starred: s.boolean().searchable().default(false),
	is_draft: s.boolean().searchable().default(false),
	is_outbound: s.boolean().default(false),
	folder: s.enum(FOLDERS).searchable().default('inbox'),
	draft_doc: s.string().optional(),
	headers_subset: s
		.object({
			list_unsubscribe: s.string().optional(),
			list_unsubscribe_post: s.string().optional(),
			list_id: s.string().optional(),
			delivered_to: s.string().optional(),
			auto_submitted: s.string().optional(),
			precedence: s.string().optional(),
			spf: s.string().optional(),
			dkim: s.string().optional(),
			dmarc: s.string().optional(),
		})
		.optional(),
	attachment_count: s.number().default(0),
	size_bytes: s.number().default(0),
	send_status: s
		.enum([
			{ value: 'queued', label: 'Queued' },
			{ value: 'sending', label: 'Sending' },
			{ value: 'sent', label: 'Sent' },
			{ value: 'failed', label: 'Failed' },
		])
		.optional(),
}));

// ---------------------------------------------------------------------------
// attachment
// ---------------------------------------------------------------------------
export const attachmentTable = Database.table('attachment', (s) => ({
	id: s.primaryKey(),
	message_id: s
		.foreignKey({ type: 'string', table: 'message', column: 'id' })
		.onDelete('CASCADE')
		.searchable(),
	filename: s.string().searchable().optional(),
	// searchable/sortable so the reading pane's attachment chips (icon by mime,
	// human size) render straight from the local index — instant and offline.
	mime_type: s.string().searchable().optional(),
	size_bytes: s.number().sortable().default(0),
	r2_key: s.string().optional(),
	content_id: s.string().optional(),
	image_id: s.string().optional(),
}));

// ---------------------------------------------------------------------------
// label — user labels, unified across accounts
// ---------------------------------------------------------------------------
export const labelTable = Database.table('label', (s) => ({
	id: s.primaryKey(),
	name: s.string().searchable(),
	color: s.string().optional(),
	provider_map: s
		.array(s.object({ account_id: s.string(), provider_id: s.string() }))
		.optional(),
	position: s.number().default(0),
}));

// ---------------------------------------------------------------------------
// contact — autocomplete + the "never auto-trash known correspondents" guard
// ---------------------------------------------------------------------------
export const contactTable = Database.table('contact', (s) => ({
	id: s.primaryKey(),
	email: s.string().email().searchable().indexable().unique(),
	name: s.string().searchable().optional(),
	send_count: s.number().default(0),
	receive_count: s.number().default(0),
	last_interacted_at: s.number().sortable().default(0),
	is_known_correspondent: s.boolean().default(false),
}));

// ---------------------------------------------------------------------------
// sender_rule — deterministic rules evaluated BEFORE AI at ingest
// ---------------------------------------------------------------------------
export const senderRuleTable = Database.table('sender_rule', (s) => ({
	id: s.primaryKey(),
	matcher: s.object({
		from_domain: s.string().optional(),
		from_address: s.string().optional(),
		list_id: s.string().optional(),
	}),
	action: s.enum([
		{ value: 'inbox', label: 'Keep in Inbox' },
		{ value: 'archive', label: 'Archive' },
		{ value: 'trash', label: 'Trash' },
		{ value: 'spam', label: 'Spam' },
		{ value: 'label', label: 'Label' },
	]),
	label_id: s.string().optional(),
	source: s
		.enum([
			{ value: 'user', label: 'User' },
			{ value: 'ai_confirmed', label: 'AI confirmed' },
		])
		.default('user'),
	hit_count: s.number().default(0),
}));

// ---------------------------------------------------------------------------
// ai_review — audit log of every AI decision
// ---------------------------------------------------------------------------
export const aiReviewTable = Database.table('ai_review', (s) => ({
	id: s.primaryKey(),
	message_id: s
		.foreignKey({ type: 'string', table: 'message', column: 'id' })
		.onDelete('CASCADE'),
	model: s.string().optional(),
	verdict: s.object({
		category: s.string().optional(),
		importance: s.number().optional(),
		action: s.string().optional(),
		unsubscribe_recommended: s.boolean().optional(),
		summary: s.string().optional(),
		confidence: s.number().optional(),
	}),
	action_taken: s.string().optional(),
	overridden: s.boolean().default(false),
	latency_ms: s.number().optional(),
	tokens: s.number().optional(),
}));

// ---------------------------------------------------------------------------
// unsubscribe_task — unsubscribe pipeline state
// ---------------------------------------------------------------------------
export const unsubscribeTaskTable = Database.table('unsubscribe_task', (s) => ({
	id: s.primaryKey(),
	message_id: s.string().optional(),
	sender_domain: s.string().searchable(),
	method: s.enum([
		{ value: 'http_oneclick', label: 'One-click (HTTP)' },
		{ value: 'mailto', label: 'Email' },
		{ value: 'link_manual', label: 'Manual link' },
	]),
	target: s.string().optional(),
	status: s
		.enum([
			{ value: 'suggested', label: 'Suggested' },
			{ value: 'approved', label: 'Approved' },
			{ value: 'done', label: 'Done' },
			{ value: 'failed', label: 'Failed' },
		])
		.searchable()
		.default('suggested'),
	completed_at: s.number().optional(),
}));

// ---------------------------------------------------------------------------
// push_subscription — web-push targets
// ---------------------------------------------------------------------------
export const pushSubscriptionTable = Database.table('push_subscription', (s) => ({
	id: s.primaryKey(),
	endpoint: s.string().indexable().unique(),
	keys: s.object({ p256dh: s.string(), auth: s.string() }),
	device_label: s.string().optional(),
	failed_count: s.number().default(0),
}));

// ---------------------------------------------------------------------------
// settings — per-user app configuration (singleton row, id = 'main')
// ---------------------------------------------------------------------------
export const settingsTable = Database.table('settings', (s) => ({
	id: s.primaryKey(),
	triage_prompt: s.string().optional(),
	triage_enabled: s.boolean().default(false),
	triage_mode: s
		.enum([
			{ value: 'label_only', label: 'Label only' },
			{ value: 'quarantine', label: 'Quarantine' },
			{ value: 'full_auto', label: 'Full auto' },
		])
		.default('quarantine'),
	undo_send_seconds: s.number().default(10),
	keyboard_overrides: s.string().optional(),
	density: s
		.enum([
			{ value: 'comfortable', label: 'Comfortable' },
			{ value: 'compact', label: 'Compact' },
		])
		.default('comfortable'),
	theme: s
		.enum([
			{ value: 'system', label: 'System' },
			{ value: 'light', label: 'Light' },
			{ value: 'dark', label: 'Dark' },
		])
		.default('system'),
	auto_unsubscribe: s.boolean().default(false),
	push_mode: s
		.enum([
			{ value: 'off', label: 'Off' },
			{ value: 'mentions', label: 'Directed at me' },
			{ value: 'important', label: 'Important only' },
			{ value: 'all', label: 'All new mail' },
		])
		.default('important'),
	// Local-time window during which pushes are suppressed, "HH:MM-HH:MM".
	quiet_hours: s.string().optional(),
	// IANA timezone (e.g. "America/Los_Angeles") the quiet-hours window is
	// evaluated in. Auto-persisted by the client so travel/DST stay correct;
	// absent → UTC.
	timezone: s.string().optional(),
	// Play a subtle synthesized tick on archive/trash actions.
	sounds: s.boolean().default(false),
}));

// ---------------------------------------------------------------------------
// outbox — durable send queue; survives offline composes
// ---------------------------------------------------------------------------
export const outboxTable = Database.table('outbox', (s) => ({
	id: s.primaryKey(),
	message_id: s.string(),
	identity_id: s.string(),
	not_before: s.number().default(0),
	attempts: s.number().default(0),
	last_error: s.string().optional(),
}));

export const tables = {
	account: accountTable,
	identity: identityTable,
	thread: threadTable,
	message: messageTable,
	attachment: attachmentTable,
	label: labelTable,
	contact: contactTable,
	sender_rule: senderRuleTable,
	ai_review: aiReviewTable,
	unsubscribe_task: unsubscribeTaskTable,
	push_subscription: pushSubscriptionTable,
	settings: settingsTable,
	outbox: outboxTable,
};

export type Tables = typeof tables;
export type Account = Database.Entity<typeof accountTable>;
export type Identity = Database.Entity<typeof identityTable>;
export type Thread = Database.Entity<typeof threadTable>;
export type Message = Database.Entity<typeof messageTable>;
export type Attachment = Database.Entity<typeof attachmentTable>;
export type Label = Database.Entity<typeof labelTable>;
export type Contact = Database.Entity<typeof contactTable>;
export type SenderRule = Database.Entity<typeof senderRuleTable>;
export type AiReview = Database.Entity<typeof aiReviewTable>;
export type UnsubscribeTask = Database.Entity<typeof unsubscribeTaskTable>;
export type PushSubscription = Database.Entity<typeof pushSubscriptionTable>;
export type Settings = Database.Entity<typeof settingsTable>;
export type Outbox = Database.Entity<typeof outboxTable>;

/** Address pair used throughout the mail domain. */
export interface Address {
	name?: string;
	email?: string;
}
