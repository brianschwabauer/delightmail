/**
 * "Are we in local development?" — true under `vite dev`, AND in a production
 * build served by a local `wrangler dev` that sets `DEV=true` in `.dev.vars`
 * (the one-process dev story in scripts/dev.mjs). `$app/environment`'s `dev`
 * alone is a build-time constant, so a locally-run production build would
 * otherwise demand real secrets, hide the seed endpoint, and try to send mail.
 *
 * `DEV` MUST stay unset in production: env-check refuses to serve when it is set
 * on anything but a localhost PUBLIC_APP_URL.
 */
import { dev } from '$app/environment';
import { env } from '$env/dynamic/private';

export function isDevEnv(): boolean {
	return dev || env.DEV === 'true';
}
