import adapter from '@sveltejs/adapter-cloudflare';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess({ script: true }),
	compilerOptions: {
		// The delightstack DatabaseClient relies on `$derived(await …)`.
		experimental: { async: true },
	},
	kit: {
		// A tab left open for days kept running the old code against a newer
		// server. Poll for a new deploy so the app can offer (or, when nothing is
		// in progress, make) the switch — see routes/mail/+layout.svelte.
		version: { pollInterval: 5 * 60 * 1000 },
		adapter: adapter({
			platformProxy: {
				configPath: './wrangler.jsonc',
				persist: { path: '.wrangler/state/v3' },
			},
		}),
	},
};

export default config;
