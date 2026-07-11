/**
 * Thin wrapper over the RateLimiterServer Durable Object (@delightstack/rate-limiter)
 * for app-worker request throttling. Used to protect the unauthenticated
 * magic-link / signup endpoints from email-bombing abuse (§8, §12).
 *
 * The DO is a token bucket: setOptions(max_tokens, refill_every_seconds) then
 * consume(key, cost) → true when a token was available. Every check FAILS OPEN —
 * a limiter outage must never lock the owner out of their own sign-in.
 */
export interface RateLimiterStub {
	setOptions(o: { max_tokens: number; refill_every_seconds: number }): Promise<void>;
	consume(key: string, cost: number): Promise<boolean>;
	getStatus(key: string): Promise<{ reset_in_ms: number }>;
}

export interface RateLimiterNamespace {
	idFromName(name: string): unknown;
	get(id: unknown): RateLimiterStub;
}

export interface RateLimitDecision {
	allowed: boolean;
	/** Milliseconds until the bucket refills a token (for Retry-After). */
	reset_in_ms: number;
}

interface BucketOptions {
	max_tokens: number;
	refill_every_seconds: number;
}

/** Consume one token from the named bucket. Fails open on any limiter error. */
export async function consumeToken(
	rl: RateLimiterNamespace,
	bucketKey: string,
	opts: BucketOptions,
): Promise<RateLimitDecision> {
	try {
		const stub = rl.get(rl.idFromName(bucketKey));
		await stub.setOptions(opts);
		if (await stub.consume('c', 1)) return { allowed: true, reset_in_ms: 0 };
		const status = await stub.getStatus('c').catch(() => ({ reset_in_ms: 0 }));
		return { allowed: false, reset_in_ms: status?.reset_in_ms ?? 0 };
	} catch {
		// Never block on a limiter outage — sign-in must not depend on it.
		return { allowed: true, reset_in_ms: 0 };
	}
}

/**
 * Throttle a magic-link / signup request by BOTH the target email (the abuse
 * vector — bombing one address) and the client IP (defense in depth). Blocked if
 * either bucket is exhausted. Fails open.
 */
export async function limitMagicLink(
	rl: RateLimiterNamespace | undefined,
	email: string,
	ip: string,
): Promise<RateLimitDecision> {
	if (!rl) return { allowed: true, reset_in_ms: 0 };
	const checks: Array<Promise<RateLimitDecision>> = [];
	// Per address: 5 quick requests, then ~1/min. Enough for a legit user who
	// mistypes or requests a fresh link; stops a flood to a known address.
	if (email) {
		checks.push(
			consumeToken(rl, `auth-email:${email.toLowerCase()}`, {
				max_tokens: 5,
				refill_every_seconds: 60,
			}),
		);
	}
	// Per source IP: 12 burst, then ~1/30s.
	if (ip) {
		checks.push(consumeToken(rl, `auth-ip:${ip}`, { max_tokens: 12, refill_every_seconds: 30 }));
	}
	if (!checks.length) return { allowed: true, reset_in_ms: 0 };
	const results = await Promise.all(checks);
	const blocked = results.find((r) => !r.allowed);
	return blocked ?? { allowed: true, reset_in_ms: 0 };
}
