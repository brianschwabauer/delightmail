/**
 * Compose send endpoints. Renders the editor doc to HTML + text, then hands
 * a queued message to MailboxServer, which stores it (folder=sent,
 * send_status=queued) and starts the undo-send window.
 */
import type { RequestEvent } from '@sveltejs/kit';
import { DelightError } from '@delightstack/utilities';
import { renderHTML, renderText } from '@delightstack/editor/render';
import type { Address } from '$lib/schema';

interface SendAttachment {
	r2_key: string;
	filename: string;
	mime_type: string;
	size?: number;
}
interface SendBody {
	identity_id: string;
	to: Address[];
	cc?: Address[];
	bcc?: Address[];
	subject: string;
	doc: unknown;
	in_reply_to?: string;
	references?: string[];
	thread_id?: string;
	attachments?: SendAttachment[];
}

/** POST /api/send */
export async function handleSend(event: RequestEvent): Promise<Response> {
	const db = event.locals.db;
	const org_id = event.locals.org_id;
	if (!db || !org_id) return DelightError.badRequest('No mailbox').toResponse();

	const body = (await event.request.json().catch(() => null)) as SendBody | null;
	if (!body?.identity_id) return DelightError.badRequest('Missing identity').toResponse();
	if (!Array.isArray(body.to) || body.to.length === 0) {
		return DelightError.badRequest('No recipients').toResponse();
	}

	// Attachments are referenced by an R2 key the client supplies. Every key is
	// `{org_id}/…`; the SyncEngine reads whatever key lands here and attaches its
	// bytes to the outbound mail, so a key outside this org would exfiltrate another
	// tenant's stored mail. Reject any attachment not owned by the caller — the same
	// guard body-endpoint.ts enforces on reads (the client CRUD hooks strip r2_key
	// for exactly this reason; /api/send is the one path that writes it).
	const attachments = (body.attachments ?? []).filter((a) => a.r2_key && a.filename);
	const foreign = attachments.find((a) => !a.r2_key.startsWith(`${org_id}/`));
	if (foreign) return DelightError.badRequest('Invalid attachment').toResponse();

	let html = '';
	let text = '';
	try {
		const doc = (body.doc ?? { type: 'doc', content: [] }) as never;
		html = renderHTML(doc);
		text = renderText(doc);
	} catch (err) {
		return DelightError.badRequest(
			`Could not render message: ${(err as Error).message}`,
		).toResponse();
	}

	const result = await db.enqueueSend(
		{
			to: body.to,
			cc: body.cc ?? [],
			bcc: body.bcc ?? [],
			subject: body.subject ?? '',
			html,
			text,
			in_reply_to: body.in_reply_to,
			references: body.references ?? [],
			thread_id: body.thread_id,
			draft_doc: JSON.stringify(body.doc ?? {}),
			attachments: attachments.slice(0, 30),
		} as never,
		body.identity_id,
	);
	return Response.json(result);
}

/** POST /api/send/:id/undo */
export async function handleUndoSend(event: RequestEvent, messageId: string): Promise<Response> {
	const db = event.locals.db;
	if (!db) return DelightError.badRequest('No mailbox').toResponse();
	const result = await db.undoSend(messageId);
	return Response.json(result);
}

/** POST /api/drafts — autosave a compose draft. */
export async function handleSaveDraft(event: RequestEvent): Promise<Response> {
	const db = event.locals.db;
	if (!db) return DelightError.badRequest('No mailbox').toResponse();
	const body = (await event.request.json().catch(() => null)) as {
		draft_id?: string;
		identity_id?: string;
		to?: Address[];
		cc?: Address[];
		subject?: string;
		doc?: unknown;
	} | null;
	if (!body?.identity_id) return DelightError.badRequest('Missing identity').toResponse();
	const result = await db.saveDraft({
		draft_id: body.draft_id,
		identity_id: body.identity_id,
		to: body.to ?? [],
		cc: body.cc ?? [],
		subject: body.subject ?? '',
		doc: JSON.stringify(body.doc ?? {}),
	});
	return Response.json(result);
}

/** DELETE /api/drafts/:id */
export async function handleDeleteDraft(event: RequestEvent, id: string): Promise<Response> {
	const db = event.locals.db;
	if (!db) return DelightError.badRequest('No mailbox').toResponse();
	return Response.json(await db.deleteDraft(id));
}
