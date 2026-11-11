import { defineEnvVars } from '@sveltejs/kit/env';

// Every variable is optional and read when the worker starts (not inlined at
// build time), so one build serves dev, self-hosted and production configs.
// Missing values stay `undefined`; the code that reads them picks the fallback.
const optional = (input: string | undefined) => input;

export const variables = defineEnvVars({
	JWT_KEY_SECRET: {
		schema: optional,
		description: '64-char hex secret for session JWTs. Required in production.',
	},
	SIGNUPS_ENABLED: { schema: optional, description: "'true' lets anyone create an account." },
	OWNER_EMAIL: { schema: optional, description: 'Comma-separated addresses allowed to sign up.' },
	DEV_WORKER_URL: { schema: optional, description: 'Dev only: the local server worker URL.' },
	DEV: { schema: optional, description: "'true' marks a locally run production build as dev." },
	PUBLIC_APP_URL: {
		public: true,
		schema: optional,
		description: 'Canonical app origin, used for links in email and passkey origins.',
	},
});
