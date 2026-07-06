#!/usr/bin/env node
/**
 * Push secrets to both Cloudflare Workers from a local .env-style file (§13).
 *
 *   node scripts/put-secrets.mjs [path/to/secrets.env]
 *
 * Reads KEY="value" lines and runs `wrangler secret put KEY` for the app worker
 * and the server worker (delightmail-server). Secrets the app never reads are
 * skipped for it. Never commit the source file.
 */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const file = process.argv[2] ?? 'secrets.env';

// Secrets the app worker (SvelteKit) reads directly. Everything else only the
// server worker (DOs) needs, but pushing to both is harmless — wrangler ignores
// unbound secrets at runtime.
const REQUIRED = ['JWT_KEY_SECRET', 'CREDENTIALS_ENCRYPTION_KEY'];

let content;
try {
	content = readFileSync(file, 'utf8');
} catch {
	console.error(`Could not read ${file}. Create it with KEY="value" lines (see .dev.vars.example).`);
	process.exit(1);
}

const entries = content
	.split('\n')
	.map((l) => l.trim())
	.filter((l) => l && !l.startsWith('#'))
	.map((l) => {
		const eq = l.indexOf('=');
		const key = l.slice(0, eq).trim();
		let value = l.slice(eq + 1).trim();
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}
		return [key, value];
	})
	.filter(([k, v]) => k && v);

if (!entries.length) {
	console.error('No secrets found.');
	process.exit(1);
}

for (const req of REQUIRED) {
	if (!entries.find(([k]) => k === req)) {
		console.warn(`⚠ ${req} is not in ${file} — sign-in will not work without it.`);
	}
}

const targets = [
	{ label: 'app', args: [] },
	{ label: 'server', args: ['--config', 'server/wrangler.toml'] },
];

for (const [key, value] of entries) {
	for (const target of targets) {
		process.stdout.write(`→ ${key} (${target.label}) … `);
		const res = spawnSync('npx', ['wrangler', 'secret', 'put', key, ...target.args], {
			input: value,
			encoding: 'utf8',
		});
		console.log(res.status === 0 ? 'ok' : `failed\n${res.stderr}`);
	}
}
console.log('Done. Vars (non-secret) go in wrangler config `vars`, not here.');
