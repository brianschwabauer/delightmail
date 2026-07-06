/**
 * Startup environment validation (§13). Surfaces actionable errors/warnings for
 * missing or malformed configuration once at boot, so a fresh deploy fails loud
 * and clear instead of misbehaving at runtime. Called once from hooks.server.ts.
 */
export interface EnvReport {
	errors: string[];
	warnings: string[];
	features: Record<string, boolean>;
}

type Env = Record<string, string | undefined>;

export function checkEnv(env: Env, opts: { dev?: boolean } = {}): EnvReport {
	const errors: string[] = [];
	const warnings: string[] = [];

	const isHex64 = (v?: string) => !!v && /^[0-9a-f]{64}$/i.test(v);

	// --- required in production ---
	if (!opts.dev) {
		if (!env.PUBLIC_APP_URL) errors.push('PUBLIC_APP_URL is required (e.g. https://mail.example.com).');
		if (!isHex64(env.JWT_KEY_SECRET)) {
			errors.push('JWT_KEY_SECRET must be a 64-char hex string. Generate: openssl rand -hex 32');
		}
		if (!isHex64(env.CREDENTIALS_ENCRYPTION_KEY)) {
			errors.push('CREDENTIALS_ENCRYPTION_KEY must be a 64-char hex string. Generate: openssl rand -hex 32');
		}
		if (!env.OWNER_EMAIL && env.SIGNUPS_ENABLED !== 'true') {
			errors.push('Set OWNER_EMAIL (allowlist) or SIGNUPS_ENABLED=true, else nobody can sign up.');
		}
		if (!env.MAIL_FROM && !env.SMTP_RELAY_HOST) {
			warnings.push('No MAIL_FROM + EMAIL binding and no SMTP_RELAY_* — magic-link sign-in emails cannot be sent.');
		}
	}

	// --- optional feature groups (present = enabled) ---
	const has = (...keys: string[]) => keys.every((k) => !!env[k]);
	const features = {
		gmail: has('GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'),
		gmail_push: has('GMAIL_PUBSUB_TOPIC', 'GMAIL_PUSH_AUDIENCE', 'GMAIL_PUSH_SA_EMAIL'),
		ai_triage: has('AI_GATEWAY_NAME'),
		web_push: has('VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY'),
		smtp_relay: has('SMTP_RELAY_HOST'),
		billing: has('STRIPE_SECRET_KEY'),
	};

	if (features.gmail && !features.gmail_push) {
		warnings.push('Gmail configured without Pub/Sub — falling back to polling (GMAIL_POLL_SECONDS).');
	}
	if (env.VAPID_PUBLIC_KEY && !env.VAPID_PRIVATE_KEY) {
		errors.push('VAPID_PUBLIC_KEY is set but VAPID_PRIVATE_KEY is missing.');
	}

	return { errors, warnings, features };
}

let reported = false;
/** Log the report once per isolate. Throws in production if there are errors. */
export function reportEnvOnce(env: Env, opts: { dev?: boolean } = {}): void {
	if (reported) return;
	reported = true;
	const { errors, warnings, features } = checkEnv(env, opts);
	for (const w of warnings) console.warn(`[env] ⚠ ${w}`);
	for (const e of errors) console.error(`[env] ✗ ${e}`);
	const on = Object.entries(features)
		.filter(([, v]) => v)
		.map(([k]) => k);
	console.log(`[env] features enabled: ${on.length ? on.join(', ') : 'none'}`);
	if (errors.length && !opts.dev) {
		throw new Error(`DelightMail is misconfigured (${errors.length} error(s)). See the logs above.`);
	}
}
