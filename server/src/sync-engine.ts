/**
 * SyncEngine — one Durable Object per connected account (§2 key decision).
 * A protocol head: Gmail history sync, IMAP polling, backfill, watch renewal,
 * outbound send jobs, and provider write-back. Normalizes messages and delivers
 * them to MailboxServer via idempotent RPC batches (ingestMessages).
 *
 * It owns an alarm-driven job queue with exponential backoff (§5.4) and stores
 * AES-GCM-encrypted credentials in local SQLite (§12). No user-visible data
 * lives here — it can be destroyed and rebuilt from the account config.
 */
import { encryptSecret, decryptSecret } from './crypto';

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

const MAX_ATTEMPTS = 5;
const JOB_TIME_BUDGET_MS = 25_000;

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
			id TEXT PRIMARY KEY,
			account_id TEXT,
			kind TEXT,
			credentials_encrypted TEXT,
			gmail_history_id TEXT,
			gmail_watch_expiry INTEGER,
			backfill_cursor TEXT,
			imap_state TEXT,
			label_map TEXT,
			updated_at INTEGER
		)`);
		this.#sql.exec(`CREATE TABLE IF NOT EXISTS job (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			type TEXT NOT NULL,
			payload TEXT,
			run_at INTEGER NOT NULL,
			attempts INTEGER NOT NULL DEFAULT 0,
			status TEXT NOT NULL DEFAULT 'pending',
			last_error TEXT
		)`);
	}

	// -------------------------------------------------------------------------
	// Account lifecycle (called by the app worker over RPC).
	// -------------------------------------------------------------------------
	/** Store an account's config + encrypted credentials and kick off sync. */
	async connectAccount(input: {
		account_id: string;
		kind: 'gmail' | 'imap' | 'cf_domain';
		credentials?: Record<string, unknown>;
		label_map?: Record<string, string>;
	}): Promise<{ ok: boolean }> {
		const enc = input.credentials
			? await encryptSecret(
					JSON.stringify(input.credentials),
					this.#env.CREDENTIALS_ENCRYPTION_KEY,
				)
			: null;
		this.#sql.exec(
			`INSERT INTO sync_state (id, account_id, kind, credentials_encrypted, label_map, updated_at)
			 VALUES ('main', ?, ?, ?, ?, ?)
			 ON CONFLICT(id) DO UPDATE SET account_id=excluded.account_id, kind=excluded.kind,
			   credentials_encrypted=excluded.credentials_encrypted, updated_at=excluded.updated_at`,
			input.account_id,
			input.kind,
			enc,
			JSON.stringify(input.label_map ?? {}),
			Date.now(),
		);
		// Start backfill + realtime setup (implemented per-adapter in P1/P7).
		if (input.kind === 'gmail') {
			await this.scheduleJob('backfill_page', { page_token: null }, 0);
			await this.scheduleJob('renew_watch', {}, 0);
		} else if (input.kind === 'imap') {
			await this.scheduleJob('poll_imap', {}, 0);
		}
		return { ok: true };
	}

	async getCredentials(): Promise<Record<string, unknown> | null> {
		const row = this.#sql
			.exec(`SELECT credentials_encrypted FROM sync_state WHERE id = 'main'`)
			.toArray()[0] as unknown as { credentials_encrypted?: string } | undefined;
		if (!row?.credentials_encrypted) return null;
		const plain = await decryptSecret(
			row.credentials_encrypted,
			this.#env.CREDENTIALS_ENCRYPTION_KEY,
		);
		return plain ? (JSON.parse(plain) as Record<string, unknown>) : null;
	}

	async pause(): Promise<void> {
		this.#sql.exec(`UPDATE job SET status = 'paused' WHERE status = 'pending'`);
	}

	async resume(): Promise<void> {
		this.#sql.exec(`UPDATE job SET status = 'pending' WHERE status = 'paused'`);
		await this.#rearm();
	}

	async destroyAccount(): Promise<void> {
		await this.#ctx.storage.deleteAll();
	}

	/** Enqueue a provider write-back for a user action (called by MailboxServer). */
	async enqueueProviderAction(action: unknown): Promise<void> {
		await this.scheduleJob('provider_action', action, 0);
	}

	/** Enqueue an outbound send (called by MailboxServer's outbox flush, P3). */
	async enqueueSendJob(payload: unknown): Promise<void> {
		await this.scheduleJob('send', payload, 0);
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
		if (current == null || row.next < current) {
			await this.#ctx.storage.setAlarm(row.next);
		}
	}

	async alarm(): Promise<void> {
		const started = Date.now();
		while (Date.now() - started < JOB_TIME_BUDGET_MS) {
			const job = this.#sql
				.exec(
					`SELECT * FROM job WHERE status = 'pending' AND run_at <= ?
					 ORDER BY run_at ASC LIMIT 1`,
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
				if (attempts >= MAX_ATTEMPTS) {
					this.#sql.exec(
						`UPDATE job SET status = 'failed', last_error = ? WHERE id = ?`,
						message,
						job.id,
					);
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

	async #runJob(type: JobType, _payload: unknown): Promise<void> {
		// Adapter dispatch is implemented per phase (P1 gmail, P7 imap, P3 send).
		switch (type) {
			case 'backfill_page':
			case 'history_sync':
			case 'renew_watch':
			case 'poll_imap':
			case 'provider_action':
			case 'send':
			case 'fetch_attachment':
			case 'unsubscribe':
			case 'replay_r2':
				console.log(`[SyncEngine] job ${type} — adapter not wired yet`);
				return;
			default:
				console.warn(`[SyncEngine] unknown job type: ${type}`);
		}
	}

	/** RPC ingest helper: deliver a normalized batch to the owning MailboxServer. */
	async #deliverToMailbox(org_id: string, batch: unknown[]): Promise<void> {
		const stub = this.#env.MAILBOX.get(
			this.#env.MAILBOX.idFromName(org_id),
		) as unknown as { ingestMessages(batch: unknown[]): Promise<unknown> };
		await stub.ingestMessages(batch);
	}

	// Referenced to keep the private helper from being flagged unused before the
	// adapters that call it land in P1.
	get _deliver() {
		return this.#deliverToMailbox.bind(this);
	}

	async fetch(): Promise<Response> {
		return new Response('SyncEngine', { status: 200 });
	}
}

function safeParse(json: string | null): unknown {
	if (!json) return {};
	try {
		return JSON.parse(json);
	} catch {
		return {};
	}
}
