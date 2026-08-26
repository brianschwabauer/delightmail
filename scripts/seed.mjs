#!/usr/bin/env node
/**
 * `pnpm dev:seed [email]` — sign in headlessly against the local dev server and
 * fill that mailbox with the sample threads from src/lib/server/dev-seed.ts.
 *
 * Uses the dev-only `POST /api/dev/signin` (a session for OWNER_EMAIL, no email
 * round trip) and `POST /api/dev/seed`. Both exist only when the worker runs
 * with DEV=true on localhost, i.e. under `pnpm dev`. Pass `DEV_URL` to target a
 * different port.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const base = (process.env.DEV_URL || 'http://localhost:5710').replace(/\/$/, '');

function ownerEmail() {
	const path = resolve(ROOT, '.dev.vars');
	if (!existsSync(path)) return '';
	const m = readFileSync(path, 'utf8').match(/^OWNER_EMAIL=(.+)$/m);
	return (m?.[1] ?? '').split(/[,\s]+/)[0].replace(/^['"]|['"]$/g, '');
}
const email = process.argv[2] || ownerEmail();
if (!email) {
	console.error(
		'No email: pass one (`pnpm dev:seed you@example.com`) or set OWNER_EMAIL in .dev.vars',
	);
	process.exit(1);
}

async function post(path, cookie, body) {
	const res = await fetch(base + path, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			...(cookie ? { cookie } : {}),
		},
		body: JSON.stringify(body ?? {}),
		redirect: 'manual',
	}).catch((err) => {
		console.error(
			`✗ ${base} is not reachable (${err.cause?.code ?? err.message}). Is \`pnpm dev\` running?`,
		);
		process.exit(1);
	});
	return res;
}

// 1. Session.
const signin = await post('/api/dev/signin', '', { email });
if (signin.status === 404) {
	console.error(
		'✗ /api/dev/signin is not available — the server must run with DEV=true on localhost (`pnpm dev`).',
	);
	process.exit(1);
}
if (!signin.ok) {
	console.error(`✗ dev sign-in failed (${signin.status}): ${await signin.text()}`);
	process.exit(1);
}
const cookie = signin.headers
	.getSetCookie()
	.map((c) => c.split(';')[0])
	.join('; ');
console.log(`✔ signed in as ${email}`);

// 2. Seed. (The first authenticated API call also provisions the mailbox org.)
const seed = await post('/api/dev/seed', cookie);
if (!seed.ok) {
	console.error(`✗ seed failed (${seed.status}): ${await seed.text()}`);
	process.exit(1);
}
console.log(`✔ seeded: ${await seed.text()}`);
console.log(`\nOpen ${base}/signin and click "Sign in instantly as the owner".`);
