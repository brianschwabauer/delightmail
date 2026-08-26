#!/usr/bin/env node
/**
 * `pnpm dev` — local development in one command.
 *
 * Default (HMR) mode starts both halves of the app:
 *   1. the server worker (`wrangler dev`, :8710) — hosts the Durable Objects and,
 *      because DEV=true, the HTTP RPC bridge `vite dev` reaches them through;
 *   2. the SvelteKit app (`vite dev`, :5710) — with full HMR.
 * Vite starts only once the server worker answers /health, so the first request
 * can't race a cold DO host.
 *
 * `pnpm dev --full` runs the PRODUCTION build of both workers in ONE `wrangler
 * dev` session instead — the exact deploy topology (native cross-script DO RPC,
 * real WebSockets, no bridge). No HMR: `src/` changes trigger a `vite build`
 * (~3s) and wrangler reloads. Use it to debug DO/sync/send behaviour or a 500
 * you don't trust.
 *
 * Both modes read `.dev.vars` (app) and `server/.dev.vars` (server) and refuse
 * to start on the configs that have cost hours before: mismatched JWT secrets,
 * a missing DEV=true, a wrong PUBLIC_APP_URL, no CLOUDFLARE_ACCOUNT_ID (the
 * `ai` binding needs one to start non-interactively), a squatted port.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, watch } from 'node:fs';
import { createServer } from 'node:net';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const FULL = process.argv.includes('--full');
const APP_PORT = Number(process.env.PORT || 5710);
const WORKER_PORT = Number(process.env.WORKER_PORT || 8710);
const BIN = (name) => resolve(ROOT, 'node_modules/.bin', name);

function readVars(file) {
	const path = resolve(ROOT, file);
	if (!existsSync(path)) return null;
	const out = {};
	for (const raw of readFileSync(path, 'utf8').split('\n')) {
		const line = raw.trim();
		if (!line || line.startsWith('#')) continue;
		const eq = line.indexOf('=');
		if (eq < 0) continue;
		out[line.slice(0, eq).trim()] = line
			.slice(eq + 1)
			.trim()
			.replace(/^(['"])(.*)\1$/, '$2');
	}
	return out;
}
function portFree(port) {
	return new Promise((done) => {
		const s = createServer();
		s.once('error', () => done(false));
		s.once('listening', () => s.close(() => done(true)));
		s.listen(port, '127.0.0.1');
	});
}

// --- preflight -------------------------------------------------------------
const app = readVars('.dev.vars');
const server = readVars('server/.dev.vars');
const dotenv = readVars('.env') ?? {};
const problems = [];
if (!app) problems.push('.dev.vars is missing — `cp .dev.vars.example .dev.vars`.');
if (!server)
	problems.push('server/.dev.vars is missing — `cp server/.dev.vars.example server/.dev.vars`.');
if (app && server) {
	if (app.DEV !== 'true')
		problems.push('.dev.vars must set DEV=true (dev sign-in/seed routes, DEV_SECRET fallback).');
	if (server.DEV !== 'true')
		problems.push(
			'server/.dev.vars must set DEV=true (RPC bridge, no outbound mail, DEV_SECRET fallback).',
		);
	// Under vite the app reads JWT_KEY_SECRET from .env (process env), under
	// wrangler from .dev.vars; the server always reads server/.dev.vars.
	const app_jwt =
		(FULL ? app.JWT_KEY_SECRET : dotenv.JWT_KEY_SECRET || process.env.JWT_KEY_SECRET) || '';
	if (app_jwt !== (server.JWT_KEY_SECRET || '')) {
		problems.push(
			'JWT_KEY_SECRET differs between the app and the server — sessions would mint but never verify. ' +
				'Easiest: leave it unset everywhere in dev (both fall back to the same built-in dev secret).',
		);
	}
	const want = `http://localhost:${APP_PORT}`;
	if (app.PUBLIC_APP_URL !== want)
		problems.push(
			`.dev.vars PUBLIC_APP_URL must be ${want} (magic links, passkeys and the DEV guard key off it).`,
		);
	if (!app.CREDENTIALS_ENCRYPTION_KEY)
		problems.push('.dev.vars needs CREDENTIALS_ENCRYPTION_KEY (any 64-hex: openssl rand -hex 32).');
}
const account_id =
	process.env.CLOUDFLARE_ACCOUNT_ID || app?.CLOUDFLARE_ACCOUNT_ID || server?.CLOUDFLARE_ACCOUNT_ID;
if (!account_id)
	problems.push(
		'CLOUDFLARE_ACCOUNT_ID is not set (env or .dev.vars) — the `ai` binding needs it to start non-interactively.',
	);
if (!(await portFree(APP_PORT)))
	problems.push(
		`port ${APP_PORT} is in use — another project's dev server? (\`ss -ltnp | grep ${APP_PORT}\`)`,
	);
if (!FULL && !(await portFree(WORKER_PORT)))
	problems.push(
		`port ${WORKER_PORT} is in use — the app would talk to whatever is squatting it. (\`ss -ltnp | grep ${WORKER_PORT}\`)`,
	);
if (problems.length) {
	console.error('\n✗ Cannot start dev:\n');
	for (const p of problems) console.error(`  • ${p}`);
	console.error('');
	process.exit(1);
}

// --- process plumbing -------------------------------------------------------
const env = {
	...process.env,
	CLOUDFLARE_ACCOUNT_ID: account_id,
	DEV_WORKER_URL: `http://localhost:${WORKER_PORT}`,
};
const children = new Set();
function run(cmd, args, opts = {}) {
	const child = spawn(cmd, args, { cwd: ROOT, stdio: 'inherit', env, ...opts });
	children.add(child);
	child.on('exit', () => children.delete(child));
	return child;
}
let exiting = false;
function shutdown(code = 0) {
	if (exiting) return;
	exiting = true;
	for (const c of children) c.kill('SIGTERM');
	setTimeout(() => process.exit(code), 300);
}
process.on('SIGINT', () => shutdown(130));
process.on('SIGTERM', () => shutdown(143));

if (FULL) await fullMode();
else await hmrMode();

// --- HMR mode: server worker + vite ------------------------------------------
async function hmrMode() {
	console.log(
		`\n▶ server worker on :${WORKER_PORT}, then the app with HMR on http://localhost:${APP_PORT}\n`,
	);
	run(BIN('wrangler'), [
		'dev',
		'--config',
		'server/wrangler.jsonc',
		'--port',
		String(WORKER_PORT),
		'--ip',
		'127.0.0.1',
		'--persist-to',
		'.wrangler/state',
		'--show-interactive-dev-session',
		'false',
	]).on('exit', (code) => shutdown(code ?? 0));

	const health = `http://localhost:${WORKER_PORT}/health`;
	for (let i = 0; i < 120; i++) {
		if (exiting) return;
		const ok = await fetch(health)
			.then((r) => r.ok)
			.catch(() => false);
		if (ok) break;
		await new Promise((r) => setTimeout(r, 500));
		if (i === 119) {
			console.error(`\n✗ the server worker never answered ${health}\n`);
			return shutdown(1);
		}
	}
	run(BIN('vite'), ['dev', '--port', String(APP_PORT), '--strictPort']).on('exit', (code) =>
		shutdown(code ?? 0),
	);
}

// --- full mode: one wrangler session, production build, rebuild on change -----
async function fullMode() {
	let building = null;
	let dirty = false;
	function build() {
		if (building) {
			dirty = true;
			return building;
		}
		const started = Date.now();
		building = new Promise((done) => {
			run(BIN('vite'), ['build', '--logLevel', 'warn']).on('exit', (code) => {
				building = null;
				if (code === 0)
					console.log(
						`\n✔ app rebuilt in ${((Date.now() - started) / 1000).toFixed(1)}s — wrangler is reloading it\n`,
					);
				else
					console.error(
						`\n✗ vite build failed (exit ${code}) — the previous build keeps serving\n`,
					);
				if (dirty) {
					dirty = false;
					void build();
				}
				done(code === 0);
			});
		});
		return building;
	}

	console.log(
		`\n▶ --full: building the app worker, then serving both workers on http://localhost:${APP_PORT}\n`,
	);
	if (!(await build())) return shutdown(1);

	run(BIN('wrangler'), [
		'dev',
		'--config',
		'wrangler.jsonc',
		'--config',
		'server/wrangler.jsonc',
		'--port',
		String(APP_PORT),
		'--ip',
		'127.0.0.1',
		'--persist-to',
		'.wrangler/state',
		// wrangler dev rewrites every request URL to the config's route host
		// (mail.example.com) unless told the local origin — which would break magic
		// links, passkeys, the localhost-only dev routes and the DEV guard.
		'--local-upstream',
		`localhost:${APP_PORT}`,
		'--show-interactive-dev-session',
		'false',
	]).on('exit', (code) => shutdown(code ?? 0));

	// Rebuild the app on source changes. Server worker sources are wrangler's own
	// concern (it bundles server/src and reloads by itself).
	let timer;
	const trigger = (file) => {
		if (!file || /(^|\/)(\.|node_modules)/.test(file)) return;
		clearTimeout(timer);
		timer = setTimeout(() => void build(), 300);
	};
	for (const dir of ['src', 'static']) {
		if (existsSync(resolve(ROOT, dir)))
			watch(resolve(ROOT, dir), { recursive: true }, (_e, f) => trigger(f));
	}
	for (const file of ['svelte.config.js', 'vite.config.ts']) {
		if (existsSync(resolve(ROOT, file))) watch(resolve(ROOT, file), () => trigger(file));
	}
}
