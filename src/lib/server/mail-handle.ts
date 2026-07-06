/**
 * Custom mail endpoints (§9 mailHandle). Grows across phases:
 *  P1  GET  /api/messages/:id/body, /raw ; GET /api/attachments/:id
 *  P1  POST /api/accounts/google/start, GET /api/accounts/google/callback
 *  P2  POST /api/threads/actions
 *  P3  POST /api/send, /api/send/:id/undo
 *  P4  POST /api/accounts/domain
 *  P5  POST /api/unsubscribe/:id, /api/triage/test
 *  P6  POST /api/push/subscribe
 *
 * Kept as a single handle so routing stays in one place and every branch shares
 * the org/session guard.
 */
import type { Handle } from '@sveltejs/kit';
import type { AuthLocals } from '@delightstack/auth/server';
import { DelightError } from '@delightstack/utilities';

export function createMailHandle(): Handle {
	return async ({ event, resolve }) => {
		const { pathname } = event.url;
		if (!pathname.startsWith('/api/')) return resolve(event);

		// Non-mail API routes fall through to their own handlers/endpoints.
		if (!isMailRoute(pathname)) return resolve(event);

		const locals = event.locals as AuthLocals & App.Locals;
		if (!locals.session) return DelightError.unauthorized('Sign in required').toResponse();
		if (!locals.org_id || !locals.db) {
			return DelightError.badRequest('No mailbox for this session').toResponse();
		}

		// Endpoint handlers are added per-phase. Until a route is implemented it
		// returns 501 so the surface is discoverable and never silently 404s.
		return new DelightError({
			message: `Not implemented yet: ${event.request.method} ${pathname}`,
			status: 501,
		}).toResponse();
	};
}

const MAIL_PREFIXES = [
	'/api/accounts/',
	'/api/messages/',
	'/api/attachments/',
	'/api/threads/',
	'/api/send',
	'/api/unsubscribe/',
	'/api/push/',
	'/api/triage/',
];

function isMailRoute(pathname: string): boolean {
	return MAIL_PREFIXES.some((p) => pathname === p || pathname.startsWith(p));
}
