/**
 * AI triage preview + unsubscribe execution endpoints (§7).
 */
import type { RequestEvent } from '@sveltejs/kit';
import { DelightError } from '@delightstack/utilities';
import { safeUnsubscribePost } from '$lib/mail/safe-fetch';

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

interface UnsubTask {
	id: string;
	method?: string;
	target?: string;
	sender_domain?: string;
}

interface UnsubDb {
	get(t: string, id: string): Promise<unknown> | unknown;
	update(t: string, id: string, data: Record<string, unknown>): Promise<unknown> | unknown;
	create(t: string, data: Record<string, unknown>): Promise<unknown> | unknown;
}

/** POST /api/unsubscribe/:id { block? } — execute an unsubscribe task (RFC 8058). */
export async function handleUnsubscribe(event: RequestEvent, taskId: string): Promise<Response> {
	const db = event.locals.db as unknown as UnsubDb | undefined;
	if (!db) return DelightError.badRequest('No mailbox').toResponse();
	const body = (await event.request.json().catch(() => ({}))) as { block?: boolean };

	let task: UnsubTask;
	try {
		task = (await db.get('unsubscribe_task', taskId)) as UnsubTask;
	} catch {
		return DelightError.notFound('Unsubscribe task not found').toResponse();
	}

	const result = await executeUnsubscribe(db, task, !!body.block);
	return Response.json(result);
}

/** POST /api/unsubscribe/bulk { task_ids, block? } — execute several at once. */
export async function handleUnsubscribeBulk(event: RequestEvent): Promise<Response> {
	const db = event.locals.db as unknown as UnsubDb | undefined;
	if (!db) return DelightError.badRequest('No mailbox').toResponse();
	const body = (await event.request.json().catch(() => ({}))) as {
		task_ids?: string[];
		block?: boolean;
	};
	const ids = Array.isArray(body.task_ids) ? body.task_ids.slice(0, 200) : [];
	const results: Array<{ task_id: string; ok: boolean; manual?: string }> = [];
	for (const id of ids) {
		let task: UnsubTask;
		try {
			task = (await db.get('unsubscribe_task', id)) as UnsubTask;
		} catch {
			results.push({ task_id: id, ok: false });
			continue;
		}
		const r = await executeUnsubscribe(db, task, !!body.block);
		results.push({ task_id: id, ok: r.ok, manual: r.manual });
	}
	return Response.json({ results });
}

/**
 * Run a single unsubscribe task. http_oneclick does a server-side RFC 8058 POST;
 * on failure it downgrades to a manual link rather than dead-ending (§7.5).
 * `block` additionally creates a trash sender_rule — the real guarantee against
 * spammers who ignore unsubscribes.
 */
export async function executeUnsubscribe(
	db: UnsubDb,
	task: UnsubTask,
	block: boolean,
): Promise<{ ok: boolean; manual?: string; blocked?: boolean }> {
	let ok = false;
	let manual: string | undefined;
	let downgraded = false;

	try {
		if (task.method === 'http_oneclick' && task.target) {
			const res = await safeUnsubscribePost(task.target);
			ok = res.ok;
			if (!ok) {
				// One-click POST rejected → fall back to the link the user can open.
				manual = task.target;
				downgraded = true;
			}
		} else if (task.method === 'link_manual' && task.target) {
			manual = task.target;
		} else if (task.method === 'mailto') {
			// mailto unsubscribe is sent from the receiving identity in a follow-up;
			// surface it as a manual action for now.
			manual = task.target;
		}
	} catch {
		// Network failure → downgrade to a manual link.
		if (task.target) {
			manual = task.target;
			downgraded = true;
		}
	}

	try {
		await db.update('unsubscribe_task', task.id, {
			status: ok ? 'done' : downgraded ? 'failed' : 'suggested',
			method: downgraded ? 'link_manual' : task.method,
			completed_at: ok ? Date.now() : undefined,
		});
	} catch {
		/* best-effort */
	}

	// Block = unsubscribe attempt + a trash rule for the sender domain.
	let blocked = false;
	if (block && task.sender_domain) {
		try {
			await db.create('sender_rule', {
				matcher: { from_domain: task.sender_domain },
				action: 'trash',
				source: 'user',
				hit_count: 0,
			});
			blocked = true;
		} catch {
			/* ignore */
		}
	}

	return { ok, manual, blocked };
}
