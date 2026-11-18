import { describe, it, expect, vi } from 'vitest';

// A gateway whose completion always fails (simulates an AI Gateway outage).
vi.mock('@delightstack/ai/server', () => ({
	createAiGateway: () => ({
		complete: () => Promise.reject(new Error('AI Gateway 503')),
	}),
}));

import { runTriageJob, type TriageMailbox } from './triage';

/** Fake MailboxServer surface: one untriaged inbox message, triage enabled. */
function fakeMailbox(): {
	mb: TriageMailbox;
	reviews: Array<Record<string, unknown>>;
	scheduled: string[];
	moves: Array<{ thread_ids: string[]; action: string; folder?: string }>;
} {
	const reviews: Array<Record<string, unknown>> = [];
	const scheduled: string[] = [];
	const moves: Array<{ thread_ids: string[]; action: string; folder?: string }> = [];
	const mb: TriageMailbox = {
		exec(sql: string) {
			if (sql.includes('FROM message m') && sql.includes('ai_review')) return [{ id: 'm1' }];
			// sender_rule, contact, threadHasOutbound → all empty.
			return [];
		},
		get(entity: string, id: string) {
			if (entity === 'settings') return { triage_enabled: true, triage_mode: 'quarantine' };
			if (entity === 'message')
				return {
					id,
					thread_id: 't1',
					from: { email: 'stranger@example.com', name: 'Stranger' },
					subject: 'Buy now',
					headers_subset: {},
					text_excerpt: 'hello',
					in_reply_to: null,
				};
			throw new Error('not found');
		},
		update() {},
		create(_e, data) {
			reviews.push(data);
			return data;
		},
		broadcastMail() {},
		async scheduleJob(type: string) {
			scheduled.push(type);
		},
		async applyThreadAction(action) {
			moves.push(action);
			return { affected: action.thread_ids };
		},
	};
	return { mb, reviews, scheduled, moves };
}

describe('runTriageJob — no infinite spin on gateway outage', () => {
	it('propagates a gateway error instead of swallowing it (so the job backs off, not re-runs every 2s)', async () => {
		const { mb, reviews } = fakeMailbox();
		await expect(
			runTriageJob(mb, { AI: {}, AI_GATEWAY_NAME: 'gw', AI_TRIAGE_ROUTE: 'dynamic/email-triage' }),
		).rejects.toThrow(/AI Gateway 503/);
		// The message was left untriaged (no ai_review written) — it stays in the
		// inbox (fail-open) and is retried on the next backed-off run, not dropped.
		expect(reviews).toHaveLength(0);
	});

	it('is a no-op (returns false) when triage is disabled', async () => {
		const { mb } = fakeMailbox();
		mb.get = ((entity: string) =>
			entity === 'settings' ? { triage_enabled: false } : {}) as TriageMailbox['get'];
		await expect(runTriageJob(mb, { AI: {}, AI_GATEWAY_NAME: 'gw' })).resolves.toBe(false);
	});
});

/** A fetch stub answering the Messages API with the given verdicts, in order. */
function stubClaude(responses: Array<{ status?: number; verdict?: Record<string, unknown> }>) {
	const calls: Array<{ model: string }> = [];
	vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
		const body = JSON.parse(init.body) as { model: string };
		calls.push({ model: body.model });
		const r = responses.shift() ?? { status: 500 };
		if (r.status && r.status !== 200) return new Response('{"error":{}}', { status: r.status });
		return Response.json({
			stop_reason: 'end_turn',
			content: [{ type: 'text', text: JSON.stringify(r.verdict) }],
			usage: { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
		});
	});
	return calls;
}

const PITCH = {
	summary: 'Cold staffing pitch',
	category: 'pitches',
	action: 'archive',
	importance: 0,
	confidence: 0.95,
	unsubscribe_recommended: false,
};

describe('runTriageJob — Claude backend', () => {
	it('files a confident pitch through applyThreadAction (so Gmail hears about it) and records cost', async () => {
		const calls = stubClaude([{ verdict: PITCH }]);
		const { mb, reviews, moves } = fakeMailbox();
		await runTriageJob(mb, { ANTHROPIC_API_KEY: 'k' });
		expect(calls.map((c) => c.model)).toEqual(['claude-haiku-5-5']);
		expect(moves).toEqual([{ thread_ids: ['t1'], action: 'move', folder: 'pitches' }]);
		expect(reviews[0].action_taken).toBe('pitches');
		expect(reviews[0].cost_usd).toBeGreaterThan(0);
		vi.unstubAllGlobals();
	});

	it('asks Sonnet for a second opinion on an uncertain move', async () => {
		const calls = stubClaude([
			{ verdict: { ...PITCH, confidence: 0.6 } },
			{ verdict: { ...PITCH, category: 'primary', action: 'keep', confidence: 0.8 } },
		]);
		const { mb, reviews, moves } = fakeMailbox();
		await runTriageJob(mb, { ANTHROPIC_API_KEY: 'k' });
		expect(calls.map((c) => c.model)).toEqual(['claude-haiku-5-5', 'claude-sonnet-5-5']);
		expect(moves).toEqual([]);
		expect(reviews[0].model).toBe('claude-haiku-5-5→claude-sonnet-5-5');
		vi.unstubAllGlobals();
	});

	it('backs off on an outage instead of filing the message', async () => {
		stubClaude([{ status: 529 }]);
		const { mb, reviews } = fakeMailbox();
		await expect(runTriageJob(mb, { ANTHROPIC_API_KEY: 'k' })).rejects.toThrow(/529/);
		expect(reviews).toHaveLength(0);
		vi.unstubAllGlobals();
	});

	it('keeps a message the API rejects (400) rather than stalling the queue on it', async () => {
		stubClaude([{ status: 400 }]);
		const { mb, reviews, moves } = fakeMailbox();
		await runTriageJob(mb, { ANTHROPIC_API_KEY: 'k' });
		expect(moves).toEqual([]);
		expect(reviews[0].action_taken).toBe('keep');
		vi.unstubAllGlobals();
	});
});

describe('runTriageJob — rules before the model', () => {
	it('files npm publish receipts by the built-in rule without calling Claude', async () => {
		const calls = stubClaude([]);
		const { mb, moves, reviews } = fakeMailbox();
		const get = mb.get;
		mb.get = ((entity: string, id: string) =>
			entity === 'message'
				? {
						...get(entity, id),
						from: { email: 'support@npmjs.com', name: 'npm' },
						subject: 'Successfully published @delightstack/auth@1.6.2',
					}
				: get(entity, id)) as TriageMailbox['get'];
		await runTriageJob(mb, { ANTHROPIC_API_KEY: 'k' });
		expect(calls).toHaveLength(0);
		expect(moves[0].folder).toBe('notifications');
		expect(reviews[0].model).toBe('builtin');
		vi.unstubAllGlobals();
	});
});
