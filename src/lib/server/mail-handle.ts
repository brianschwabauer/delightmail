/**
 * Custom mail endpoints (mailHandle). Routing lives here so every branch
 * shares the org/session guard. Handlers are added per-phase.
 */
import type { Handle, RequestEvent } from '@sveltejs/kit';
import { DelightError } from '@delightstack/utilities';
import {
	handleGoogleStart,
	handleGoogleCallback,
	handleDomainRegister,
	handleImapAdd,
	handleImapTest,
	handleAccountLifecycle,
	handleAccountDelete,
} from './accounts';
import {
	handleMessageBody,
	handleMessageRaw,
	handleAttachment,
	handleAttachmentByCid,
	handleAttachmentUpload,
} from './body-endpoint';
import { handleOrgConsolidate } from './orgs';
import { handleThreadActions } from './thread-actions';
import { handleSend, handleUndoSend, handleSaveDraft, handleDeleteDraft } from './send';
import { handleTriageTest, handleUnsubscribe, handleUnsubscribeBulk } from './triage-endpoints';
import { handleVapidKey, handlePushSubscribe, handlePushUnsubscribe } from './push';
import { handleDevSeed } from './dev-seed';
import { isDevEnv } from './is-dev';

export function createMailHandle(): Handle {
	return async ({ event, resolve }) => {
		const { pathname } = event.url;
		if (!pathname.startsWith('/api/') || !isMailRoute(pathname)) return resolve(event);

		if (!event.locals.session) return DelightError.unauthorized('Sign in required').toResponse();
		if (!event.locals.org_id || !event.locals.db) {
			return DelightError.badRequest('No mailbox for this session').toResponse();
		}

		try {
			return await route(event);
		} catch (err) {
			// Surface the real stack in `wrangler tail` — a bare TypeError here
			// otherwise reaches the client as an opaque 500 with no server trace.
			console.error(
				`[mail] ${event.request.method} ${pathname} failed:`,
				err instanceof Error ? (err.stack ?? err.message) : err,
			);
			return DelightError.from(err).toResponse();
		}
	};
}

async function route(event: RequestEvent): Promise<Response> {
	const { pathname } = event.url;
	const method = event.request.method;
	const parts = pathname.split('/').filter(Boolean); // ['api','accounts','google','start']

	// --- accounts ---
	if (pathname === '/api/accounts/google/start' && method === 'POST') {
		return handleGoogleStart(event);
	}
	if (pathname === '/api/accounts/google/callback' && method === 'GET') {
		return handleGoogleCallback(event);
	}
	if (pathname === '/api/accounts/domain' && method === 'POST') {
		return handleDomainRegister(event);
	}
	if (pathname === '/api/accounts/orgs/consolidate' && method === 'POST') {
		return handleOrgConsolidate(event);
	}
	if (pathname === '/api/accounts/imap/test' && method === 'POST') {
		return handleImapTest(event);
	}
	if (pathname === '/api/accounts/imap' && method === 'POST') {
		return handleImapAdd(event);
	}
	// Lifecycle: /api/accounts/:id/(pause|resume|resync) and DELETE /api/accounts/:id.
	// Reserved sub-paths (google/imap/domain) are matched above, so parts[2] here is
	// an account id.
	if (parts[1] === 'accounts' && parts[2] && parts[3] && method === 'POST') {
		const action = parts[3];
		if (action === 'pause' || action === 'resume' || action === 'resync') {
			return handleAccountLifecycle(event, decodeURIComponent(parts[2]), action);
		}
	}
	if (parts[1] === 'accounts' && parts[2] && !parts[3] && method === 'DELETE') {
		return handleAccountDelete(event, decodeURIComponent(parts[2]));
	}

	// --- messages ---
	if (parts[1] === 'messages' && parts[2]) {
		const id = decodeURIComponent(parts[2]);
		if (parts[3] === 'body' && method === 'GET') return handleMessageBody(event, id);
		if (parts[3] === 'raw' && method === 'GET') return handleMessageRaw(event, id);
	}

	// --- attachments ---
	if (pathname === '/api/attachments/upload' && method === 'POST') {
		return handleAttachmentUpload(event);
	}
	// cid: inline images — deterministic {hash}/{index} path baked into sanitized
	// bodies at ingest (attachment row ids don't exist yet at sanitize time).
	if (
		parts[1] === 'attachments' &&
		parts[2] === 'cid' &&
		parts[3] &&
		parts[4] &&
		method === 'GET'
	) {
		return handleAttachmentByCid(event, parts[3], parts[4]);
	}
	if (parts[1] === 'attachments' && parts[2] && method === 'GET') {
		return handleAttachment(event, decodeURIComponent(parts[2]));
	}

	// --- thread actions (P2) ---
	if (pathname === '/api/threads/actions' && method === 'POST') {
		return handleThreadActions(event);
	}

	// --- send (P3) ---
	if (pathname === '/api/send' && method === 'POST') {
		return handleSend(event);
	}
	if (parts[1] === 'send' && parts[3] === 'undo' && method === 'POST') {
		return handleUndoSend(event, decodeURIComponent(parts[2]));
	}

	// --- drafts (autosave) ---
	if (pathname === '/api/drafts' && method === 'POST') {
		return handleSaveDraft(event);
	}
	if (parts[1] === 'drafts' && parts[2] && method === 'DELETE') {
		return handleDeleteDraft(event, decodeURIComponent(parts[2]));
	}

	// --- AI triage + unsubscribe (P5) ---
	if (pathname === '/api/triage/test' && method === 'POST') {
		return handleTriageTest(event);
	}
	if (parts[1] === 'unsubscribe' && parts[2] === 'bulk' && method === 'POST') {
		return handleUnsubscribeBulk(event);
	}
	if (parts[1] === 'unsubscribe' && parts[2] && method === 'POST') {
		return handleUnsubscribe(event, decodeURIComponent(parts[2]));
	}

	// --- web push (P6) ---
	if (pathname === '/api/push/vapid' && method === 'GET') return handleVapidKey(event);
	if (pathname === '/api/push/subscribe' && method === 'POST') return handlePushSubscribe(event);
	if (pathname === '/api/push/subscribe' && method === 'DELETE')
		return handlePushUnsubscribe(event);

	// --- dev-only seed (never reachable in production) ---
	if (isDevEnv() && pathname === '/api/dev/seed' && method === 'POST') {
		return handleDevSeed(event);
	}

	return new DelightError({
		message: `Not implemented yet: ${method} ${pathname}`,
		status: 501,
	}).toResponse();
}

const MAIL_PREFIXES = [
	'/api/accounts/',
	'/api/messages/',
	'/api/attachments/',
	'/api/threads/',
	'/api/send',
	'/api/drafts',
	'/api/unsubscribe/',
	'/api/push/',
	'/api/triage/',
	'/api/dev/',
];

function isMailRoute(pathname: string): boolean {
	return MAIL_PREFIXES.some((p) => pathname === p || pathname.startsWith(p));
}
