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

export interface TriageMailbox {
	exec(sql: string, ...bindings: unknown[]): Array<Record<string, unknown>>;
	get(entity_type: string, id: string): Record<string, unknown>;
	update(entity_type: string, id: string, data: Record<string, unknown>): unknown;
	create(entity_type: string, data: Record<string, unknown>): Record<string, unknown>;
	broadcastMail(event: Record<string, unknown>): void;
}

export interface TriageEnv {
	AI: unknown;
	AI_GATEWAY_NAME?: string;
	AI_TRIAGE_ROUTE?: string;
}

interface SettingsRow {
	triage_enabled?: boolean;
	triage_prompt?: string;
	triage_mode?: TriageMode;
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
	const knownDomains = loadKnownCorrespondentDomains(mb);
	const gateway = createAiGateway({ ai: env.AI as never, gateway: env.AI_GATEWAY_NAME });
	const model = env.AI_TRIAGE_ROUTE ?? 'dynamic/email-triage';
	const mode: TriageMode = settings.triage_mode ?? 'quarantine';

	let processed = false;
	for (const { id } of rows) {
		let msg: Record<string, unknown>;
		try {
			msg = mb.get('message', id);
		} catch {
			continue;
		}
		processed = true;
		await triageOne(mb, gateway, model, settings.triage_prompt ?? '', mode, rules, knownDomains, id, msg);
	}
	return processed;
}

async function triageOne(
	mb: TriageMailbox,
	gateway: ReturnType<typeof createAiGateway>,
	model: string,
	policy: string,
	mode: TriageMode,
	rules: SenderRule[],
	knownDomains: string[],
	id: string,
	msg: Record<string, unknown>,
): Promise<void> {
	const from = msg.from as { email?: string; name?: string } | undefined;
	const headers = (msg.headers_subset ?? {}) as Record<string, string>;
	const fromEmail = from?.email ?? '';
	const fromDomain = fromEmail.split('@')[1] ?? '';
	const isKnown = knownDomains.includes(fromDomain);

	const signals = {
		from_email: fromEmail,
		list_id: headers.list_id,
		is_outbound: false,
		is_known_correspondent: isKnown,
	};

	// 1. Deterministic pre-pass.
	if (skipsAI(signals)) {
		writeReview(mb, id, 'pre-pass', { action: 'keep', category: 'primary' }, false, 'known/participated');
		return;
	}
	const rule = matchSenderRule(rules, signals);
	if (rule) {
		applyFolder(mb, msg, id, rule.action === 'inbox' ? null : ruleFolder(rule.action), 'promotions');
		writeReview(mb, id, 'sender_rule', { action: rule.action, category: 'promotions' }, false, 'rule');
		return;
	}

	// 2. AI classification.
	const started = Date.now();
	let verdict: TriageVerdict;
	let valid: boolean;
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
			known_correspondent_domains: knownDomains,
		});
		const result = await gateway.complete({ messages, model, temperature: 0, max_tokens: 200 });
		tokens = (result.usage as { total_tokens?: number } | undefined)?.total_tokens ?? 0;
		const json = extractJson(result.content);
		({ verdict, valid } = parseVerdict(json));
	} catch (err) {
		console.error('[triage] gateway call failed:', err);
		return; // leave untriaged; a later job retries
	}

	const guarded = applyGuardrails(verdict, { is_known_correspondent: isKnown });
	const folder = resolveFolder(guarded.verdict, mode);
	applyFolder(mb, msg, id, folder, guarded.verdict.category);

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
			try {
				mb.create('unsubscribe_task', {
					message_id: id,
					sender_domain: cand.sender_domain,
					method: cand.method,
					target: cand.target,
					status: 'suggested',
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

function loadKnownCorrespondentDomains(mb: TriageMailbox): string[] {
	const rows = mb.exec(
		`SELECT email FROM contact WHERE is_known_correspondent = 1 LIMIT 2000`,
	) as Array<{ email?: string }>;
	const domains = new Set<string>();
	for (const r of rows) {
		const d = (r.email ?? '').split('@')[1]?.toLowerCase();
		if (d) domains.add(d);
	}
	return [...domains];
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
