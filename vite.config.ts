import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	plugins: [sveltekit()],
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
