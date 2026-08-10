#!/usr/bin/env node
/**
 * Generate the private prod wrangler configs from the committed templates.
 *
 *   KV_NAMESPACE_ID=… APP_DOMAIN=… node scripts/make-prod-config.mjs
 *
 * The committed `wrangler.jsonc` / `server/wrangler.jsonc` ship with placeholder
 * values so the public repo carries no deployment-specific ids; the real
 * configs (`*.prod.*`) are git-ignored. CI (Cloudflare Builds) can't see them,
 * so it regenerates them from these two variables before `wrangler deploy`.
 * Locally this is optional — the checked-out prod configs already exist.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const KV_ID = process.env.KV_NAMESPACE_ID;
const DOMAIN = process.env.APP_DOMAIN;

if (!KV_ID || !DOMAIN) {
	console.error('Set KV_NAMESPACE_ID and APP_DOMAIN (e.g. mail.example.org).');
	process.exit(1);
}

const substitutions = [
	['REPLACE_WITH_KV_NAMESPACE_ID', KV_ID],
	['mail.example.com', DOMAIN],
	['https://mail.example.com', `https://${DOMAIN}`],
];

for (const [template, output] of [
	['wrangler.jsonc', 'wrangler.prod.jsonc'],
	['server/wrangler.jsonc', 'server/wrangler.prod.jsonc'],
]) {
	let content = readFileSync(template, 'utf8');
	for (const [from, to] of substitutions) content = content.replaceAll(from, to);
	if (content.includes('REPLACE_WITH')) {
		console.error(`${template}: unreplaced placeholder remains — update this script.`);
		process.exit(1);
	}
	writeFileSync(output, content);
	console.log(`${output} written (kv ${KV_ID.slice(0, 8)}…, ${DOMAIN})`);
}
