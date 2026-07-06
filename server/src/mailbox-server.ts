/**
 * MailboxServer — one Durable Object per user (org). Extends DatabaseServer with
 * the mail tables, an alarm-driven job engine (triage / outbox / push), and the
 * mail-specific RPC surface the app worker calls (see src/lib/mailbox-rpc.ts).
 *
 * Storage split (§4, §11): SQLite holds metadata + an 8KB searchable excerpt;
 * full HTML/raw/attachments live in R2. Orama search index lives in DO memory.
 */
import { DatabaseServer } from '@delightstack/database/worker';
import type { WebsocketServer } from '@delightstack/websocket/worker';
import { tables, type Thread, type Message, type Settings } from '../../src/lib/schema';
import { ingestBatch, type NormalizedMessage } from './ingest';
import { applyThreadActionLocal } from './actions';

export interface MailboxEnv {
	MAILBOX: DurableObjectNamespace;
	SYNC: DurableObjectNamespace;
	WS: DurableObjectNamespace;
	RATE_LIMITER: DurableObjectNamespace;
	R2: R2Bucket;
	KV: KVNamespace;
	AI: unknown;
	AI_GATEWAY_ACCOUNT_ID?: string;
	AI_GATEWAY_NAME?: string;
	AI_GATEWAY_TOKEN?: string;
	AI_TRIAGE_ROUTE?: string;
	CREDENTIALS_ENCRYPTION_KEY?: string;
}

const SETTINGS_ID = 'main';

// The delightstack `Database.Table` type resolves to an over-narrow
// `table_definition` when used as a generic *constraint*, so `typeof tables`
// (correct at runtime) trips the `DatabaseServer<Config>` bound. The example app
// never surfaces this because it doesn't strict-typecheck its server worker.
// @ts-ignore — library generic-constraint false positive; the type arg is still bound.
export class MailboxServer extends DatabaseServer<typeof tables> {
	readonly #menv: MailboxEnv;
	readonly #orgName: string;

	constructor(ctx: DurableObjectState, env: MailboxEnv) {
		// The WS DO shares the same name (the org_id) that clients connect to.
		const ws_name = (ctx.id as unknown as { name?: string }).name ?? ctx.id.toString();
		const getWs = () =>
			env.WS.get(env.WS.idFromName(ws_name)) as unknown as {
				entityChanged(
					action: 'created' | 'updated' | 'deleted',
					entity_type: string,
					id: string | number,
					data?: unknown,
					user_id?: string,
				): void;
				broadcast?(message: Record<string, unknown>): void;
			};
		super(tables, getWs, ctx, env as never);
		this.#menv = env;
		this.#orgName = ws_name;
		this.#wsForEvents = getWs;
	}

	#wsForEvents: () => { broadcast?(message: Record<string, unknown>): void };

	/** Broadcast a custom mail event (mail:new, sync:progress, …) to all devices. */
	broadcastMail(event: Record<string, unknown>): void {
		try {
			this.#wsForEvents().broadcast?.(event);
		} catch (err) {
			console.error('[MailboxServer] broadcast failed:', err);
		}
	}

	// -------------------------------------------------------------------------
	// Settings (singleton)
	// -------------------------------------------------------------------------
	async ensureSettings(): Promise<Settings> {
		try {
			return this.get('settings', SETTINGS_ID) as Settings;
		} catch {
			return this.create('settings', { id: SETTINGS_ID } as never) as Settings;
		}
	}

	// -------------------------------------------------------------------------
	// Ingest (§5) — idempotent on rfc822_message_id, runs threading + counters.
	// -------------------------------------------------------------------------
	async ingestMessages(
		batch: NormalizedMessage[],
	): Promise<{ ingested: number; skipped: number }> {
		const result = ingestBatch(this, batch);
		for (const m of result.new_messages) {
			this.broadcastMail({
				event: 'mail:new',
				thread_id: m.thread_id,
				message_id: m.id,
				folder: m.folder,
				from: m.from,
				subject: m.subject,
			});
		}
		// Triage newly-arrived inbound messages after paint (§7).
		if (result.new_messages.some((m) => m.is_outbound === false)) {
			await this.scheduleJob('triage', {}, 0);
		}
		return { ingested: result.ingested, skipped: result.skipped };
	}

	// -------------------------------------------------------------------------
	// Actions (§5.1 outbound / §6) — optimistic local write + provider job.
	// -------------------------------------------------------------------------
	async applyThreadAction(
		action: {
			thread_ids: string[];
			action: string;
			folder?: string;
			label_id?: string;
		},
		_actor?: string,
	): Promise<{ affected: string[] }> {
		// Gather provider ids BEFORE the local mutation (delete_forever removes rows).
		const op = providerOpFor(action.action);
		const byAccount = op === 'none' ? new Map() : this.#gmailIdsByAccount(action.thread_ids);

		const affected = applyThreadActionLocal(this, action);

		// Fan out provider write-back to each owning SyncEngine.
		for (const [account_id, gmail_ids] of byAccount) {
			if (!gmail_ids.length) continue;
			this.#enqueueProviderAction(account_id, { op, gmail_ids });
		}
		return { affected };
	}

	/** message.provider_ids.gmail_id grouped by account, for the given threads. */
	#gmailIdsByAccount(thread_ids: string[]): Map<string, string[]> {
		const map = new Map<string, string[]>();
		if (!thread_ids.length) return map;
		const placeholders = thread_ids.map(() => '?').join(', ');
		const rows = this.exec(
			`SELECT account_id, json_extract(json, '$.provider_ids.gmail_id') AS gmail_id
			 FROM message WHERE thread_id IN (${placeholders})`,
			...thread_ids,
		) as Array<{ account_id: string; gmail_id: string | null }>;
		for (const r of rows) {
			if (!r.gmail_id) continue;
			const list = map.get(r.account_id) ?? [];
			list.push(r.gmail_id);
			map.set(r.account_id, list);
		}
		return map;
	}

	#enqueueProviderAction(account_id: string, payload: unknown): void {
		try {
			const stub = this.#menv.SYNC.get(this.#menv.SYNC.idFromName(account_id)) as unknown as {
				enqueueProviderAction(action: unknown): Promise<void>;
			};
			void stub.enqueueProviderAction(payload);
		} catch (err) {
			console.error('[MailboxServer] enqueue provider action failed:', err);
		}
	}

	/**
	 * Apply a remote flag/label/delete change echoed from a provider (Gmail
	 * history). Idempotent and does NOT re-enqueue provider jobs — this is the
	 * inbound half of two-way sync, so it must not loop (§5.1).
	 */
	async applyRemoteFlagChange(payload: {
		op: 'labels' | 'deleted';
		gmail_id: string;
		state?: { folder: string; is_read: boolean; is_starred: boolean };
	}): Promise<void> {
		const rows = this.exec(
			`SELECT id, thread_id FROM message
			 WHERE json_extract(json, '$.provider_ids.gmail_id') = ? LIMIT 1`,
			payload.gmail_id,
		) as Array<{ id: string; thread_id: string }>;
		if (!rows.length) return;
		const { id, thread_id } = rows[0];

		if (payload.op === 'deleted') {
			try {
				this.delete('message', id);
			} catch {
				/* already gone */
			}
			this.#recountThread(thread_id);
			return;
		}
		if (payload.op === 'labels' && payload.state) {
			this.update('message', id, {
				folder: payload.state.folder,
				is_read: payload.state.is_read,
				is_starred: payload.state.is_starred,
			} as never);
			// Reflect the message's folder onto the thread's primary location.
			try {
				this.update('thread', thread_id, { folder: payload.state.folder } as never);
			} catch {
				/* ignore */
			}
		}
	}

	#recountThread(thread_id: string): void {
		const rows = this.exec(
			`SELECT COUNT(*) AS n, SUM(CASE WHEN is_read = 0 THEN 1 ELSE 0 END) AS unread
			 FROM message WHERE thread_id = ?`,
			thread_id,
		) as Array<{ n: number; unread: number }>;
		const n = rows[0]?.n ?? 0;
		if (n === 0) {
			try {
				this.delete('thread', thread_id);
			} catch {
				/* ignore */
			}
			return;
		}
		try {
			this.update('thread', thread_id, {
				message_count: n,
				unread_count: rows[0]?.unread ?? 0,
			} as never);
		} catch {
			/* ignore */
		}
	}

	// -------------------------------------------------------------------------
	// Send pipeline (§6) — filled in P3.
	// -------------------------------------------------------------------------
	async enqueueSend(
		message: Partial<Message>,
		identity_id: string,
	): Promise<{ message_id: string }> {
		const settings = await this.ensureSettings();
		const undo = (settings.undo_send_seconds ?? 10) * 1000;
		const msg = this.create('message', {
			...message,
			is_outbound: true,
			folder: 'sent',
			send_status: 'queued',
		} as never) as Message;
		this.create('outbox', {
			message_id: msg.id,
			identity_id,
			not_before: Date.now() + undo,
		} as never);
		await this.scheduleJob('outbox', {}, undo);
		return { message_id: String(msg.id) };
	}

	async undoSend(message_id: string): Promise<{ ok: boolean }> {
		const rows = this.exec(
			`SELECT id FROM outbox WHERE message_id = ? LIMIT 1`,
			message_id,
		) as Array<{ id: string }>;
		if (!rows.length) return { ok: false };
		this.delete('outbox', rows[0].id);
		try {
			this.update('message', message_id, { folder: 'drafts', send_status: undefined } as never);
		} catch {
			/* ignore */
		}
		return { ok: true };
	}

	// -------------------------------------------------------------------------
	// Server-side thread listing (SSR / tests).
	// -------------------------------------------------------------------------
	async listThreads(folder: string, limit = 100): Promise<Thread[]> {
		const res = this.list('thread', {
			where: { folder: { eq: folder } },
			order: [{ key: 'last_message_at', direction: 'DESC' }],
			limit,
		} as never) as unknown as { docs: Thread[] };
		return res.docs;
	}

	// -------------------------------------------------------------------------
	// Triage preview (§7.4) — filled in P5.
	// -------------------------------------------------------------------------
	async triageTest(_prompt: string, _count: number): Promise<unknown[]> {
		return [];
	}

	// -------------------------------------------------------------------------
	// Job engine (§5.4) — a tiny persistent alarm queue shared by triage,
	// outbox and push. Jobs are rows in a local (non-synced) `job_queue` table.
	// -------------------------------------------------------------------------
	#ensureJobTable(): void {
		this.exec(
			`CREATE TABLE IF NOT EXISTS job_queue (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				type TEXT NOT NULL,
				payload TEXT,
				run_at INTEGER NOT NULL,
				attempts INTEGER NOT NULL DEFAULT 0,
				status TEXT NOT NULL DEFAULT 'pending'
			)`,
		);
	}

	async scheduleJob(type: string, payload: unknown, delay_ms: number): Promise<void> {
		this.#ensureJobTable();
		const run_at = Date.now() + Math.max(0, delay_ms);
		this.exec(
			`INSERT INTO job_queue (type, payload, run_at) VALUES (?, ?, ?)`,
			type,
			JSON.stringify(payload ?? {}),
			run_at,
		);
		await this.#rearmAlarm();
	}

	async #rearmAlarm(): Promise<void> {
		this.#ensureJobTable();
		const rows = this.exec(
			`SELECT MIN(run_at) AS next FROM job_queue WHERE status = 'pending'`,
		) as Array<{ next: number | null }>;
		const next = rows[0]?.next;
		if (next == null) return;
		const current = await this.ctx.storage.getAlarm();
		if (current == null || next < current) {
			await this.ctx.storage.setAlarm(next);
		}
	}

	async alarm(): Promise<void> {
		this.#ensureJobTable();
		const now = Date.now();
		const due = this.exec(
			`SELECT id, type, payload, attempts FROM job_queue
			 WHERE status = 'pending' AND run_at <= ? ORDER BY run_at ASC LIMIT 20`,
			now,
		) as Array<{ id: number; type: string; payload: string; attempts: number }>;

		for (const job of due) {
			try {
				await this.#runJob(job.type, safeParse(job.payload));
				this.exec(`DELETE FROM job_queue WHERE id = ?`, job.id);
			} catch (err) {
				console.error(`[MailboxServer] job ${job.type} failed:`, err);
				const attempts = job.attempts + 1;
				if (attempts >= 5) {
					this.exec(`UPDATE job_queue SET status = 'failed' WHERE id = ?`, job.id);
				} else {
					const backoff = Math.min(16 * 60_000, 30_000 * 2 ** (attempts - 1));
					this.exec(
						`UPDATE job_queue SET attempts = ?, run_at = ? WHERE id = ?`,
						attempts,
						Date.now() + backoff,
						job.id,
					);
				}
			}
		}
		await this.#rearmAlarm();
	}

	async #runJob(type: string, _payload: unknown): Promise<void> {
		switch (type) {
			case 'triage':
				// Filled in P5 (AI triage pipeline).
				return;
			case 'outbox':
				// Filled in P3 (hand due outbox rows to SyncEngine send jobs).
				return;
			case 'push':
				// Filled in P6.
				return;
			default:
				console.warn(`[MailboxServer] unknown job type: ${type}`);
		}
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

/** Map a thread action to the provider operation for two-way sync (§5.1). */
function providerOpFor(action: string): string {
	switch (action) {
		case 'archive':
			return 'archive';
		case 'trash':
			return 'trash';
		case 'delete':
			return 'delete_forever';
		case 'spam':
			return 'spam';
		case 'read':
			return 'read';
		case 'unread':
			return 'unread';
		case 'star':
			return 'star';
		case 'unstar':
			return 'unstar';
		case 'move':
			return 'move';
		case 'label':
			return 'label';
		default:
			return 'none';
	}
}
