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
import { ingestBatch, maintainContacts, type NormalizedMessage } from './ingest';
import { applyThreadActionLocal } from './actions';
import { runTriageJob } from './triage';
import { parseEmail } from '../../src/lib/mail/mime';
import { sanitizeEmailHtml } from '../../src/lib/mail/sanitize';
import { messagePrefix, writeBodies, writeAttachments } from './body-store';

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
	VAPID_PUBLIC_KEY?: string;
	VAPID_PRIVATE_KEY?: string;
	VAPID_SUBJECT?: string;
	SEND_DAILY_LIMIT?: string;
}

const SETTINGS_ID = 'main';

// Exponential backoff ladder (§5.4): 30s, 1m, 2m, 4m, 8m, 16m, then give up.
// The cap must be reachable — the old ×5/attempts<5 form topped out at 4m.
const MAX_JOB_ATTEMPTS = 7;
function retryBackoffMs(attempts: number): number {
	return Math.min(16 * 60_000, 30_000 * 2 ** (attempts - 1));
}
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

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
	// Custom-domain (cf_domain) accounts + aliases (§5.2).
	// -------------------------------------------------------------------------
	/** Find or create the cf_domain account for a domain (the mailbox itself). */
	async ensureCfDomainAccount(domain: string): Promise<{ account_id: string }> {
		const existing = this.exec(
			`SELECT id FROM account WHERE email = ? AND kind = 'cf_domain' LIMIT 1`,
			domain,
		) as Array<{ id: string }>;
		if (existing.length) return { account_id: existing[0].id };
		const account = this.create('account', {
			kind: 'cf_domain',
			email: domain,
			display_name: domain,
			color: '#0891b2',
			status: 'live',
			config: { domain },
		} as never) as { id: string };
		return { account_id: String(account.id) };
	}

	/** Auto-create an identity for a first-seen alias (catch-all ⇒ infinite). */
	async ensureIdentity(account_id: string, email: string): Promise<void> {
		const existing = this.exec(
			`SELECT id FROM identity WHERE email = ? LIMIT 1`,
			email.toLowerCase(),
		) as Array<{ id: string }>;
		if (existing.length) return;
		const isFirst =
			(this.exec(`SELECT COUNT(*) AS n FROM identity`) as Array<{ n: number }>)[0]?.n === 0;
		this.create('identity', {
			account_id,
			email: email.toLowerCase(),
			name: email.split('@')[0],
			is_default: isFirst,
			auto_created: true,
		} as never);
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
		const inbound = result.new_messages.filter((m) => m.is_outbound === false);
		if (inbound.length) await this.scheduleJob('triage', {}, 0);

		// Web push (§10.4). Only 'all' mode pushes at ingest; 'important'/'mentions'
		// push from the triage job, where the message's importance is actually known
		// (pushing here would fire before classification, defeating the threshold).
		if (this.#menv.VAPID_PUBLIC_KEY) {
			const settings = await this.ensureSettings();
			if ((settings.push_mode ?? 'important') === 'all') {
				const first = inbound.find((m) => m.folder === 'inbox');
				if (first) {
					await this.scheduleJob(
						'push',
						{
							title: first.from?.name || first.from?.email || 'New mail',
							body: first.subject ?? '',
							thread_id: first.thread_id,
						},
						0,
					);
				}
			}
		}
		// Ensure the weekly digest is scheduled (§7.2 safety net).
		await this.#ensureDigestScheduled();
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
	// Send pipeline (§6).
	// -------------------------------------------------------------------------
	async enqueueSend(
		payload: {
			to: { name?: string; email?: string }[];
			cc?: { name?: string; email?: string }[];
			bcc?: { name?: string; email?: string }[];
			subject: string;
			html: string;
			text: string;
			in_reply_to?: string;
			references?: string[];
			thread_id?: string;
			draft_doc?: string;
			attachments?: Array<{ r2_key: string; filename: string; mime_type: string; size?: number }>;
		},
		identity_id: string,
	): Promise<{ message_id: string }> {
		const settings = await this.ensureSettings();
		const undo = (settings.undo_send_seconds ?? 10) * 1000;
		// Rate-limit outbound (§6, §12). Over budget → push the send later rather
		// than dropping it (the outbox row still persists), protecting sender
		// reputation from a compromised session without losing the user's mail.
		const extraDelay = await this.#reserveSendSlot();

		const identity = this.get('identity', identity_id) as {
			id: string;
			email: string;
			name?: string;
			account_id: string;
		};
		const rfc822 = `<${crypto.randomUUID()}@${identity.email.split('@')[1] ?? 'delightmail.local'}>`;
		const now = Date.now();

		// Store the rendered body in R2 (content-addressed on the message id).
		const prefix = `${this.#orgName}/msg/${await sha40(rfc822)}`;
		try {
			await Promise.all([
				this.#menv.R2.put(`${prefix}/body.html`, payload.html, {
					httpMetadata: { contentType: 'text/html; charset=utf-8' },
				}),
				this.#menv.R2.put(`${prefix}/body.txt`, payload.text, {
					httpMetadata: { contentType: 'text/plain; charset=utf-8' },
				}),
			]);
		} catch (err) {
			console.error('[MailboxServer] send body R2 write failed:', err);
		}

		// Thread: join the existing one or create a new sent thread.
		let thread_id = payload.thread_id;
		if (!thread_id) {
			const thread = this.create('thread', {
				subject: payload.subject || '(no subject)',
				subject_normalized: payload.subject.toLowerCase(),
				snippet: payload.text.slice(0, 120),
				participants: payload.to,
				participant_text: payload.to.map((a) => a.email).join(', '),
				account_ids: [identity.account_id],
				message_count: 0,
				folder: 'sent',
				last_message_at: now,
			} as never) as Thread;
			thread_id = String(thread.id);
		}

		const msg = this.create('message', {
			thread_id,
			account_id: identity.account_id,
			identity_email: identity.email,
			rfc822_message_id: rfc822,
			in_reply_to: payload.in_reply_to,
			references: payload.references,
			from: { name: identity.name, email: identity.email },
			from_text: identity.name ? `${identity.name} ${identity.email}` : identity.email,
			to: payload.to,
			cc: payload.cc,
			bcc: payload.bcc,
			subject: payload.subject,
			text_excerpt: payload.text.slice(0, 8192),
			body_keys: { html: `${prefix}/body.html`, text: `${prefix}/body.txt` },
			date: now,
			is_read: true,
			is_outbound: true,
			folder: 'sent',
			draft_doc: payload.draft_doc,
			attachment_count: payload.attachments?.length ?? 0,
			send_status: 'queued',
		} as never) as Message;

		// Attachment rows for the sent copy (bytes already uploaded to R2).
		for (const att of payload.attachments ?? []) {
			this.create('attachment', {
				message_id: msg.id,
				filename: att.filename,
				mime_type: att.mime_type,
				size_bytes: att.size ?? 0,
				r2_key: att.r2_key,
			} as never);
		}

		// Recording recipients as known correspondents here (not just when the sent
		// copy syncs back) covers cf_domain/imap accounts that have no sync-back.
		maintainContacts(this as never, {
			is_outbound: true,
			to: payload.to,
			cc: payload.cc,
		} as NormalizedMessage);

		this.create('outbox', {
			message_id: msg.id,
			identity_id,
			not_before: now + undo + extraDelay,
		} as never);
		await this.scheduleJob('outbox', {}, undo + extraDelay + 500);
		this.broadcastMail({ event: 'send:status', message_id: msg.id, status: 'queued' });
		return { message_id: String(msg.id) };
	}

	/** Hand due outbox rows (past their undo window) to the owning SyncEngine. */
	async #flushOutbox(): Promise<void> {
		const now = Date.now();
		const rows = this.exec(
			`SELECT id, message_id, identity_id FROM outbox WHERE not_before <= ? LIMIT 20`,
			now,
		) as Array<{ id: string; message_id: string; identity_id: string }>;
		for (const row of rows) {
			let msg: Message;
			try {
				msg = this.get('message', row.message_id) as Message;
			} catch {
				this.delete('outbox', row.id);
				continue;
			}
			const identity = this.get('identity', row.identity_id) as { account_id: string };
			this.update('message', row.message_id, { send_status: 'sending' } as never);
			this.broadcastMail({ event: 'send:status', message_id: row.message_id, status: 'sending' });

			const attachments = this.exec(
				`SELECT filename, mime_type, r2_key FROM attachment WHERE message_id = ?`,
				row.message_id,
			) as Array<{ filename: string; mime_type: string; r2_key: string }>;

			const stub = this.#menv.SYNC.get(
				this.#menv.SYNC.idFromName(identity.account_id),
			) as unknown as { enqueueSendJob(payload: unknown): Promise<void> };
			try {
				await stub.enqueueSendJob({
					message_id: row.message_id,
					rfc822_message_id: msg.rfc822_message_id,
					body_keys: msg.body_keys,
					from: msg.from,
					to: msg.to,
					cc: msg.cc,
					bcc: msg.bcc,
					subject: msg.subject,
					in_reply_to: msg.in_reply_to,
					references: msg.references,
					attachments,
					gmail_thread_id: (msg.provider_ids as { gmail_thread_id?: string } | undefined)
						?.gmail_thread_id,
				});
				this.delete('outbox', row.id);
			} catch (err) {
				console.error('[MailboxServer] outbox handoff failed:', err);
			}
		}
	}

	/** Called by SyncEngine after a successful/failed transport send. */
	async markSendResult(
		message_id: string,
		result: { ok: boolean; provider_ids?: Record<string, unknown>; error?: string },
	): Promise<void> {
		try {
			this.update('message', message_id, {
				send_status: result.ok ? 'sent' : 'failed',
				...(result.provider_ids ? { provider_ids: result.provider_ids } : {}),
			} as never);
		} catch {
			/* ignore */
		}
		this.broadcastMail({
			event: 'send:status',
			message_id,
			status: result.ok ? 'sent' : 'failed',
			error: result.error,
		});
	}

	async undoSend(message_id: string): Promise<{ ok: boolean }> {
		const rows = this.exec(
			`SELECT id, not_before FROM outbox WHERE message_id = ? LIMIT 1`,
			message_id,
		) as Array<{ id: string; not_before: number }>;
		if (!rows.length) return { ok: false };
		// Only honour undo while the message is still inside its undo window AND
		// still queued. Once #flushOutbox has flipped it to 'sending' and handed it
		// to the SyncEngine, the mail may already be on the wire — reverting the row
		// then would show "unsent" while it actually goes out (send-after-undo race).
		const msg = this.get('message', message_id) as Message;
		if (rows[0].not_before <= Date.now() || msg.send_status !== 'queued') {
			return { ok: false };
		}
		this.delete('outbox', rows[0].id);
		try {
			this.update('message', message_id, {
				folder: 'drafts',
				is_draft: true,
				send_status: undefined,
			} as never);
		} catch {
			/* ignore */
		}
		this.broadcastMail({ event: 'send:status', message_id, status: 'canceled' });
		return { ok: true };
	}

	/**
	 * Reserve an outbound-send slot against two token buckets (§6): a burst cap
	 * (10/min) and a daily cap (default 100/day, SEND_DAILY_LIMIT-tunable). Returns
	 * the extra delay (ms) to push the send out by when over budget, or 0.
	 */
	async #reserveSendSlot(): Promise<number> {
		const org = this.#orgName;
		const daily = Math.max(1, Number(this.#menv.SEND_DAILY_LIMIT ?? 100));
		let delay = 0;
		try {
			delay = Math.max(
				delay,
				await this.#consumeBucket(`send-burst:${org}`, { max_tokens: 10, refill_every_seconds: 6 }),
				await this.#consumeBucket(`send-daily:${org}`, {
					max_tokens: daily,
					refill_every_seconds: Math.max(1, Math.round(86_400 / daily)),
				}),
			);
		} catch (err) {
			// Never block a send because the limiter DO is unreachable — fail open.
			console.error('[MailboxServer] rate-limit check failed:', err);
		}
		return delay;
	}

	async #consumeBucket(
		key: string,
		opts: { max_tokens: number; refill_every_seconds: number },
	): Promise<number> {
		const stub = this.#menv.RATE_LIMITER.get(
			this.#menv.RATE_LIMITER.idFromName(key),
		) as unknown as {
			setOptions(o: unknown): Promise<void>;
			consume(k: string, cost: number): Promise<boolean>;
			getStatus(k: string): Promise<{ reset_in_ms: number }>;
		};
		await stub.setOptions(opts);
		if (await stub.consume('send', 1)) return 0;
		const status = await stub.getStatus('send');
		return status.reset_in_ms ?? 0;
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
	// Triage preview (§7.4) — run the prompt against recent mail without acting.
	// -------------------------------------------------------------------------
	async triageTest(prompt: string, count: number): Promise<unknown[]> {
		if (!this.#menv.AI || !this.#menv.AI_GATEWAY_NAME) {
			return [{ error: 'AI Gateway is not configured on this instance.' }];
		}
		const { createAiGateway } = await import('@delightstack/ai/server');
		const { buildTriageMessages, parseVerdict, applyGuardrails } = await import(
			'../../src/lib/mail/triage'
		);
		const gateway = createAiGateway({
			ai: this.#menv.AI as never,
			gateway: this.#menv.AI_GATEWAY_NAME,
		});
		const model = this.#menv.AI_TRIAGE_ROUTE ?? 'dynamic/email-triage';

		const rows = this.exec(
			`SELECT id FROM message WHERE is_outbound = 0 AND folder = 'inbox' ORDER BY date DESC LIMIT ?`,
			Math.min(20, Math.max(1, count)),
		) as Array<{ id: string }>;

		const out: unknown[] = [];
		for (const { id } of rows) {
			let msg: Message;
			try {
				msg = this.get('message', id) as Message;
			} catch {
				continue;
			}
			const from = msg.from as { email?: string; name?: string } | undefined;
			const headers = (msg.headers_subset ?? {}) as Record<string, string>;
			try {
				const messages = buildTriageMessages(prompt, {
					from: from?.email,
					subject: msg.subject ?? undefined,
					has_unsubscribe: !!headers.list_unsubscribe,
					text: msg.text_excerpt ?? '',
					known_correspondent_domains: [],
				});
				const result = await gateway.complete({
					messages,
					model,
					temperature: 0,
					max_tokens: 200,
					response_format: { type: 'json_object' },
				} as never);
				const json = safeParse(
					result.content.slice(result.content.indexOf('{'), result.content.lastIndexOf('}') + 1),
				);
				const { verdict } = parseVerdict(json);
				const guarded = applyGuardrails(verdict, { is_known_correspondent: false });
				out.push({
					subject: msg.subject,
					from: from?.email,
					verdict: guarded.verdict,
					overridden: guarded.overridden,
				});
			} catch (err) {
				out.push({ subject: msg.subject, error: (err as Error).message });
			}
		}
		return out;
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
				if (attempts >= MAX_JOB_ATTEMPTS) {
					this.exec(`UPDATE job_queue SET status = 'failed' WHERE id = ?`, job.id);
				} else {
					this.exec(
						`UPDATE job_queue SET attempts = ?, run_at = ? WHERE id = ?`,
						attempts,
						Date.now() + retryBackoffMs(attempts),
						job.id,
					);
				}
			}
		}
		await this.#rearmAlarm();
	}

	/** Send a web push to every registered device (§10.4). */
	async #sendPush(payload: { title?: string; body?: string; thread_id?: string }): Promise<void> {
		const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } = this.#menv;
		if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return;
		// Quiet hours (§10.4): suppress non-digest pushes inside the window.
		const settings = await this.ensureSettings();
		if (withinQuietHours(settings.quiet_hours ?? undefined)) return;
		const { sendWebPush } = await import('./webpush');
		const subs = this.exec(`SELECT id, json FROM push_subscription`) as Array<{
			id: string;
			json?: string;
		}>;
		const unread = this.exec(
			`SELECT COUNT(*) AS n FROM thread WHERE folder = 'inbox' AND unread_count > 0`,
		) as Array<{ n: number }>;
		const body = JSON.stringify({
			title: payload.title ?? 'New mail',
			body: payload.body ?? '',
			thread_id: payload.thread_id,
			badge: unread[0]?.n ?? 0,
		});
		for (const row of subs) {
			const sub = safeParse(row.json ?? '') as {
				endpoint?: string;
				keys?: { p256dh: string; auth: string };
			};
			if (!sub.endpoint || !sub.keys) continue;
			try {
				const res = await sendWebPush(
					{ endpoint: sub.endpoint, keys: sub.keys },
					body,
					{ publicKey: VAPID_PUBLIC_KEY, privateKey: VAPID_PRIVATE_KEY, subject: VAPID_SUBJECT ?? 'mailto:admin@delightmail' },
				);
				if (res.status === 404 || res.status === 410) {
					// Subscription gone — prune it.
					try {
						this.delete('push_subscription', row.id);
					} catch {
						/* ignore */
					}
				}
			} catch (err) {
				console.error('[MailboxServer] web push failed:', err);
			}
		}
	}

	async #runJob(type: string, _payload: unknown): Promise<void> {
		switch (type) {
			case 'triage': {
				const more = await runTriageJob(this as never, {
					AI: this.#menv.AI,
					AI_GATEWAY_NAME: this.#menv.AI_GATEWAY_NAME,
					AI_TRIAGE_ROUTE: this.#menv.AI_TRIAGE_ROUTE,
				});
				// Drain the queue: if a full batch ran there may be more.
				if (more) await this.scheduleJob('triage', {}, 2000);
				return;
			}
			case 'outbox':
				return this.#flushOutbox();
			case 'push':
				return this.#sendPush(_payload as { title?: string; body?: string; thread_id?: string });
			case 'digest':
				return this.#sendDigest();
			case 'replay_r2':
				return this.replayInboundEmail(
					(_payload as { raw_key?: string }).raw_key ?? '',
					(_payload as { to?: string }).to ?? '',
				);
			default:
				console.warn(`[MailboxServer] unknown job type: ${type}`);
		}
	}

	/**
	 * Re-ingest an inbound message from its captured R2 raw (§5.2, R8). Enqueued by
	 * the email() handler when the first ingest attempt throws after R2 capture, so
	 * a transient DO hiccup never silently loses mail.
	 */
	async replayInboundEmail(raw_key: string, to: string): Promise<void> {
		if (!raw_key || !to) return;
		const obj = await this.#menv.R2.get(raw_key);
		if (!obj) return; // already cleaned up / expired
		const rawBytes = new Uint8Array(await obj.arrayBuffer());
		const domain = to.split('@')[1]?.toLowerCase() ?? '';
		const { account_id } = await this.ensureCfDomainAccount(domain);
		await this.ensureIdentity(account_id, to.toLowerCase());

		const parsed = await parseEmail(rawBytes);
		const html = parsed.html ? sanitizeEmailHtml(parsed.html, { cidBase: '/api/attachments' }) : '';
		const prefix = await messagePrefix(this.#orgName, parsed.rfc822_message_id);
		const body_keys = await writeBodies(this.#menv.R2, prefix, {
			raw: rawBytes,
			html: html || undefined,
			text: parsed.text || undefined,
		});
		const attachments = await writeAttachments(
			this.#menv.R2,
			prefix,
			parsed.attachments.map((a) => ({
				filename: a.filename,
				mime_type: a.mime_type,
				content: a.content,
				content_id: a.content_id,
				size_bytes: a.size_bytes,
			})),
		);
		await this.ingestMessages([
			{
				rfc822_message_id: parsed.rfc822_message_id,
				account_id,
				identity_email: to.toLowerCase(),
				in_reply_to: parsed.in_reply_to,
				references: parsed.references,
				from: parsed.from,
				to: parsed.to,
				cc: parsed.cc,
				bcc: parsed.bcc,
				reply_to: parsed.reply_to,
				subject: parsed.subject,
				snippet: parsed.snippet,
				text_excerpt: parsed.text_excerpt,
				body_keys,
				date: parsed.date,
				is_read: false,
				is_outbound: false,
				folder: 'inbox',
				headers_subset: parsed.headers_subset as Record<string, unknown>,
				attachments,
				attachment_count: parsed.attachments.length,
				size_bytes: parsed.size_bytes,
			},
		]);
		await this.#menv.KV.delete(`pending-email:${raw_key}`).catch(() => {});
	}

	/** Schedule the recurring weekly digest once (idempotent). */
	async #ensureDigestScheduled(): Promise<void> {
		this.#ensureJobTable();
		const rows = this.exec(
			`SELECT 1 FROM job_queue WHERE type = 'digest' AND status = 'pending' LIMIT 1`,
		);
		if (rows.length) return;
		await this.scheduleJob('digest', {}, WEEK_MS);
	}

	/**
	 * Weekly digest (§7.2, §7.5): summarize what AI triage filtered in the last
	 * week — count, top senders, pending unsubscribe suggestions — as a push, then
	 * reschedule itself. The safety net that makes aggressive filtering trustworthy.
	 */
	async #sendDigest(): Promise<void> {
		try {
			const since = Date.now() - WEEK_MS;
			const filtered = this.exec(
				`SELECT COUNT(*) AS n FROM message
				 WHERE folder IN ('quarantine','spam','trash','archive') AND date >= ?`,
				since,
			) as Array<{ n: number }>;
			const topSenders = this.exec(
				`SELECT json_extract(json, '$.from.email') AS email, COUNT(*) AS n FROM message
				 WHERE folder IN ('quarantine','spam','trash') AND date >= ?
				 GROUP BY email ORDER BY n DESC LIMIT 3`,
				since,
			) as Array<{ email: string | null; n: number }>;
			const unsub = this.exec(
				`SELECT COUNT(*) AS n FROM unsubscribe_task WHERE status = 'suggested'`,
			) as Array<{ n: number }>;
			const count = filtered[0]?.n ?? 0;
			const senders = topSenders
				.map((s) => s.email)
				.filter(Boolean)
				.join(', ');
			const suggestions = unsub[0]?.n ?? 0;
			// Only notify if there's something to say.
			if (count > 0 || suggestions > 0) {
				await this.#sendPush({
					title: `Weekly digest — ${count} filtered`,
					body: [
						senders ? `Top senders: ${senders}` : '',
						suggestions ? `${suggestions} unsubscribe suggestion(s)` : '',
					]
						.filter(Boolean)
						.join(' · '),
				});
			}
		} finally {
			// Re-arm next week regardless of outcome.
			await this.scheduleJob('digest', {}, WEEK_MS);
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

/**
 * True if the current UTC time falls within a "HH:MM-HH:MM" quiet-hours window
 * (§10.4). Handles windows that wrap past midnight (e.g. 22:00-07:00). Uses UTC
 * since the DO has no user timezone; deployers document this in settings.
 */
function withinQuietHours(window: string | undefined): boolean {
	if (!window) return false;
	const m = window.match(/^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/);
	if (!m) return false;
	const start = Number(m[1]) * 60 + Number(m[2]);
	const end = Number(m[3]) * 60 + Number(m[4]);
	const now = new Date();
	const cur = now.getUTCHours() * 60 + now.getUTCMinutes();
	return start <= end ? cur >= start && cur < end : cur >= start || cur < end;
}

/** First 40 hex chars of a SHA-256 — the content-addressed R2 key component. */
async function sha40(input: string): Promise<string> {
	const data = new TextEncoder().encode(input);
	const digest = await crypto.subtle.digest('SHA-256', data);
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 40);
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
