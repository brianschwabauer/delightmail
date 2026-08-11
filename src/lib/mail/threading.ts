/**
 * Conversation threading. Pure and exhaustively unit-tested
 * (threading.test.ts) — no I/O. The DB-integrated orchestration lives in
 * server/src/ingest.ts and calls `resolveThread` with lookup closures.
 *
 * Algorithm (simplified JWZ):
 *   1. Gmail threadId already mapped to a local thread → join it.
 *   2. In-Reply-To / References point at a known message → join its thread.
 *   3. Normalized subject + overlapping participant within 14 days → join.
 *   4. Otherwise → new thread.
 */

const SUBJECT_PREFIX = /^\s*(re|fwd?|aw|sv|vs|antw|rif|res)(\[\d+\])?\s*:\s*/i;
const LIST_TAG = /^\s*\[[^\]]+\]\s*/;

/** Strip Re:/Fwd:/[list] prefixes and collapse whitespace. */
export function normalizeSubject(subject: string | undefined | null): string {
	let s = (subject ?? '').trim();
	// Repeatedly strip leading reply/forward prefixes and list tags.
	let changed = true;
	while (changed) {
		changed = false;
		const afterPrefix = s.replace(SUBJECT_PREFIX, '');
		if (afterPrefix !== s) {
			s = afterPrefix;
			changed = true;
		}
		const afterTag = s.replace(LIST_TAG, '');
		if (afterTag !== s) {
			s = afterTag;
			changed = true;
		}
	}
	return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

export interface ThreadCandidate {
	id: string;
	subject_normalized: string;
	participant_emails: string[];
	last_message_at: number;
}

export interface ResolveThreadInput {
	/** Gmail threadId of the incoming message (if any). */
	gmail_thread_id?: string;
	/** In-Reply-To header value (an rfc822 message-id). */
	in_reply_to?: string;
	/** References header values (rfc822 message-ids). */
	references?: string[];
	subject?: string;
	participant_emails: string[];
	/** The user's own address(es) on this account. Excluded from the subject
	 *  fallback's participant-overlap test — the user is on EVERY message, so
	 *  counting them makes the guard vacuous and merges unrelated mail that
	 *  happens to share a subject (GitHub "Run failed: CI" across repos). */
	self_emails?: string[];
	date: number;
}

export interface ThreadLookups {
	/** Local thread id currently mapped to a Gmail threadId, if any. */
	byGmailThreadId(gmail_thread_id: string): string | undefined;
	/** Local thread id containing a message with this rfc822 message-id, if any. */
	byMessageId(rfc822_message_id: string): string | undefined;
	/** Candidate threads sharing the normalized subject. */
	bySubject(subject_normalized: string): ThreadCandidate[];
}

export const SUBJECT_THREAD_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

export interface ResolveThreadResult {
	/** Existing thread id to join, or undefined to create a new thread. */
	thread_id?: string;
	/** How the decision was made (useful for debugging + tests). */
	reason: 'gmail' | 'references' | 'subject' | 'new';
	subject_normalized: string;
}

export function resolveThread(
	input: ResolveThreadInput,
	lookups: ThreadLookups,
): ResolveThreadResult {
	const subject_normalized = normalizeSubject(input.subject);

	// 1. Gmail threadId mapping.
	if (input.gmail_thread_id) {
		const id = lookups.byGmailThreadId(input.gmail_thread_id);
		if (id) return { thread_id: id, reason: 'gmail', subject_normalized };
	}

	// 2. In-Reply-To / References chain (most recent reference first).
	const refs: string[] = [];
	if (input.in_reply_to) refs.push(input.in_reply_to);
	if (input.references) {
		for (const r of input.references) if (!refs.includes(r)) refs.push(r);
	}
	for (let i = refs.length - 1; i >= 0; i--) {
		const id = lookups.byMessageId(refs[i]);
		if (id) return { thread_id: id, reason: 'references', subject_normalized };
	}

	// 3. Subject + overlapping participant within the window.
	// Skipped when the provider supplied its own thread id that matched nothing:
	// Gmail already decided this starts a NEW conversation, and overriding that
	// by subject merges unrelated notification mail (same-subject GitHub/npm
	// messages across different issues/repos) into one mega-thread.
	if (subject_normalized && !input.gmail_thread_id) {
		const self = new Set((input.self_emails ?? []).map((e) => e.toLowerCase()));
		const incoming = new Set(
			input.participant_emails.map((e) => e.toLowerCase()).filter((e) => !self.has(e)),
		);
		const candidates = lookups.bySubject(subject_normalized);
		let best: ThreadCandidate | undefined;
		for (const c of candidates) {
			if (Math.abs(input.date - c.last_message_at) > SUBJECT_THREAD_WINDOW_MS) continue;
			const overlaps = c.participant_emails.some((e) => incoming.has(e.toLowerCase()));
			if (!overlaps) continue;
			if (!best || c.last_message_at > best.last_message_at) best = c;
		}
		if (best) return { thread_id: best.id, reason: 'subject', subject_normalized };
	}

	// 4. New thread.
	return { reason: 'new', subject_normalized };
}
