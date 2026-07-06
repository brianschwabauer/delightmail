import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	plugins: [sveltekit()],
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
