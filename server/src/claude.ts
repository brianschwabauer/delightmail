/**
 * One structured-output call to the Claude Messages API. A plain fetch rather
 * than the SDK: triage needs exactly one request shape, and the job engine
 * already owns retries and backoff.
 */

export const TRIAGE_MODEL = 'claude-haiku-5-5';
export const ESCALATION_MODEL = 'claude-sonnet-5-5';

/** USD per million tokens. Cache writes (5-minute TTL) bill at 1.25× input. */
const PRICES: Record<string, { input: number; output: number; cache_read: number }> = {
	'claude-haiku-5-5': { input: 0.1, output: 0.5, cache_read: 0.01 },
	'claude-sonnet-5-5': { input: 2, output: 10, cache_read: 0.1 },
};

export interface ClaudeUsage {
	input_tokens: number;
	output_tokens: number;
	cache_creation_input_tokens: number;
	cache_read_input_tokens: number;
}

export type ClaudeResult =
	| { ok: true; value: unknown; usage: ClaudeUsage; cost_usd: number }
	| {
			ok: false;
			/** Worth retrying later (rate limit, overload, outage, bad key). */
			retryable: boolean;
			error: string;
			usage?: ClaudeUsage;
			cost_usd?: number;
	  };

export function costOf(model: string, u: ClaudeUsage): number {
	const p = PRICES[model];
	if (!p) return 0;
	return (
		(u.input_tokens * p.input +
			u.cache_creation_input_tokens * p.input * 1.25 +
			u.cache_read_input_tokens * p.cache_read +
			u.output_tokens * p.output) /
		1_000_000
	);
}

export async function claudeJson(opts: {
	api_key: string;
	model: string;
	system: string;
	user: string;
	schema: Record<string, unknown>;
	signal?: AbortSignal;
}): Promise<ClaudeResult> {
	let res: Response;
	try {
		res = await fetch('https://api.anthropic.com/v1/messages', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-api-key': opts.api_key,
				'anthropic-version': '2023-06-01',
			},
			body: JSON.stringify({
				model: opts.model,
				// Room for adaptive thinking ahead of a ~100-token JSON answer.
				max_tokens: 2048,
				// The system prompt only changes when the policy does, so it caches
				// across a burst of arrivals.
				system: [{ type: 'text', text: opts.system, cache_control: { type: 'ephemeral' } }],
				messages: [{ role: 'user', content: opts.user }],
				output_config: {
					effort: 'low',
					format: { type: 'json_schema', schema: opts.schema },
				},
			}),
			signal: opts.signal ?? AbortSignal.timeout(60_000),
		});
	} catch (err) {
		return { ok: false, retryable: true, error: `network: ${(err as Error).message}` };
	}

	if (!res.ok) {
		const body = await res.text().catch(() => '');
		// 400s are about this request (a body the API rejects); everything else
		// — rate limits, overload, outages, a missing or revoked key — clears up
		// on its own or once the key is fixed, so the mail should wait for it.
		return {
			ok: false,
			retryable: res.status !== 400 && res.status !== 413,
			error: `HTTP ${res.status}: ${body.slice(0, 300)}`,
		};
	}

	const msg = (await res.json()) as {
		stop_reason?: string;
		content?: Array<{ type: string; text?: string }>;
		usage?: Partial<ClaudeUsage>;
	};
	const usage: ClaudeUsage = {
		input_tokens: msg.usage?.input_tokens ?? 0,
		output_tokens: msg.usage?.output_tokens ?? 0,
		cache_creation_input_tokens: msg.usage?.cache_creation_input_tokens ?? 0,
		cache_read_input_tokens: msg.usage?.cache_read_input_tokens ?? 0,
	};
	const cost_usd = costOf(opts.model, usage);

	if (msg.stop_reason === 'refusal' || msg.stop_reason === 'max_tokens') {
		return { ok: false, retryable: false, error: `stop_reason ${msg.stop_reason}`, usage, cost_usd };
	}
	const text = (msg.content ?? []).find((b) => b.type === 'text')?.text ?? '';
	try {
		return { ok: true, value: JSON.parse(text), usage, cost_usd };
	} catch {
		return { ok: false, retryable: false, error: 'unparseable JSON', usage, cost_usd };
	}
}
