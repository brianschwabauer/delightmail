/**
 * AI triage job (§7). Runs in MailboxServer's alarm per batch of untriaged
 * inbound mail: deterministic pre-pass → AI classification via the AI Gateway
 * dynamic route → code-enforced guardrails → action (bounded by triage_mode) →
 * ai_review audit → unsubscribe task. The pure logic lives in
 * src/lib/mail/triage.ts.
 */
import { createAiGateway } from '@delightstack/ai/server';
import {
	skipsAI,
	matchSenderRule,
	buildTriageMessages,
	parseVerdict,
	applyGuardrails,
	resolveFolder,
	type TriageMode,
	type SenderRule,
	type TriageVerdict,
} from '../../src/lib/mail/triage';
import { extractUnsubscribe } from '../../src/lib/mail/unsubscribe';
import { safeUnsubscribePost } from '../../src/lib/mail/safe-fetch';

export interface TriageMailbox {
	exec(sql: string, ...bindings: unknown[]): Array<Record<string, unknown>>;
	get(entity_type: string, id: string): Record<string, unknown>;
	update(entity_type: string, id: string, data: Record<string, unknown>): unknown;
	create(entity_type: string, data: Record<string, unknown>): Record<string, unknown>;
	broadcastMail(event: Record<string, unknown>): void;
	scheduleJob(type: string, payload: unknown, delay_ms: number): Promise<void>;
}

/** Push mode from settings — 'all' is pushed at ingest; triage owns the rest. */
type PushMode = 'off' | 'mentions' | 'important' | 'all';

export interface TriageEnv {
	AI: unknown;
	AI_GATEWAY_NAME?: string;
	AI_TRIAGE_ROUTE?: string;
}

interface SettingsRow {
	triage_enabled?: boolean;
	triage_prompt?: string;
	triage_mode?: TriageMode;
	push_mode?: PushMode;
	auto_unsubscribe?: boolean;
}

const BATCH = 8;

export async function runTriageJob(mb: TriageMailbox, env: TriageEnv): Promise<boolean> {
	const settings = safeGet(mb, 'settings', 'main') as SettingsRow | null;
	if (!settings?.triage_enabled) return false;
	if (!env.AI || !env.AI_GATEWAY_NAME) return false;

	// Untriaged inbound messages (no ai_review yet).
	const rows = mb.exec(
		`SELECT m.id AS id FROM message m
		 LEFT JOIN ai_review r ON r.message_id = m.id
		 WHERE m.is_outbound = 0 AND m.folder = 'inbox' AND r.id IS NULL
		 ORDER BY m.date DESC LIMIT ?`,
		BATCH,
	) as Array<{ id: string }>;
	if (!rows.length) return false;

	const rules = loadSenderRules(mb);
	const known = loadKnownCorrespondents(mb);
	const gateway = createAiGateway({ ai: env.AI as never, gateway: env.AI_GATEWAY_NAME });
	const model = env.AI_TRIAGE_ROUTE ?? 'dynamic/email-triage';
	const mode: TriageMode = settings.triage_mode ?? 'quarantine';
	// 'all' pushes at ingest; triage owns 'important'/'mentions' (importance is
	// only known here, after classification — pushing at ingest can't gate on it).
	const pushMode: PushMode = settings.push_mode ?? 'important';
	const autoUnsub = !!settings.auto_unsubscribe;

	let processed = false;
	for (const { id } of rows) {
		let msg: Record<string, unknown>;
		try {
			msg = mb.get('message', id);
		} catch {
			continue;
		}
		processed = true;
		await triageOne(
			mb,
			gateway,
			model,
			settings.triage_prompt ?? '',
			mode,
			pushMode,
			autoUnsub,
			rules,
			known,
			id,
			msg,
		);
	}
	return processed;
}

async function triageOne(
	mb: TriageMailbox,
	gateway: ReturnType<typeof createAiGateway>,
	model: string,
	policy: string,
	mode: TriageMode,
	pushMode: PushMode,
	autoUnsub: boolean,
	rules: SenderRule[],
	known: string[],
	id: string,
	msg: Record<string, unknown>,
): Promise<void> {
	const from = msg.from as { email?: string; name?: string } | undefined;
	const headers = (msg.headers_subset ?? {}) as Record<string, string>;
	const fromEmail = (from?.email ?? '').toLowerCase();
	// Match the SENDER, not their whole domain — one known @gmail.com contact must
	// not whitelist every gmail.com sender (§7.2). `known` is a set of addresses.
	const isKnown = known.includes(fromEmail);
	// A reply in a thread the user already participates in (has sent into) skips AI.
	const participated = !!msg.in_reply_to && threadHasOutbound(mb, msg.thread_id as string);

	const signals = {
		from_email: fromEmail,
		list_id: headers.list_id,
		is_outbound: false,
		is_reply_in_participated_thread: participated,
		is_known_correspondent: isKnown,
	};

	// 1. Deterministic pre-pass — human/known/participated mail is inbox+primary.
	if (skipsAI(signals)) {
		writeReview(
			mb,
			id,
			'pre-pass',
			{ action: 'keep', category: 'primary', importance: 2 },
			false,
			'known/participated',
		);
		maybePush(mb, msg, id, pushMode, 2, null);
		return;
	}
	const rule = matchSenderRule(rules, signals);
	if (rule) {
		applyFolder(
			mb,
			msg,
			id,
			rule.action === 'inbox' ? null : ruleFolder(rule.action),
			'promotions',
		);
		writeReview(
			mb,
			id,
			'sender_rule',
			{ action: rule.action, category: 'promotions' },
			false,
			'rule',
		);
		return;
	}

	// 2. AI classification (strict JSON, one retry on invalid → fail-open keep).
	const started = Date.now();
	let verdict: TriageVerdict;
	let tokens = 0;
	try {
		const messages = buildTriageMessages(policy, {
			from: from?.name ? `${from.name} <${fromEmail}>` : fromEmail,
			subject: msg.subject as string,
			list_headers: headers.list_id,
			spf: headers.spf,
			dkim: headers.dkim,
			dmarc: headers.dmarc,
			has_unsubscribe: !!headers.list_unsubscribe,
			text: (msg.text_excerpt as string) ?? '',
			known_correspondent_domains: known,
		});
		let result = await gateway.complete({
			messages,
			model,
			temperature: 0,
			max_tokens: 200,
			response_format: { type: 'json_object' },
		} as never);
		tokens += (result.usage as { total_tokens?: number } | undefined)?.total_tokens ?? 0;
		let parsed = parseVerdict(extractJson(result.content));
		if (!parsed.valid) {
			// One retry before falling back (§7.2).
			result = await gateway.complete({
				messages,
				model,
				temperature: 0,
				max_tokens: 200,
				response_format: { type: 'json_object' },
			} as never);
			tokens += (result.usage as { total_tokens?: number } | undefined)?.total_tokens ?? 0;
			parsed = parseVerdict(extractJson(result.content));
		}
		verdict = parsed.verdict;
	} catch (err) {
		// A gateway/infra failure (5xx, network, timeout). Do NOT swallow it and
		// return: the message stays untriaged, so runTriageJob keeps returning
		// `true` and MailboxServer reschedules triage every 2s — an unbounded spin
		// that re-bills the AI Gateway forever during an outage. Re-throw so the
		// job engine applies exponential backoff (30s→16m). The message stays in
		// the inbox (fail-open) and is retried once the gateway recovers.
		console.error('[triage] gateway call failed:', err);
		throw err instanceof Error ? err : new Error(String(err));
	}

	const guarded = applyGuardrails(verdict, { is_known_correspondent: isKnown });
	const folder = resolveFolder(guarded.verdict, mode);
	applyFolder(mb, msg, id, folder, guarded.verdict.category);
	// Push only for mail that stayed in the inbox and cleared the importance bar.
	maybePush(mb, msg, id, pushMode, guarded.verdict.importance, folder);

	writeReview(
		mb,
		id,
		model,
		guarded.verdict as unknown as Record<string, unknown>,
		guarded.overridden,
		guarded.reason,
		Date.now() - started,
		tokens,
	);

	// Unsubscribe suggestion.
	if (guarded.verdict.unsubscribe_recommended && headers.list_unsubscribe) {
		const cand = extractUnsubscribe({
			list_unsubscribe: headers.list_unsubscribe,
			list_unsubscribe_post: headers.list_unsubscribe_post,
			from_email: fromEmail,
		});
		if (cand) {
			// Auto-execute only http_oneclick, and only when the user opted in
			// (§7.5) — everything else stays a one-click-away suggestion.
			let status: 'suggested' | 'done' | 'failed' = 'suggested';
			if (autoUnsub && cand.method === 'http_oneclick' && cand.target) {
				// SSRF-guarded: target comes from the sender's List-Unsubscribe header
				// (§7.5, H3). safeUnsubscribePost never throws.
				const res = await safeUnsubscribePost(cand.target);
				status = res.ok ? 'done' : 'failed';
			}
			try {
				mb.create('unsubscribe_task', {
					message_id: id,
					sender_domain: cand.sender_domain,
					method: cand.method,
					target: cand.target,
					status,
					completed_at: status === 'done' ? Date.now() : undefined,
				});
			} catch {
				/* ignore */
			}
		}
	}

	mb.broadcastMail({ event: 'triage:done', message_id: id, verdict: guarded.verdict });
}

function applyFolder(
	mb: TriageMailbox,
	msg: Record<string, unknown>,
	id: string,
	folder: string | null,
	category: string,
): void {
	const thread_id = msg.thread_id as string;
	try {
		if (folder) {
			mb.update('message', id, { folder });
			mb.update('thread', thread_id, { folder, category });
		} else {
			mb.update('thread', thread_id, { category });
		}
	} catch {
		/* ignore */
	}
}

function writeReview(
	mb: TriageMailbox,
	message_id: string,
	model: string,
	verdict: Record<string, unknown>,
	overridden: boolean,
	reason?: string,
	latency_ms?: number,
	tokens?: number,
): void {
	try {
		mb.create('ai_review', {
			message_id,
			model,
			verdict: { ...verdict, override_reason: reason },
			action_taken: verdict.action,
			overridden,
			latency_ms,
			tokens,
		});
	} catch (err) {
		console.error('[triage] ai_review write failed:', err);
	}
}

function ruleFolder(action: SenderRule['action']): string | null {
	if (action === 'archive') return 'archive';
	if (action === 'trash') return 'trash';
	if (action === 'spam') return 'spam';
	return null;
}

function loadSenderRules(mb: TriageMailbox): SenderRule[] {
	const rows = mb.exec(`SELECT json FROM sender_rule LIMIT 500`) as Array<{ json?: string }>;
	const out: SenderRule[] = [];
	for (const r of rows) {
		const j = safeJson(r.json);
		if (j.matcher) out.push({ matcher: j.matcher, action: j.action, label_id: j.label_id });
	}
	return out;
}

function loadKnownCorrespondents(mb: TriageMailbox): string[] {
	const rows = mb.exec(
		`SELECT email FROM contact WHERE is_known_correspondent = 1 LIMIT 2000`,
	) as Array<{ email?: string }>;
	const addrs = new Set<string>();
	for (const r of rows) {
		const e = (r.email ?? '').toLowerCase();
		if (e) addrs.add(e);
	}
	return [...addrs];
}

/** True if the user has already sent a message into this thread (participation). */
function threadHasOutbound(mb: TriageMailbox, thread_id: string): boolean {
	if (!thread_id) return false;
	const rows = mb.exec(
		`SELECT 1 FROM message WHERE thread_id = ? AND is_outbound = 1 LIMIT 1`,
		thread_id,
	);
	return rows.length > 0;
}

/**
 * Enqueue a web-push for a freshly-triaged inbox message when it clears the
 * user's push threshold (§10.4). 'all' is handled at ingest; 'off' never pushes.
 */
function maybePush(
	mb: TriageMailbox,
	msg: Record<string, unknown>,
	id: string,
	mode: PushMode,
	importance: number,
	folder: string | null,
): void {
	if (folder !== null) return; // moved out of the inbox → not a new-inbox arrival
	const threshold = mode === 'important' ? 2 : mode === 'mentions' ? 3 : Infinity;
	if (importance < threshold) return;
	const from = msg.from as { email?: string; name?: string } | undefined;
	void mb.scheduleJob(
		'push',
		{
			title: from?.name || from?.email || 'New mail',
			body: (msg.subject as string) ?? '',
			thread_id: msg.thread_id,
		},
		0,
	);
}

function safeGet(mb: TriageMailbox, entity: string, id: string): Record<string, unknown> | null {
	try {
		return mb.get(entity, id);
	} catch {
		return null;
	}
}

function safeJson(s: string | undefined): Record<string, never> {
	if (!s) return {} as Record<string, never>;
	try {
		return JSON.parse(s);
	} catch {
		return {} as Record<string, never>;
	}
}

/** Extract a JSON object from model content (strips ```json fences etc.). */
function extractJson(content: string): unknown {
	const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
	const body = (fenced ? fenced[1] : content).trim();
	const start = body.indexOf('{');
	const end = body.lastIndexOf('}');
	if (start === -1 || end === -1) return null;
	try {
		return JSON.parse(body.slice(start, end + 1));
	} catch {
		return null;
	}
}
