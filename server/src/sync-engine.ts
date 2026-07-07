/**
 * SyncEngine — one Durable Object per connected account (§2 key decision).
 * A protocol head: Gmail history sync, IMAP polling (P7), backfill, watch
 * renewal, outbound send jobs, and provider write-back. Normalizes messages and
 * delivers them to MailboxServer via idempotent RPC batches (ingestMessages).
 *
 * Alarm-driven job queue with exponential backoff (§5.4). AES-GCM-encrypted
 * credentials in local SQLite (§12). No user-visible data lives here.
 */
import { DurableObject } from 'cloudflare:workers';
import { encryptSecret, decryptSecret } from './crypto';
import {
	GmailClient,
	refreshAccessToken,
	gmailToNormalized,
	gmailLabelsToState,
	base64UrlToBytes,
	RetryableError,
	type GmailMessage,
} from './adapters/gmail';
import type { NormalizedMessage } from './ingest';
import { buildMimeMessage, stripBccHeader } from './mime-build';
import type { Address } from '../../src/lib/schema';

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
	EMAIL?: { send(message: unknown): Promise<void> };
	MAIL_FROM?: string;
	SMTP_RELAY_HOST?: string;
	SMTP_RELAY_PORT?: string;
	SMTP_RELAY_USER?: string;
	SMTP_RELAY_PASS?: string;
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
	backfill_ingested?: number;
	backfill_total?: number;
	label_map?: Record<string, string>;
	label_map_at?: number;
	access_token?: string;
	access_token_expiry?: number;
}

// Exponential backoff ladder (§5.4): 30s, 1m, 2m, 4m, 8m, 16m, then give up.
const MAX_ATTEMPTS = 7;
const JOB_TIME_BUDGET_MS = 25_000;
const RAW_BATCH = 20; // messages.get chunk size
// ~20 msg/s throttle (Gmail per-user quota is 250 units/s; messages.get = 5
// units, §5.1). Pause this long after each RAW_BATCH so backfill can't outrun it.
const RAW_BATCH_PAUSE_MS = 1_000;
function retryBackoffMs(attempts: number): number {
	return Math.min(16 * 60_000, 30_000 * 2 ** (attempts - 1));
}

interface MailboxStub {
	ingestMessages(batch: unknown[]): Promise<{ ingested: number; skipped: number }>;
	broadcastMail(event: Record<string, unknown>): void;
	update(entity_type: string, id: string, data: Record<string, unknown>): unknown;
	applyRemoteFlagChange(payload: unknown): Promise<void>;
	markSendResult(
		message_id: string,
		result: { ok: boolean; provider_ids?: Record<string, unknown>; error?: string },
	): Promise<void>;
}

interface SendPayload {
	message_id: string;
	rfc822_message_id: string;
	body_keys?: { html?: string; text?: string };
	from?: Address;
	to?: Address[];
	cc?: Address[];
	bcc?: Address[];
	subject?: string;
	in_reply_to?: string;
	references?: string[];
	attachments?: Array<{ filename: string; mime_type: string; r2_key: string }>;
	gmail_thread_id?: string;
}

export class SyncEngine extends DurableObject<SyncEnv> {
	readonly #sql: SqlStorage;

	constructor(ctx: DurableObjectState, env: SyncEnv) {
		super(ctx, env);
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
		return this.env.MAILBOX.get(
			this.env.MAILBOX.idFromName(state.org_id),
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
			? await encryptSecret(JSON.stringify(input.credentials), this.env.CREDENTIALS_ENCRYPTION_KEY)
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
		this.#saveState({
			backfill_cursor: undefined,
			gmail_history_id: undefined,
			backfill_ingested: 0,
			backfill_total: undefined,
		});
		await this.scheduleJob('backfill_page', { page_token: null }, 0);
	}
	async destroyAccount(): Promise<void> {
		await this.ctx.storage.deleteAll();
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
		const plain = await decryptSecret(
			state.credentials_encrypted,
			this.env.CREDENTIALS_ENCRYPTION_KEY,
		);
		return plain ? (JSON.parse(plain) as { refresh_token: string }) : null;
	}

	async #accessToken(): Promise<string> {
		const state = this.#state();
		if (state.access_token && (state.access_token_expiry ?? 0) > Date.now() + 60_000) {
			return state.access_token;
		}
		const creds = await this.#credentials();
		if (!creds?.refresh_token) throw new Error('No Gmail refresh token stored');
		if (!this.env.GOOGLE_CLIENT_ID || !this.env.GOOGLE_CLIENT_SECRET) {
			throw new Error('GOOGLE_CLIENT_ID/SECRET not configured');
		}
		const { access_token, expires_in } = await refreshAccessToken(
			this.env.GOOGLE_CLIENT_ID,
			this.env.GOOGLE_CLIENT_SECRET,
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
		const current = await this.ctx.storage.getAlarm();
		if (current == null || row.next < current) await this.ctx.storage.setAlarm(row.next);
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
				if (attempts >= MAX_ATTEMPTS) {
					this.#sql.exec(
						`UPDATE job SET status = 'failed', last_error = ? WHERE id = ?`,
						message,
						job.id,
					);
					await this.#reportError(message);
				} else {
					this.#sql.exec(
						`UPDATE job SET attempts = ?, run_at = ?, last_error = ? WHERE id = ?`,
						attempts,
						Date.now() + retryBackoffMs(attempts),
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
			case 'send':
				return this.#sendMessage(payload as SendPayload);
			case 'poll_imap':
				return this.#pollImap();
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

		// Record the total estimate on the first page so progress is real, not 50/100.
		let total = state.backfill_total;
		if (total == null && list.resultSizeEstimate != null) {
			total = list.resultSizeEstimate;
			this.#saveState({ backfill_total: total });
		}

		let ingestedSoFar = state.backfill_ingested ?? 0;
		for (let i = 0; i < ids.length; i += RAW_BATCH) {
			const slice = ids.slice(i, i + RAW_BATCH);
			const batch = await this.#fetchAndNormalize(gmail, slice);
			if (batch.length) await this.#mailbox().ingestMessages(batch);
			ingestedSoFar += slice.length;
			// Throttle to ~20 msg/s so a large backfill can't blow the Gmail quota.
			if (i + RAW_BATCH < ids.length) await sleep(RAW_BATCH_PAUSE_MS);
		}
		this.#saveState({ backfill_cursor: list.nextPageToken, backfill_ingested: ingestedSoFar });

		const percent =
			total && total > 0 && list.nextPageToken
				? Math.min(99, Math.round((ingestedSoFar / total) * 100))
				: list.nextPageToken
					? 50
					: 100;
		this.#emitProgress('backfill', percent);

		if (list.nextPageToken) {
			await this.scheduleJob(
				'backfill_page',
				{ page_token: list.nextPageToken },
				RAW_BATCH_PAUSE_MS,
			);
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
		if (!this.env.GMAIL_PUBSUB_TOPIC) {
			// No Pub/Sub configured → fall back to polling (§5.1).
			const seconds = Number(this.env.GMAIL_POLL_SECONDS ?? 90);
			await this.scheduleJob('history_sync', {}, seconds * 1000);
			await this.scheduleJob('renew_watch', {}, seconds * 1000);
			return;
		}
		const gmail = await this.#gmail();
		const res = await gmail.watch(this.env.GMAIL_PUBSUB_TOPIC);
		this.#saveState({ gmail_watch_expiry: Number(res.expiration) });
		// Re-arm 6 days out (watches expire after 7, §5.1).
		await this.scheduleJob('renew_watch', {}, 6 * 24 * 60 * 60 * 1000);
	}

	async #sendMessage(payload: SendPayload): Promise<void> {
		const state = this.#state();
		const htmlObj = payload.body_keys?.html ? await this.env.R2.get(payload.body_keys.html) : null;
		const textObj = payload.body_keys?.text ? await this.env.R2.get(payload.body_keys.text) : null;
		const html = htmlObj ? await htmlObj.text() : '';
		const text = textObj ? await textObj.text() : '';
		// Pull each attachment's bytes from R2 and base64-encode for the MIME build.
		const attachments = [];
		for (const att of payload.attachments ?? []) {
			const obj = await this.env.R2.get(att.r2_key);
			if (!obj) continue;
			attachments.push({
				filename: att.filename,
				mime_type: att.mime_type,
				base64: bytesToBase64(new Uint8Array(await obj.arrayBuffer())),
			});
		}
		const built = buildMimeMessage({
			from: payload.from ?? { email: state.account_email },
			to: payload.to ?? [],
			cc: payload.cc,
			bcc: payload.bcc,
			subject: payload.subject ?? '',
			html,
			text,
			in_reply_to: payload.in_reply_to,
			references: payload.references,
			message_id: payload.rfc822_message_id,
			attachments,
		});

		const fromEmail = payload.from?.email ?? state.account_email ?? '';
		let result: { ok: boolean; provider_ids?: Record<string, unknown>; error?: string };
		try {
			if (state.kind === 'gmail') {
				const gmail = await this.#gmail();
				const rawB64Url = base64UrlEncode(built.raw);
				const sent = await gmail.send(rawB64Url, payload.gmail_thread_id);
				result = { ok: true, provider_ids: { gmail_id: sent.id, gmail_thread_id: sent.threadId } };
			} else if (state.kind === 'imap') {
				// IMAP identity → the account's OWN SMTP submission creds, not the
				// deployer's global relay (§6). (APPEND to \Sent is gated on the R1
				// spike; until then the local folder='sent' copy is the record.)
				const creds = (await this.#decryptCreds()) as {
					smtp?: { host: string; port: number; user?: string; pass?: string };
				} | null;
				if (!creds?.smtp?.host) throw new Error('No SMTP credentials for this IMAP account');
				await this.#sendViaSmtp(built.raw, fromEmail, payload, creds.smtp);
				result = { ok: true };
			} else {
				// cf_domain: Cloudflare Email Service, else the global SMTP relay (§6).
				await this.#sendViaEmailServiceOrSmtp(built.raw, fromEmail, payload);
				result = { ok: true };
			}
		} catch (err) {
			result = { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
		await this.#mailbox().markSendResult(payload.message_id, result);
		if (!result.ok) throw new Error(result.error); // let the job retry with backoff
	}

	#recipients(payload: SendPayload): string[] {
		return [...(payload.to ?? []), ...(payload.cc ?? []), ...(payload.bcc ?? [])]
			.map((a) => a.email)
			.filter((e): e is string => !!e);
	}

	/** Send a raw MIME message via Cloudflare Email Service, else the global relay. */
	async #sendViaEmailServiceOrSmtp(
		raw: string,
		fromEmail: string,
		payload: SendPayload,
	): Promise<void> {
		const recipients = this.#recipients(payload);
		if (!recipients.length) throw new Error('No recipients');

		// 1. Cloudflare Email Service (env.EMAIL binding).
		if (this.env.EMAIL) {
			const mod: unknown = await import(/* @vite-ignore */ 'cloudflare:email').catch(() => null);
			const EmailMessage = (
				mod as { EmailMessage?: new (from: string, to: string, raw: string) => unknown }
			)?.EmailMessage;
			if (EmailMessage) {
				// Deliver per-recipient via the envelope; strip Bcc from the header so
				// blind-copy recipients aren't disclosed to everyone (§6, H1).
				const safeRaw = stripBccHeader(raw);
				for (const to of recipients) {
					await this.env.EMAIL.send(new EmailMessage(fromEmail, to, safeRaw));
				}
				return;
			}
		}

		// 2. Global SMTP relay fallback.
		if (this.env.SMTP_RELAY_HOST) {
			await this.#sendViaSmtp(raw, fromEmail, payload, {
				host: this.env.SMTP_RELAY_HOST,
				port: Number(this.env.SMTP_RELAY_PORT ?? 587),
				user: this.env.SMTP_RELAY_USER,
				pass: this.env.SMTP_RELAY_PASS,
			});
			return;
		}

		throw new Error(
			'No outbound transport for this domain. Onboard it to Cloudflare Email Service or set SMTP_RELAY_* env.',
		);
	}

	/** Send a raw MIME message over an explicit SMTP endpoint (worker-mailer). */
	async #sendViaSmtp(
		raw: string,
		fromEmail: string,
		payload: SendPayload,
		cfg: { host: string; port: number; user?: string; pass?: string },
	): Promise<void> {
		const recipients = this.#recipients(payload);
		if (!recipients.length) throw new Error('No recipients');
		const mod: unknown = await import(/* @vite-ignore */ 'worker-mailer').catch(() => null);
		const WorkerMailer = (
			mod as {
				WorkerMailer?: {
					connect(o: unknown): Promise<{ send(m: unknown): Promise<void>; close(): Promise<void> }>;
				};
			}
		)?.WorkerMailer;
		if (!WorkerMailer) throw new Error('worker-mailer unavailable for SMTP send');
		const port = cfg.port || 587;
		const mailer = await WorkerMailer.connect({
			host: cfg.host,
			port,
			secure: port === 465,
			startTls: port !== 465,
			authType: 'plain',
			credentials: cfg.user && cfg.pass ? { username: cfg.user, password: cfg.pass } : undefined,
		});
		// Bcc is delivered via the `to` envelope list above; strip it from the
		// header so recipients never see the blind-copy list (§6, H1).
		await mailer.send({ from: fromEmail, to: recipients, raw: stripBccHeader(raw) });
		await mailer.close();
	}

	// -------------------------------------------------------------------------
	// IMAP (§5.3) — R1 spike-gated. imapflow over node:tls under nodejs_compat.
	// If Workers sockets prove insufficient, the adapter interface is unchanged
	// and a Cloudflare Container bridge is dropped in behind it.
	// -------------------------------------------------------------------------
	/** RPC connection test for the add-account UI. */
	async testImap(cfg: {
		host: string;
		port: number;
		secure: boolean;
		user: string;
		pass: string;
	}): Promise<{ ok: boolean; error?: string; folders?: string[] }> {
		try {
			const client = await this.#imapConnect(cfg);
			if (!client) {
				return {
					ok: false,
					error:
						'IMAP transport unavailable in this runtime — see R1 spike (imapflow over Workers sockets, or the Container fallback).',
				};
			}
			const list = (await client.list()) as Array<{ path: string }>;
			await client.logout();
			return { ok: true, folders: list.map((f) => f.path).slice(0, 50) };
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	}

	async #pollImap(): Promise<void> {
		const creds = (await this.#decryptCreds()) as {
			imap?: { host: string; port: number; secure: boolean; user: string; pass: string };
		} | null;
		const seconds = Number(this.env.GMAIL_POLL_SECONDS ?? 120);
		if (!creds?.imap) {
			await this.scheduleJob('poll_imap', {}, seconds * 1000);
			return;
		}
		try {
			const client = await this.#imapConnect(creds.imap);
			if (!client) {
				await this.#setStatus('error', 'IMAP unavailable (R1 spike required)');
				return; // do not tight-loop when the transport can't run
			}
			// A full poll (folder UIDVALIDITY/UIDNEXT diff → fetch new → ingest)
			// is implemented against the imapflow API once R1 confirms sockets.
			await client.logout();
			await this.#setStatus('live');
		} catch (err) {
			await this.#setStatus('error', err instanceof Error ? err.message : String(err));
		}
		await this.scheduleJob('poll_imap', {}, seconds * 1000);
	}

	/** Connect via imapflow (dynamic import); returns null if unavailable. */
	async #imapConnect(cfg: {
		host: string;
		port: number;
		secure: boolean;
		user: string;
		pass: string;
	}): Promise<{
		list(): Promise<unknown>;
		logout(): Promise<void>;
	} | null> {
		// Computed specifier so the bundler doesn't try to resolve imapflow at
		// build time (it's an optional dep, installed only once the R1 spike
		// confirms Workers-socket IMAP). Absent → graceful null.
		const spec = ['imap', 'flow'].join('');
		const mod: unknown = await import(/* @vite-ignore */ spec).catch(() => null);
		const ImapFlow = (mod as { ImapFlow?: new (opts: unknown) => unknown })?.ImapFlow;
		if (!ImapFlow) return null;
		const client = new ImapFlow({
			host: cfg.host,
			port: cfg.port,
			secure: cfg.secure,
			auth: { user: cfg.user, pass: cfg.pass },
			logger: false,
		}) as { connect(): Promise<void>; list(): Promise<unknown>; logout(): Promise<void> };
		await client.connect();
		return client;
	}

	async #decryptCreds(): Promise<Record<string, unknown> | null> {
		const state = this.#state();
		if (!state.credentials_encrypted) return null;
		const plain = await decryptSecret(
			state.credentials_encrypted,
			this.env.CREDENTIALS_ENCRYPTION_KEY,
		);
		return plain ? (JSON.parse(plain) as Record<string, unknown>) : null;
	}

	async #setStatus(status: string, detail?: string): Promise<void> {
		const s = this.#state();
		if (!s.account_id) return;
		try {
			this.#mailbox().update('account', s.account_id, {
				status,
				...(detail ? { status_detail: detail } : {}),
			});
		} catch {
			/* ignore */
		}
	}

	async #providerAction(payload: ProviderActionPayload): Promise<void> {
		const state = this.#state();
		// Two-way write-back is implemented for Gmail; IMAP STORE/MOVE is gated on
		// the R1 spike (§5.3). Non-gmail accounts must not call #gmail() (no token) —
		// the local action already applied; provider echo lands when IMAP ships.
		if (state.kind !== 'gmail') {
			console.log(`[SyncEngine] provider_action ${payload.op} skipped (kind=${state.kind}, R1)`);
			return;
		}
		// Label create/map and free-form moves aren't mapped to Gmail yet; skip
		// rather than throw so the job doesn't retry forever on an unmapped op.
		if (payload.op === 'move' || payload.op === 'label') {
			console.log(`[SyncEngine] provider_action ${payload.op} not yet mapped to Gmail labels`);
			return;
		}
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

	/** Gmail label-id → name map for USER labels, cached in sync_state (~1h TTL). */
	async #labelMap(gmail: GmailClient): Promise<Record<string, string>> {
		const state = this.#state();
		if (state.label_map && Date.now() - (state.label_map_at ?? 0) < 60 * 60_000) {
			return state.label_map;
		}
		try {
			const res = await gmail.listLabels();
			const map: Record<string, string> = {};
			for (const l of res.labels ?? []) {
				if (l.type === 'user') map[l.id] = l.name;
			}
			this.#saveState({ label_map: map, label_map_at: Date.now() });
			return map;
		} catch (err) {
			console.error('[SyncEngine] label list failed:', err);
			return state.label_map ?? {};
		}
	}

	async #fetchAndNormalize(gmail: GmailClient, ids: string[]): Promise<NormalizedMessage[]> {
		const state = this.#state();
		const labelMap = await this.#labelMap(gmail);
		const out: NormalizedMessage[] = [];
		for (const id of ids) {
			let msg: GmailMessage;
			try {
				msg = await gmail.getRaw(id);
			} catch (err) {
				if (err instanceof RetryableError) throw err;
				// Message no longer retrievable at Gmail (e.g. 404 — deleted between
				// the list and this fetch). Nothing to capture; safe to skip.
				console.error(`[SyncEngine] getRaw ${id} failed, skipping:`, err);
				continue;
			}
			try {
				out.push(
					await gmailToNormalized(msg, {
						account_id: state.account_id!,
						org_id: state.org_id!,
						r2: this.env.R2,
						labelMap,
					}),
				);
			} catch (err) {
				// Retryable (incl. R2 write blips) → bubble up so the whole page retries
				// and the cursor is NOT advanced past this message.
				if (err instanceof RetryableError) throw err;
				// Non-retryable (e.g. unparseable MIME): capture the raw bytes durably
				// before moving on, so the message is recoverable rather than silently
				// lost when the sync cursor advances (§5.1, R8).
				await this.#deadLetterRawMessage(state, id, msg.raw ?? '', err);
			}
		}
		return out;
	}

	/**
	 * Persist a message that could not be normalized (bad MIME, etc.) so it is
	 * never silently lost: the raw bytes go to a durable R2 dead-letter key and a
	 * KV marker records it for operator visibility / replay. If even the R2
	 * capture fails, throw RetryableError so the page retries rather than advancing
	 * the sync cursor past an unrecoverable message (§5.1, R8).
	 */
	async #deadLetterRawMessage(
		state: SyncState,
		gmail_id: string,
		rawB64Url: string,
		cause: unknown,
	): Promise<void> {
		const key = `${state.org_id}/deadletter/gmail/${state.account_id}/${gmail_id}.eml`;
		try {
			await this.env.R2.put(key, base64UrlToBytes(rawB64Url), {
				httpMetadata: { contentType: 'message/rfc822' },
			});
		} catch (putErr) {
			throw new RetryableError(`dead-letter capture failed for ${gmail_id}: ${String(putErr)}`);
		}
		try {
			await this.env.KV.put(
				`deadletter:${state.org_id}:${state.account_id}:${gmail_id}`,
				JSON.stringify({ key, error: String(cause), at: Date.now() }),
			);
		} catch {
			/* marker is best-effort; the R2 raw is the durable record */
		}
		console.error(`[SyncEngine] dead-lettered message ${gmail_id} → ${key}:`, cause);
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

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Standard base64 of arbitrary bytes (chunked so large files don't overflow). */
function bytesToBase64(bytes: Uint8Array): string {
	let bin = '';
	const CHUNK = 0x8000;
	for (let i = 0; i < bytes.length; i += CHUNK) {
		bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
	}
	return btoa(bin);
}

/** base64url encode a raw MIME string for Gmail's messages.send. */
function base64UrlEncode(raw: string): string {
	const bytes = new TextEncoder().encode(raw);
	let bin = '';
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
