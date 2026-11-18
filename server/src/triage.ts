/**
 * AI triage job. Runs in MailboxServer's alarm per batch of untriaged
 * inbound mail:
 *   free signals → your rules → built-in rules → sender inheritance → Claude
 *   (Haiku, with a Sonnet second opinion on uncertain moves) → code-enforced
 *   guardrails → move (bounded by triage_mode) → ai_review audit → unsubscribe task.
 *
 * Moves go through MailboxServer.applyThreadAction, the same path a user's own
 * archive takes, so Gmail is told too and inbound sync can't drag the mail back.
 * The pure logic lives in src/lib/mail/triage.ts.
 */
import {
	skipsAI,
	matchSenderRule,
	buildTriageSystem,
	buildTriageUser,
	buildTriageMessages,
	parseVerdict,
	applyGuardrails,
	resolveFolder,
	shouldEscalate,
	describeMatcher,
	isRoutedCategory,
	BUILTIN_RULES,
	DEFAULT_TRIAGE_PROMPT,
	FALLBACK_VERDICT,
	VERDICT_JSON_SCHEMA,
	type TriageMode,
	type SenderRule,
	type TriageVerdict,
	type MessageSignals,
} from '../../src/lib/mail/triage';
import { extractUnsubscribe } from '../../src/lib/mail/unsubscribe';
import { safeUnsubscribePost } from '../../src/lib/mail/safe-fetch';
import { claudeJson, TRIAGE_MODEL, ESCALATION_MODEL } from './claude';

export interface TriageMailbox {
	exec(sql: string, ...bindings: unknown[]): Array<Record<string, unknown>>;
	get(entity_type: string, id: string): Record<string, unknown>;
	update(entity_type: string, id: string, data: Record<string, unknown>): unknown;
	create(entity_type: string, data: Record<string, unknown>): Record<string, unknown>;
	broadcastMail(event: Record<string, unknown>): void;
	scheduleJob(type: string, payload: unknown, delay_ms: number): Promise<void>;
	applyThreadAction(action: {
		thread_ids: string[];
		action: string;
		folder?: string;
	}): Promise<{ affected: string[] }>;
}

/** Push mode from settings — 'all' is pushed at ingest; triage owns the rest. */
type PushMode = 'off' | 'mentions' | 'important' | 'all';

export interface TriageEnv {
	ANTHROPIC_API_KEY?: string;
	/** Legacy backend for self-hosters: a Cloudflare AI Gateway dynamic route. */
	AI?: unknown;
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

/** True when some model backend is configured. */
export function triageConfigured(env: TriageEnv): boolean {
	return !!env.ANTHROPIC_API_KEY || !!(env.AI && env.AI_GATEWAY_NAME);
}

/** What triage decided for one message, before (or without) acting on it. */
export interface Decision {
	stage: 'pre-pass' | 'rule' | 'builtin' | 'inherit' | 'model';
	/** Audit label: the model id(s), or the stage for deterministic decisions. */
	model: string;
	verdict: TriageVerdict;
	folder: string | null;
	overridden: boolean;
	reason?: string;
	rule?: SenderRule;
	input_tokens: number;
	output_tokens: number;
	cost_usd: number;
	latency_ms?: number;
}

export interface TriageContext {
	mb: TriageMailbox;
	env: TriageEnv;
	policy: string;
	mode: TriageMode;
	rules: SenderRule[];
	known: Set<string>;
}

export function loadTriageContext(
	mb: TriageMailbox,
	env: TriageEnv,
	settings: SettingsRow,
	policy_override?: string,
): TriageContext {
	return {
		mb,
		env,
		policy: (policy_override ?? settings.triage_prompt ?? '').trim() || DEFAULT_TRIAGE_PROMPT,
		mode: settings.triage_mode ?? 'quarantine',
		rules: loadSenderRules(mb),
		known: loadKnownCorrespondents(mb),
	};
}

export async function runTriageJob(mb: TriageMailbox, env: TriageEnv): Promise<boolean> {
	const settings = safeGet(mb, 'settings', 'main') as SettingsRow | null;
	if (!settings?.triage_enabled) return false;
	if (!triageConfigured(env)) return false;

	// Untriaged inbound messages (no ai_review yet).
	const rows = mb.exec(
		`SELECT m.id AS id FROM message m
		 LEFT JOIN ai_review r ON r.message_id = m.id
		 WHERE m.is_outbound = 0 AND m.folder = 'inbox' AND r.id IS NULL
		 ORDER BY m.date DESC LIMIT ?`,
		BATCH,
	) as Array<{ id: string }>;
	if (!rows.length) return false;

	const ctx = loadTriageContext(mb, env, settings);
	// 'all' pushes at ingest; triage owns 'important'/'mentions' (importance is
	// only known here, after classification — pushing at ingest can't gate on it).
	const push_mode: PushMode = settings.push_mode ?? 'important';
	const auto_unsub = !!settings.auto_unsubscribe;

	let processed = false;
	for (const { id } of rows) {
		let msg: Record<string, unknown>;
		try {
			msg = mb.get('message', id);
		} catch {
			continue;
		}
		processed = true;
		// A model outage throws out of decide(): the job engine backs off and the
		// message stays untriaged in the inbox (fail-open) until it recovers.
		const decision = await decide(ctx, id, msg);
		await applyDecision(mb, id, msg, decision, push_mode, auto_unsub);
	}
	return processed;
}

/** Decide where a message belongs. Spends model tokens but writes nothing. */
export async function decide(
	ctx: TriageContext,
	id: string,
	msg: Record<string, unknown>,
): Promise<Decision> {
	const { mb, mode } = ctx;
	const from = msg.from as { email?: string; name?: string } | undefined;
	const headers = (msg.headers_subset ?? {}) as Record<string, string>;
	const from_email = (from?.email ?? '').toLowerCase();
	// Match the SENDER, not their whole domain — one known @gmail.com contact must
	// not whitelist every gmail.com sender.
	const is_known = ctx.known.has(from_email);
	// A reply in a thread the user already participates in (has sent into) skips AI.
	const participated = !!msg.in_reply_to && threadHasOutbound(mb, msg.thread_id as string);

	const signals: MessageSignals = {
		from_email,
		from_name: from?.name,
		subject: msg.subject as string | undefined,
		list_id: headers.list_id,
		is_outbound: false,
		is_reply_in_participated_thread: participated,
		is_known_correspondent: is_known,
	};
	const free = { input_tokens: 0, output_tokens: 0, cost_usd: 0, overridden: false };

	// 1. Free signals — human/known/participated mail is inbox+primary.
	if (skipsAI(signals)) {
		return {
			...free,
			stage: 'pre-pass',
			model: 'pre-pass',
			verdict: { ...FALLBACK_VERDICT, confidence: 1, summary: 'Someone you correspond with' },
			folder: null,
			reason: 'known/participated',
		};
	}

	// 2. Your rules, then the built-in ones (yours win: they're listed first and
	// a tie in specificity keeps the earlier match).
	const user_rule = matchSenderRule(ctx.rules, signals);
	const rule = user_rule ?? (mode === 'label_only' ? null : matchSenderRule(BUILTIN_RULES, signals));
	if (rule) {
		const folder = ruleFolder(rule.action);
		const category = isRoutedCategory(rule.action)
			? rule.action
			: rule.action === 'inbox'
				? 'primary'
				: 'promotions';
		return {
			...free,
			stage: user_rule ? 'rule' : 'builtin',
			model: user_rule ? 'rule' : 'builtin',
			verdict: {
				...FALLBACK_VERDICT,
				category,
				action: folder ? 'archive' : 'keep',
				importance: folder ? 0 : 2,
				confidence: 1,
				summary: `${rule.name ?? 'Your rule'}: ${describeMatcher(rule.matcher)}`.slice(0, 120),
			},
			folder,
			rule,
		};
	}

	// 3. Inheritance — this sender's last pitch is still sitting in Pitches, so
	// the follow-up in their sequence goes the same way without a model call.
	// Moving that pitch back out turns this off for them. (Pitches only: a
	// shared address like notifications@github.com also carries real reviews.)
	if (mode !== 'label_only' && lastPitchStillFiled(mb, from_email, id)) {
		return {
			...free,
			stage: 'inherit',
			model: 'inherit',
			verdict: {
				...FALLBACK_VERDICT,
				category: 'pitches',
				action: 'archive',
				importance: 0,
				confidence: 1,
				summary: 'Follow-up from a sender already in Pitches',
			},
			folder: 'pitches',
		};
	}

	// 4. The model.
	const started = Date.now();
	const input = {
		from: from?.name ? `${from.name} <${from_email}>` : from_email,
		subject: msg.subject as string,
		list_headers: headers.list_id,
		spf: headers.spf,
		dkim: headers.dkim,
		dmarc: headers.dmarc,
		has_unsubscribe: !!headers.list_unsubscribe,
		auto_submitted: headers.auto_submitted,
		precedence: headers.precedence,
		prior_from_sender: priorFromSender(mb, from_email, id),
		text: (msg.text_excerpt as string) ?? '',
	};
	const result = await classify(ctx, input);
	const guarded = applyGuardrails(result.verdict, { is_known_correspondent: is_known });
	return {
		stage: 'model',
		model: result.model,
		verdict: guarded.verdict,
		folder: resolveFolder(guarded.verdict, mode),
		overridden: guarded.overridden,
		reason: guarded.reason ?? result.note,
		input_tokens: result.input_tokens,
		output_tokens: result.output_tokens,
		cost_usd: result.cost_usd,
		latency_ms: Date.now() - started,
	};
}

interface ClassifyResult {
	verdict: TriageVerdict;
	model: string;
	note?: string;
	input_tokens: number;
	output_tokens: number;
	cost_usd: number;
}

/**
 * One verdict from the configured backend. Throws only on a retryable failure
 * (outage, rate limit, bad key); a per-message failure (refusal, a rejected
 * request) falls back to "keep" so one odd email can't stall the queue.
 */
async function classify(
	ctx: TriageContext,
	input: Parameters<typeof buildTriageUser>[0],
): Promise<ClassifyResult> {
	const api_key = ctx.env.ANTHROPIC_API_KEY;
	if (!api_key) return classifyViaGateway(ctx, input);

	const system = buildTriageSystem(ctx.policy);
	const user = buildTriageUser(input);
	const totals = { input_tokens: 0, output_tokens: 0, cost_usd: 0 };
	const ask = async (model: string) => {
		const res = await claudeJson({ api_key, model, system, user, schema: VERDICT_JSON_SCHEMA });
		if (res.usage) {
			totals.input_tokens +=
				res.usage.input_tokens +
				res.usage.cache_creation_input_tokens +
				res.usage.cache_read_input_tokens;
			totals.output_tokens += res.usage.output_tokens;
			totals.cost_usd += res.cost_usd ?? 0;
		}
		return res;
	};

	const first = await ask(TRIAGE_MODEL);
	if (!first.ok) {
		if (first.retryable) throw new Error(`[triage] ${TRIAGE_MODEL}: ${first.error}`);
		console.error(`[triage] ${TRIAGE_MODEL} gave no verdict: ${first.error}`);
		return { ...totals, verdict: FALLBACK_VERDICT, model: TRIAGE_MODEL, note: first.error };
	}
	const parsed = parseVerdict(first.value);
	if (!parsed.valid) {
		return { ...totals, verdict: FALLBACK_VERDICT, model: TRIAGE_MODEL, note: 'invalid verdict' };
	}
	if (!shouldEscalate(parsed.verdict)) {
		return { ...totals, verdict: parsed.verdict, model: TRIAGE_MODEL };
	}

	// An uncertain move (usually pitch vs. real inquiry) gets a second opinion.
	// If that fails for any reason the first verdict stands; the guardrails'
	// confidence floor still applies to it.
	const second = await ask(ESCALATION_MODEL);
	const reparsed = second.ok ? parseVerdict(second.value) : null;
	if (reparsed?.valid) {
		return { ...totals, verdict: reparsed.verdict, model: `${TRIAGE_MODEL}→${ESCALATION_MODEL}` };
	}
	return {
		...totals,
		verdict: parsed.verdict,
		model: TRIAGE_MODEL,
		note: `escalation failed: ${second.ok ? 'invalid verdict' : second.error}`,
	};
}

/** The AI Gateway dynamic-route backend, for deployments without an Anthropic key. */
async function classifyViaGateway(
	ctx: TriageContext,
	input: Parameters<typeof buildTriageUser>[0],
): Promise<ClassifyResult> {
	const { createAiGateway } = await import('@delightstack/ai/server');
	const gateway = createAiGateway({
		ai: ctx.env.AI as never,
		gateway: ctx.env.AI_GATEWAY_NAME,
	});
	const model = ctx.env.AI_TRIAGE_ROUTE ?? 'dynamic/email-triage';
	const messages = buildTriageMessages(ctx.policy, input);
	let tokens = 0;
	let parsed = { verdict: FALLBACK_VERDICT, valid: false };
	// One retry on invalid JSON. A gateway/infra failure throws out of here so
	// the job engine backs off instead of re-billing every 2s during an outage.
	for (let attempt = 0; attempt < 2 && !parsed.valid; attempt++) {
		const result = await gateway.complete({
			messages,
			model,
			max_tokens: 300,
			response_format: { type: 'json_object' },
		} as never);
		tokens += (result.usage as { total_tokens?: number } | undefined)?.total_tokens ?? 0;
		parsed = parseVerdict(extractJson(result.content));
	}
	return {
		verdict: parsed.verdict,
		model,
		note: parsed.valid ? undefined : 'invalid verdict',
		input_tokens: tokens,
		output_tokens: 0,
		cost_usd: 0,
	};
}

/** Act on a decision: move, label, audit, push, unsubscribe suggestion. */
async function applyDecision(
	mb: TriageMailbox,
	id: string,
	msg: Record<string, unknown>,
	d: Decision,
	push_mode: PushMode,
	auto_unsub: boolean,
): Promise<void> {
	const thread_id = msg.thread_id as string;
	if (d.folder && thread_id) {
		try {
			await mb.applyThreadAction({ thread_ids: [thread_id], action: 'move', folder: d.folder });
		} catch (err) {
			console.error('[triage] move failed:', err);
		}
	}
	try {
		mb.update('thread', thread_id, { category: d.verdict.category });
	} catch {
		/* thread gone */
	}
	if (d.rule?.id) bumpRuleHits(mb, d.rule.id);

	writeReview(mb, id, d);

	// Push only for mail that stayed in the inbox and cleared the importance bar.
	maybePush(mb, msg, push_mode, d.verdict.importance, d.folder);

	if (d.stage === 'model') await maybeSuggestUnsubscribe(mb, id, msg, d.verdict, auto_unsub);

	mb.broadcastMail({ event: 'triage:done', message_id: id, verdict: d.verdict });
}

async function maybeSuggestUnsubscribe(
	mb: TriageMailbox,
	id: string,
	msg: Record<string, unknown>,
	verdict: TriageVerdict,
	auto_unsub: boolean,
): Promise<void> {
	const headers = (msg.headers_subset ?? {}) as Record<string, string>;
	if (!verdict.unsubscribe_recommended || !headers.list_unsubscribe) return;
	const from = msg.from as { email?: string } | undefined;
	const cand = extractUnsubscribe({
		list_unsubscribe: headers.list_unsubscribe,
		list_unsubscribe_post: headers.list_unsubscribe_post,
		from_email: (from?.email ?? '').toLowerCase(),
	});
	if (!cand) return;
	// Auto-execute only http_oneclick, and only when the user opted in;
	// everything else stays a one-click-away suggestion.
	let status: 'suggested' | 'done' | 'failed' = 'suggested';
	if (auto_unsub && cand.method === 'http_oneclick' && cand.target) {
		// SSRF-guarded: target comes from the sender's List-Unsubscribe header;
		// safeUnsubscribePost never throws.
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

function writeReview(mb: TriageMailbox, message_id: string, d: Decision): void {
	try {
		mb.create('ai_review', {
			message_id,
			model: d.model,
			verdict: { ...d.verdict, override_reason: d.reason },
			action_taken: d.folder ?? 'keep',
			overridden: d.overridden,
			latency_ms: d.latency_ms,
			tokens: d.input_tokens + d.output_tokens,
			input_tokens: d.input_tokens,
			output_tokens: d.output_tokens,
			cost_usd: d.cost_usd,
		});
	} catch (err) {
		console.error('[triage] ai_review write failed:', err);
	}
}

function ruleFolder(action: SenderRule['action']): string | null {
	switch (action) {
		case 'notifications':
		case 'pitches':
		case 'archive':
		case 'trash':
		case 'spam':
			return action;
		default:
			return null;
	}
}

function loadSenderRules(mb: TriageMailbox): SenderRule[] {
	// `action` and `label_id` are scalar columns. `matcher` is an object: its own
	// column since database v3, the `json` blob on rows the v3 move hasn't reached.
	const rows = mb.exec(
		`SELECT id, COALESCE(matcher, json_extract(json, '$.matcher')) AS matcher, action, label_id
		 FROM sender_rule LIMIT 500`,
	) as Array<{ id: string; matcher?: string; action?: string; label_id?: string | null }>;
	const out: SenderRule[] = [];
	for (const r of rows) {
		const matcher = safeJson(r.matcher) as SenderRule['matcher'];
		if (!Object.keys(matcher).length || !r.action) continue;
		out.push({
			id: r.id,
			matcher,
			action: r.action as SenderRule['action'],
			label_id: r.label_id ?? undefined,
		});
	}
	return out;
}

function bumpRuleHits(mb: TriageMailbox, rule_id: string): void {
	try {
		const rows = mb.exec(`SELECT hit_count FROM sender_rule WHERE id = ?`, rule_id) as Array<{
			hit_count?: number;
		}>;
		mb.update('sender_rule', rule_id, { hit_count: (rows[0]?.hit_count ?? 0) + 1 });
	} catch {
		/* rule deleted meanwhile */
	}
}

function loadKnownCorrespondents(mb: TriageMailbox): Set<string> {
	const rows = mb.exec(
		`SELECT email FROM contact WHERE is_known_correspondent = 1 LIMIT 5000`,
	) as Array<{ email?: string }>;
	const addrs = new Set<string>();
	for (const r of rows) {
		const e = (r.email ?? '').toLowerCase();
		if (e) addrs.add(e);
	}
	return addrs;
}

const FROM_EMAIL_SQL = `lower(COALESCE(json_extract(m."from", '$.email'), json_extract(m.json, '$.from.email')))`;

/** Earlier inbound messages from this exact address. */
function priorFromSender(mb: TriageMailbox, from_email: string, exclude_id: string): number {
	if (!from_email) return 0;
	const rows = mb.exec(
		`SELECT COUNT(*) AS n FROM message m WHERE m.is_outbound = 0 AND m.id != ? AND ${FROM_EMAIL_SQL} = ?`,
		exclude_id,
		from_email,
	) as Array<{ n: number }>;
	return rows[0]?.n ?? 0;
}

/**
 * True when this sender's most recent AI-filed pitch is still in Pitches.
 * False when there's none, or when the user moved it back out (a correction:
 * ask the model again).
 */
function lastPitchStillFiled(mb: TriageMailbox, from_email: string, exclude_id: string): boolean {
	if (!from_email) return false;
	const category = `COALESCE(json_extract(r.verdict, '$.category'), json_extract(r.json, '$.verdict.category'))`;
	const rows = mb.exec(
		`SELECT m.folder AS folder
		 FROM ai_review r JOIN message m ON m.id = r.message_id
		 WHERE ${category} = 'pitches' AND m.id != ? AND ${FROM_EMAIL_SQL} = ?
		 ORDER BY m.date DESC LIMIT 1`,
		exclude_id,
		from_email,
	) as Array<{ folder?: string }>;
	return rows[0]?.folder === 'pitches';
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
 * user's push threshold. 'all' is handled at ingest; 'off' never pushes.
 */
function maybePush(
	mb: TriageMailbox,
	msg: Record<string, unknown>,
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
