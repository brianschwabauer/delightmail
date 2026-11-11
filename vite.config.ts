import adapter from '@sveltejs/adapter-cloudflare';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	plugins: [
		sveltekit({
			preprocess: vitePreprocess({ script: true }),
			compilerOptions: {
				// The delightstack DatabaseClient relies on `$derived(await …)`.
				experimental: { async: true },
			},
			// A tab left open for days kept running the old code against a newer
			// server. Poll for a new deploy so the app can offer (or, when nothing is
			// in progress, make) the switch — see routes/mail/+layout.svelte.
			version: { pollInterval: 5 * 60 * 1000 },
			// No adapter under vitest: adapter-cloudflare starts wrangler's platform
			// proxy for every Vite server, which needs Cloudflare credentials for the
			// remote AI binding. The unit tests never touch platform bindings.
			adapter: process.env.VITEST
				? undefined
				: adapter({
						platformProxy: {
							configPath: './wrangler.jsonc',
							persist: { path: '.wrangler/state/v3' },
						},
					}),
		}),
	],
	// These packages ship web Workers (database.worker / websocket.worker) that
	// resolve via `new Worker(new URL('./x.worker.js', import.meta.url))`. Vite's
	// dep optimizer mangles the worker file path, which throws during client boot
	// and aborts hydration — so keep them out of the optimizer.
	optimizeDeps: {
		exclude: ['@delightstack/database', '@delightstack/websocket'],
	},
	build: {
		rollupOptions: {
			// Runtime-only workerd modules (resolved on Cloudflare, not bundled).
			external: [/^cloudflare:/],
		},
	},
	ssr: {
		external: ['worker-mailer'],
	},
	test: {
		// Pure domain + server orchestration logic; runs in node.
		include: ['src/**/*.{test,spec}.{js,ts}', 'server/src/**/*.{test,spec}.{js,ts}'],
		environment: 'node',
	},
});
