/**
 * Bulk thread action endpoint (§9). One round-trip for multi-select; fans out
 * provider write-back jobs inside MailboxServer.applyThreadAction.
 */
import type { RequestEvent } from '@sveltejs/kit';
import { DelightError } from '@delightstack/utilities';

const VALID_ACTIONS = new Set([
	'archive',
	'trash',
	'delete',
	'spam',
	'read',
	'unread',
	'star',
	'unstar',
	'move',
	'label',
]);

export async function handleThreadActions(event: RequestEvent): Promise<Response> {
	const db = event.locals.db;
	if (!db) return DelightError.badRequest('No mailbox').toResponse();

	const body = (await event.request.json().catch(() => null)) as {
		thread_ids?: string[];
		action?: string;
		folder?: string;
		label_id?: string;
	} | null;

	if (!body?.action || !VALID_ACTIONS.has(body.action)) {
		return DelightError.badRequest('Unknown action').toResponse();
	}
	if (!Array.isArray(body.thread_ids) || body.thread_ids.length === 0) {
		return DelightError.badRequest('No threads selected').toResponse();
	}

	const result = await db.applyThreadAction(
		{
			thread_ids: body.thread_ids,
			action: body.action as never,
			folder: body.folder,
			label_id: body.label_id,
		},
		event.locals.user?.id,
	);
	return Response.json(result);
}
