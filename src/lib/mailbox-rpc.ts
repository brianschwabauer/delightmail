/**
 * The RPC surface of the MailboxServer Durable Object, as seen by the app
 * worker. MailboxServer (server/src/mailbox-server.ts) implements this on top
 * of DatabaseServer; the app worker's `locals.db` is typed as this so custom
 * mail endpoints get real typing without importing worker-only code
 * (`cloudflare:workers`).
 *
 * This is a hand-maintained subset — grow it as the server gains methods.
 */
import type { Tables, Message, Thread, Address } from './schema';
import type { Database } from '@delightstack/database';

export interface IngestBatchItem {
	rfc822_message_id: string;
	account_id: string;
	raw_r2_key?: string;
	parsed?: unknown;
}

export interface ThreadAction {
	thread_ids: string[];
	action:
		| 'archive'
		| 'trash'
		| 'delete'
		| 'spam'
		| 'read'
		| 'unread'
		| 'star'
		| 'unstar'
		| 'move'
		| 'label';
	folder?: string;
	label_id?: string;
}

/**
 * The subset of DatabaseServer + mail methods the app calls over RPC. `locals.db`
 * is a Durable Object stub, so EVERY method resolves asynchronously — even the
 * ones DatabaseServer implements synchronously.
 */
export interface MailboxRpc {
	// --- generic DatabaseServer surface (subset used by the app) ---
	get<K extends keyof Tables & string>(
		entity_type: K,
		id: string | number,
	): Promise<Database.Entity<Tables[K]>>;
	list<K extends keyof Tables & string>(
		entity_type: K,
		query: Record<string, unknown>,
	): Promise<{ docs: Array<Database.Entity<Tables[K]>>; cursor?: string }>;
	create<K extends keyof Tables & string>(
		entity_type: K,
		data: Record<string, unknown>,
	): Promise<Database.Entity<Tables[K]>>;
	update<K extends keyof Tables & string>(
		entity_type: K,
		id: string | number,
		data: Record<string, unknown>,
	): Promise<Database.Entity<Tables[K]>>;
	delete(entity_type: keyof Tables & string, id: string | number): Promise<void>;
	getMeta(): Promise<Record<string, unknown>>;
	setMeta(data: Record<string, unknown>): Promise<void>;

	// --- mail-specific RPC (implemented in MailboxServer) ---
	/** Idempotent bulk ingest keyed on rfc822_message_id (§5). */
	ingestMessages(batch: unknown[]): Promise<{ ingested: number; skipped: number }>;
	/** Apply an optimistic action to threads and enqueue provider write-back. */
	applyThreadAction(action: ThreadAction, actor?: string): Promise<{ affected: string[] }>;
	/** Queue an outbound message for the undo-send pipeline (§6). */
	enqueueSend(message: Partial<Message>, identity_id: string): Promise<{ message_id: string }>;
	/** Cancel a queued send within the undo window. */
	undoSend(message_id: string): Promise<{ ok: boolean }>;
	/** Create or update an autosaved draft (§6). */
	saveDraft(input: {
		draft_id?: string;
		identity_id: string;
		to: Address[];
		cc?: Address[];
		subject: string;
		doc: string;
	}): Promise<{ draft_id: string; thread_id: string }>;
	/** Delete a draft message. */
	deleteDraft(draft_id: string): Promise<{ ok: boolean }>;
	/** Fetch the newest threads for a folder (server-side, used by SSR/tests). */
	listThreads(folder: string, limit?: number): Promise<Thread[]>;
	/** Run the triage test harness against N recent messages without acting. */
	triageTest(prompt: string, count: number): Promise<unknown[]>;
	/** Ensure the singleton settings row exists and return it. */
	ensureSettings(): Promise<unknown>;
}
