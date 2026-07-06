/**
 * AI triage preview + unsubscribe execution endpoints (§7).
 */
import type { RequestEvent } from '@sveltejs/kit';
import { DelightError } from '@delightstack/utilities';

/** POST /api/triage/test { prompt, count } — run the prompt without acting. */
export async function handleTriageTest(event: RequestEvent): Promise<Response> {
	const db = event.locals.db;
	if (!db) return DelightError.badRequest('No mailbox').toResponse();
	const body = (await event.request.json().catch(() => ({}))) as {
		prompt?: string;
		count?: number;
	};
	const results = await db.triageTest(body.prompt ?? '', body.count ?? 5);
	return Response.json({ results });
}

/** POST /api/unsubscribe/:id — execute an unsubscribe task (RFC 8058 one-click). */
export async function handleUnsubscribe(event: RequestEvent, taskId: string): Promise<Response> {
	const db = event.locals.db;
	if (!db) return DelightError.badRequest('No mailbox').toResponse();

	let task: { id: string; method?: string; target?: string; sender_domain?: string };
	try {
		task = (await db.get('unsubscribe_task', taskId)) as never;
	} catch {
		return DelightError.notFound('Unsubscribe task not found').toResponse();
	}

	let ok = false;
	let manual: string | undefined;
	try {
		if (task.method === 'http_oneclick' && task.target) {
			// RFC 8058: POST with the one-click body, server-side, no user interaction.
			const res = await fetch(task.target, {
				method: 'POST',
				headers: { 'content-type': 'application/x-www-form-urlencoded' },
				body: 'List-Unsubscribe=One-Click',
			});
			ok = res.ok;
		} else if (task.method === 'mailto') {
			// mailto unsubscribe requires sending from the receiving identity; queued
			// as a normal send in a follow-up. For now surface the link to the client.
			manual = task.target;
			ok = false;
		} else if (task.method === 'link_manual' && task.target) {
			manual = task.target;
			ok = false;
		}
	} catch (err) {
		return Response.json({ ok: false, error: (err as Error).message });
	}

	await db.update('unsubscribe_task', taskId, {
		status: ok ? 'done' : 'failed',
		completed_at: Date.now(),
	});
	return Response.json({ ok, manual });
}
