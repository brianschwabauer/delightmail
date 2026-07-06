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
		adapter: adapter({
			platformProxy: {
				configPath: './wrangler.jsonc',
				persist: { path: '.wrangler/state/v3' },
			},
		}),
	},
};

export default config;
