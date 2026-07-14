import { describe, it, expect } from 'vitest';
import { consumeToken, limitMagicLink, type RateLimiterNamespace } from './rate-limit';

/** In-memory fake of the RateLimiterServer DO: one token bucket per DO name. */
function fakeNamespace(): RateLimiterNamespace {
	const buckets = new Map<string, { tokens: number; max: number }>();
	return {
		idFromName: (name: string) => name,
		get: (id: unknown) => {
			const key = String(id);
			return {
				async setOptions(o: { max_tokens: number; refill_every_seconds: number }) {
					if (!buckets.has(key)) buckets.set(key, { tokens: o.max_tokens, max: o.max_tokens });
				},
				async consume() {
					const b = buckets.get(key)!;
					if (b.tokens > 0) {
						b.tokens -= 1;
						return true;
					}
					return false;
				},
				async getStatus() {
					return { reset_in_ms: 30_000 };
				},
			};
		},
	};
}

/** A namespace whose stub always throws — exercises the fail-open path. */
function throwingNamespace(): RateLimiterNamespace {
	return {
		idFromName: (n: string) => n,
		get: () => {
			throw new Error('limiter DO unreachable');
		},
	};
}

describe('rate-limit — magic-link abuse protection', () => {
	it('allows a burst then blocks once the bucket is drained', async () => {
		const rl = fakeNamespace();
		const opts = { max_tokens: 3, refill_every_seconds: 60 };
		expect((await consumeToken(rl, 'k', opts)).allowed).toBe(true);
		expect((await consumeToken(rl, 'k', opts)).allowed).toBe(true);
		expect((await consumeToken(rl, 'k', opts)).allowed).toBe(true);
		const blocked = await consumeToken(rl, 'k', opts);
		expect(blocked.allowed).toBe(false);
		expect(blocked.reset_in_ms).toBeGreaterThan(0);
	});

	it('keeps separate buckets per key', async () => {
		const rl = fakeNamespace();
		const opts = { max_tokens: 1, refill_every_seconds: 60 };
		expect((await consumeToken(rl, 'a', opts)).allowed).toBe(true);
		expect((await consumeToken(rl, 'a', opts)).allowed).toBe(false);
		// A different key is unaffected.
		expect((await consumeToken(rl, 'b', opts)).allowed).toBe(true);
	});

	it('blocks a magic-link flood to one address (email bucket drains at 5)', async () => {
		const rl = fakeNamespace();
		const email = 'owner@example.com';
		let lastAllowed = true;
		for (let i = 0; i < 5; i++) {
			lastAllowed = (await limitMagicLink(rl, email, '1.2.3.4')).allowed;
			expect(lastAllowed).toBe(true);
		}
		// The 6th request to the same address is throttled.
		expect((await limitMagicLink(rl, email, '5.6.7.8')).allowed).toBe(false);
	});

	it('fails OPEN when the limiter is unavailable (never lock the owner out)', async () => {
		const rl = throwingNamespace();
		expect((await consumeToken(rl, 'k', { max_tokens: 1, refill_every_seconds: 60 })).allowed).toBe(
			true,
		);
		expect((await limitMagicLink(rl, 'owner@example.com', '1.2.3.4')).allowed).toBe(true);
	});

	it('is a no-op when no limiter binding is present', async () => {
		expect((await limitMagicLink(undefined, 'owner@example.com', '1.2.3.4')).allowed).toBe(true);
	});
});
