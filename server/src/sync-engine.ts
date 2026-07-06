/**
 * SyncEngine — one Durable Object per connected account (§2 key decision).
 * A protocol head: Gmail history sync, IMAP polling (P7), backfill, watch
 * renewal, outbound send jobs, and provider write-back. Normalizes messages and
 * delivers them to MailboxServer via idempotent RPC batches (ingestMessages).
 *
 * Alarm-driven job queue with exponential backoff (§5.4). AES-GCM-encrypted
 * credentials in local SQLite (§12). No user-visible data lives here.
 */
import { encryptSecret, decryptSecret } from './crypto';
import {
	GmailClient,
	refreshAccessToken,
	gmailToNormalized,
	gmailLabelsToState,
	RetryableError,
} from './adapters/gmail';
import type { NormalizedMessage } from './ingest';

export interface SyncEnv {
	MAILBOX: DurableObjectNamespace;
	SYNC: DurableObjectNamespace;
	R2: R2Bucket;
	KV: KVNamespace;
	CREDENTIALS_ENCRYPTION_KEY?: string;
	GOOGLE_CLIENT_ID?: string;
	GOOGLE_CLIENT_SECRET?: string;
	GMAIL_POLL_SECONDS?: string;
	GMAIL_PUBSUB_TOPIC?: string;
	PUBLIC_APP_URL?: string;
}

export type JobType =
	| 'backfill_page'
	| 'history_sync'
	| 'poll_imap'
	| 'renew_watch'
	| 'provider_action'
	| 'send'
	| 'fetch_attachment'
	| 'unsubscribe'
	| 'replay_r2';

interface JobRow {
	id: number;
	type: string;
	payload: string;
	run_at: number;
	attempts: number;
	status: string;
}

interface SyncState {
	org_id?: string;
	account_id?: string;
	account_email?: string;
	kind?: string;
	credentials_encrypted?: string;
	gmail_history_id?: string;
	gmail_watch_expiry?: number;
	backfill_cursor?: string;
	access_token?: string;
	access_token_expiry?: number;
}

const MAX_ATTEMPTS = 5;
const JOB_TIME_BUDGET_MS = 25_000;
const RAW_BATCH = 20; // throttle messages.get to ~20/s (§5.1)

interface MailboxStub {
	ingestMessages(batch: unknown[]): Promise<{ ingested: number; skipped: number }>;
	broadcastMail(event: Record<string, unknown>): void;
	update(entity_type: string, id: string, data: Record<string, unknown>): unknown;
	applyRemoteFlagChange(payload: unknown): Promise<void>;
}

export class SyncEngine implements DurableObject {
	readonly #ctx: DurableObjectState;
	readonly #env: SyncEnv;
	readonly #sql: SqlStorage;

	constructor(ctx: DurableObjectState, env: SyncEnv) {
		this.#ctx = ctx;
		this.#env = env;
		this.#sql = ctx.storage.sql;
		this.#init();
	}

	#init(): void {
		this.#sql.exec(`CREATE TABLE IF NOT EXISTS sync_state (
			id TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at INTEGER
		)`);
		this.#sql.exec(`CREATE TABLE IF NOT EXISTS job (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			type TEXT NOT NULL, payload TEXT, run_at INTEGER NOT NULL,
			attempts INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending',
			last_error TEXT
		)`);
	}

	#state(): SyncState {
		const row = this.#sql
			.exec(`SELECT json FROM sync_state WHERE id = 'main'`)
			.toArray()[0] as unknown as { json?: string } | undefined;
		return row?.json ? (JSON.parse(row.json) as SyncState) : {};
	}

	#saveState(patch: Partial<SyncState>): void {
		const next = { ...this.#state(), ...patch };
		this.#sql.exec(
			`INSERT INTO sync_state (id, json, updated_at) VALUES ('main', ?, ?)
			 ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`,
			JSON.stringify(next),
			Date.now(),
		);
	}

	#mailbox(): MailboxStub {
		const state = this.#state();
		if (!state.org_id) throw new Error('SyncEngine has no org_id (not connected)');
		return this.#env.MAILBOX.get(
			this.#env.MAILBOX.idFromName(state.org_id),
		) as unknown as MailboxStub;
	}

	// -------------------------------------------------------------------------
	// Account lifecycle (RPC from the app worker).
	// -------------------------------------------------------------------------
	async connectAccount(input: {
		account_id: string;
		org_id: string;
		account_email: string;
		kind: 'gmail' | 'imap' | 'cf_domain';
		credentials?: Record<string, unknown>;
	}): Promise<{ ok: boolean }> {
		const enc = input.credentials
			? await encryptSecret(JSON.stringify(input.credentials), this.#env.CREDENTIALS_ENCRYPTION_KEY)
			: undefined;
		this.#saveState({
			org_id: input.org_id,
			account_id: input.account_id,
			account_email: input.account_email,
			kind: input.kind,
			credentials_encrypted: enc,
		});
		if (input.kind === 'gmail') {
			await this.scheduleJob('backfill_page', { page_token: null }, 0);
			await this.scheduleJob('renew_watch', {}, 0);
		} else if (input.kind === 'imap') {
			await this.scheduleJob('poll_imap', {}, 0);
		}
		return { ok: true };
	}

	async pause(): Promise<void> {
		this.#sql.exec(`UPDATE job SET status = 'paused' WHERE status = 'pending'`);
	}
	async resume(): Promise<void> {
		this.#sql.exec(`UPDATE job SET status = 'pending' WHERE status = 'paused'`);
		await this.#rearm();
	}
	async resync(): Promise<void> {
		this.#saveState({ backfill_cursor: undefined, gmail_history_id: undefined });
		await this.scheduleJob('backfill_page', { page_token: null }, 0);
	}
	async destroyAccount(): Promise<void> {
		await this.#ctx.storage.deleteAll();
	}

	async enqueueProviderAction(action: unknown): Promise<void> {
		await this.scheduleJob('provider_action', action, 0);
	}
	async enqueueSendJob(payload: unknown): Promise<void> {
		await this.scheduleJob('send', payload, 0);
	}

	/** Called by the Gmail webhook: a push hint arrived → run incremental sync. */
	async onPushHint(): Promise<void> {
		await this.scheduleJob('history_sync', {}, 0);
	}

	// -------------------------------------------------------------------------
	// Credentials + access token.
	// -------------------------------------------------------------------------
	async #credentials(): Promise<{ refresh_token: string } | null> {
		const state = this.#state();
		if (!state.credentials_encrypted) return null;
		const plain = await decryptSecret(state.credentials_encrypted, this.#env.CREDENTIALS_ENCRYPTION_KEY);
		return plain ? (JSON.parse(plain) as { refresh_token: string }) : null;
	}

	async #accessToken(): Promise<string> {
		const state = this.#state();
		if (state.access_token && (state.access_token_expiry ?? 0) > Date.now() + 60_000) {
			return state.access_token;
		}
		const creds = await this.#credentials();
		if (!creds?.refresh_token) throw new Error('No Gmail refresh token stored');
		if (!this.#env.GOOGLE_CLIENT_ID || !this.#env.GOOGLE_CLIENT_SECRET) {
			throw new Error('GOOGLE_CLIENT_ID/SECRET not configured');
		}
		const { access_token, expires_in } = await refreshAccessToken(
			this.#env.GOOGLE_CLIENT_ID,
			this.#env.GOOGLE_CLIENT_SECRET,
			creds.refresh_token,
		);
		this.#saveState({ access_token, access_token_expiry: Date.now() + expires_in * 1000 });
		return access_token;
	}

	async #gmail(): Promise<GmailClient> {
		return new GmailClient(await this.#accessToken());
	}

	// -------------------------------------------------------------------------
	// Job engine.
	// -------------------------------------------------------------------------
	async scheduleJob(type: JobType, payload: unknown, delay_ms: number): Promise<void> {
		this.#sql.exec(
			`INSERT INTO job (type, payload, run_at) VALUES (?, ?, ?)`,
			type,
			JSON.stringify(payload ?? {}),
			Date.now() + Math.max(0, delay_ms),
		);
		await this.#rearm();
	}

	async #rearm(): Promise<void> {
		const row = this.#sql
			.exec(`SELECT MIN(run_at) AS next FROM job WHERE status = 'pending'`)
			.toArray()[0] as unknown as { next: number | null };
		if (row?.next == null) return;
		const current = await this.#ctx.storage.getAlarm();
		if (current == null || row.next < current) await this.#ctx.storage.setAlarm(row.next);
	}

	async alarm(): Promise<void> {
		const started = Date.now();
		while (Date.now() - started < JOB_TIME_BUDGET_MS) {
			const job = this.#sql
				.exec(
					`SELECT * FROM job WHERE status = 'pending' AND run_at <= ? ORDER BY run_at ASC LIMIT 1`,
					Date.now(),
				)
				.toArray()[0] as unknown as JobRow | undefined;
			if (!job) break;

			try {
				await this.#runJob(job.type as JobType, safeParse(job.payload));
				this.#sql.exec(`DELETE FROM job WHERE id = ?`, job.id);
			} catch (err) {
				const attempts = job.attempts + 1;
				const message = err instanceof Error ? err.message : String(err);
				const retryable = err instanceof RetryableError || attempts < MAX_ATTEMPTS;
				if (!retryable || attempts >= MAX_ATTEMPTS) {
					this.#sql.exec(`UPDATE job SET status = 'failed', last_error = ? WHERE id = ?`, message, job.id);
					await this.#reportError(message);
				} else {
					const backoff = Math.min(16 * 60_000, 30_000 * 2 ** (attempts - 1));
					this.#sql.exec(
						`UPDATE job SET attempts = ?, run_at = ?, last_error = ? WHERE id = ?`,
						attempts,
						Date.now() + backoff,
						message,
						job.id,
					);
				}
			}
		}
		await this.#rearm();
	}

	async #runJob(type: JobType, payload: unknown): Promise<void> {
		switch (type) {
			case 'backfill_page':
				return this.#backfillPage(payload as { page_token: string | null });
			case 'history_sync':
				return this.#historySync();
			case 'renew_watch':
				return this.#renewWatch();
			case 'provider_action':
				return this.#providerAction(payload as ProviderActionPayload);
			case 'poll_imap':
			case 'send':
			case 'fetch_attachment':
			case 'unsubscribe':
			case 'replay_r2':
				console.log(`[SyncEngine] job ${type} — adapter lands in a later phase`);
				return;
			default:
				console.warn(`[SyncEngine] unknown job type: ${type}`);
		}
	}

	// -------------------------------------------------------------------------
	// Gmail sync handlers.
	// -------------------------------------------------------------------------
	async #backfillPage(payload: { page_token: string | null }): Promise<void> {
		const state = this.#state();
		const gmail = await this.#gmail();

		// On the first page, record the profile historyId so history sync can
		// resume from the moment backfill started (§5.1).
		if (!payload.page_token && !state.gmail_history_id) {
			const profile = await gmail.getProfile();
			this.#saveState({ gmail_history_id: profile.historyId, account_email: profile.emailAddress });
			await this.#setAccountStatus('backfilling');
		}

		const list = await gmail.listMessageIds(payload.page_token ?? undefined);
		const ids = (list.messages ?? []).map((m) => m.id);

		for (let i = 0; i < ids.length; i += RAW_BATCH) {
			const slice = ids.slice(i, i + RAW_BATCH);
			const batch = await this.#fetchAndNormalize(gmail, slice);
			if (batch.length) await this.#mailbox().ingestMessages(batch);
		}

		this.#saveState({ backfill_cursor: list.nextPageToken });
		this.#emitProgress('backfill', list.nextPageToken ? 50 : 100);

		if (list.nextPageToken) {
			await this.scheduleJob('backfill_page', { page_token: list.nextPageToken }, 1000);
		} else {
			await this.#setAccountStatus('live');
			// Kick an immediate history sync to catch anything since backfill start.
			await this.scheduleJob('history_sync', {}, 2000);
		}
	}

	async #historySync(): Promise<void> {
		const state = this.#state();
		if (!state.gmail_history_id) return this.#backfillPage({ page_token: null });
		const gmail = await this.#gmail();

		let pageToken: string | undefined;
		let latestHistoryId = state.gmail_history_id;
		do {
			let res;
			try {
				res = await gmail.listHistory(state.gmail_history_id, pageToken);
			} catch (err) {
				// 404 = cursor too old → bounded re-list recovery (§5.1).
				if (String(err).includes('404')) return this.#recoverFromStaleCursor(gmail);
				throw err;
			}
			const added = new Set<string>();
			const labelChanged = new Set<string>();
			for (const h of res.history ?? []) {
				for (const m of h.messagesAdded ?? []) added.add(m.message.id);
				for (const m of h.messagesDeleted ?? []) {
					await this.#mailbox().applyRemoteFlagChange({ op: 'deleted', gmail_id: m.message.id });
				}
				for (const l of h.labelsAdded ?? []) labelChanged.add(l.message.id);
				for (const l of h.labelsRemoved ?? []) labelChanged.add(l.message.id);
			}
			// New messages: full raw fetch → ingest.
			const addedIds = [...added];
			for (let i = 0; i < addedIds.length; i += RAW_BATCH) {
				const batch = await this.#fetchAndNormalize(gmail, addedIds.slice(i, i + RAW_BATCH));
				if (batch.length) await this.#mailbox().ingestMessages(batch);
			}
			// Flag/label changes on existing messages: re-fetch authoritative labels.
			for (const id of labelChanged) {
				if (added.has(id)) continue; // already ingested with fresh labels
				await this.#applyLabelChange(id);
			}
			if (res.historyId) latestHistoryId = res.historyId;
			pageToken = res.nextPageToken;
		} while (pageToken);

		this.#saveState({ gmail_history_id: latestHistoryId });
	}

	async #recoverFromStaleCursor(gmail: GmailClient): Promise<void> {
		// Re-list the most recent messages and reconcile flags.
		const list = await gmail.listMessageIds(undefined, 'newer_than:30d');
		const ids = (list.messages ?? []).map((m) => m.id);
		for (let i = 0; i < ids.length; i += RAW_BATCH) {
			const batch = await this.#fetchAndNormalize(gmail, ids.slice(i, i + RAW_BATCH));
			if (batch.length) await this.#mailbox().ingestMessages(batch);
		}
		const profile = await gmail.getProfile();
		this.#saveState({ gmail_history_id: profile.historyId });
	}

	async #renewWatch(): Promise<void> {
		if (!this.#env.GMAIL_PUBSUB_TOPIC) {
			// No Pub/Sub configured → fall back to polling (§5.1).
			const seconds = Number(this.#env.GMAIL_POLL_SECONDS ?? 90);
			await this.scheduleJob('history_sync', {}, seconds * 1000);
			await this.scheduleJob('renew_watch', {}, seconds * 1000);
			return;
		}
		const gmail = await this.#gmail();
		const res = await gmail.watch(this.#env.GMAIL_PUBSUB_TOPIC);
		this.#saveState({ gmail_watch_expiry: Number(res.expiration) });
		// Re-arm 6 days out (watches expire after 7, §5.1).
		await this.scheduleJob('renew_watch', {}, 6 * 24 * 60 * 60 * 1000);
	}

	async #providerAction(payload: ProviderActionPayload): Promise<void> {
		const gmail = await this.#gmail();
		const gmailIds = payload.gmail_ids ?? [];
		for (const id of gmailIds) {
			switch (payload.op) {
				case 'archive':
					await gmail.modify(id, [], ['INBOX']);
					break;
				case 'trash':
				case 'delete_forever':
					await gmail.trash(id);
					break;
				case 'spam':
					await gmail.modify(id, ['SPAM'], ['INBOX']);
					break;
				case 'read':
					await gmail.modify(id, [], ['UNREAD']);
					break;
				case 'unread':
					await gmail.modify(id, ['UNREAD'], []);
					break;
				case 'star':
					await gmail.modify(id, ['STARRED'], []);
					break;
				case 'unstar':
					await gmail.modify(id, [], ['STARRED']);
					break;
				default:
					break;
			}
		}
	}

	async #fetchAndNormalize(gmail: GmailClient, ids: string[]): Promise<NormalizedMessage[]> {
		const state = this.#state();
		const out: NormalizedMessage[] = [];
		for (const id of ids) {
			try {
				const msg = await gmail.getRaw(id);
				out.push(
					await gmailToNormalized(msg, {
						account_id: state.account_id!,
						org_id: state.org_id!,
						r2: this.#env.R2,
					}),
				);
			} catch (err) {
				if (err instanceof RetryableError) throw err;
				console.error(`[SyncEngine] skip message ${id}:`, err);
			}
		}
		return out;
	}

	async #applyLabelChange(gmail_id: string): Promise<void> {
		// Fetch the authoritative current label set (history only gives deltas).
		const gmail = await this.#gmail();
		const meta = await gmail.getMetadata(gmail_id);
		const state = gmailLabelsToState(meta.labelIds);
		await this.#mailbox().applyRemoteFlagChange({ op: 'labels', gmail_id, state });
	}

	async #setAccountStatus(status: string): Promise<void> {
		const s = this.#state();
		if (!s.account_id) return;
		try {
			this.#mailbox().update('account', s.account_id, { status });
		} catch (err) {
			console.error('[SyncEngine] status update failed:', err);
		}
	}

	#emitProgress(phase: string, percent: number): void {
		const s = this.#state();
		try {
			this.#mailbox().broadcastMail({
				event: 'sync:progress',
				account_id: s.account_id,
				phase,
				percent,
			});
		} catch {
			/* best-effort */
		}
	}

	async #reportError(message: string): Promise<void> {
		await this.#setAccountStatus('error');
		const s = this.#state();
		if (s.account_id) {
			try {
				this.#mailbox().update('account', s.account_id, { status_detail: message.slice(0, 300) });
			} catch {
				/* ignore */
			}
		}
	}

	async fetch(): Promise<Response> {
		return new Response('SyncEngine', { status: 200 });
	}
}

interface ProviderActionPayload {
	op: string;
	gmail_ids?: string[];
	thread_ids?: string[];
}

function safeParse(json: string | null): unknown {
	if (!json) return {};
	try {
		return JSON.parse(json);
	} catch {
		return {};
	}
}
