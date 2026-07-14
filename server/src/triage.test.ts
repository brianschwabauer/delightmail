import { describe, it, expect, vi } from 'vitest';

// A gateway whose completion always fails (simulates an AI Gateway outage).
vi.mock('@delightstack/ai/server', () => ({
	createAiGateway: () => ({
		complete: () => Promise.reject(new Error('AI Gateway 503')),
	}),
}));

import { runTriageJob, type TriageMailbox } from './triage';

/** Fake MailboxServer surface: one untriaged inbox message, triage enabled. */
function fakeMailbox(): { mb: TriageMailbox; reviews: unknown[]; scheduled: string[] } {
	const reviews: unknown[] = [];
	const scheduled: string[] = [];
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
	};
	return { mb, reviews, scheduled };
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
