/**
 * Gmail API adapter. Thin, dependency-free client over the Gmail REST API
 * plus the normalization that turns a raw Gmail message into a NormalizedMessage
 * (writing raw/html/text to R2 along the way). Called by SyncEngine job handlers.
 */
import { parseEmail } from '../../../src/lib/mail/mime';
import { sanitizeEmailHtml } from '../../../src/lib/mail/sanitize';
import {
	messagePrefix,
	writeBodies,
	writeAttachments,
	type BodyKeys,
	type StoredAttachment,
} from '../body-store';
import type { NormalizedMessage } from '../ingest';
import { fetchWithTimeout } from '../http';

const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

export interface GmailCredentials {
	refresh_token: string;
	access_token?: string;
	access_token_expiry?: number;
}

export interface GmailProfile {
	emailAddress: string;
	historyId: string;
}

/** Exchange a refresh token for a fresh access token. */
export async function refreshAccessToken(
	client_id: string,
	client_secret: string,
	refresh_token: string,
): Promise<{ access_token: string; expires_in: number }> {
	const res = await fetchWithTimeout(TOKEN_URL, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			client_id,
			client_secret,
			refresh_token,
			grant_type: 'refresh_token',
		}),
	});
	if (!res.ok) throw new Error(`Gmail token refresh failed: ${res.status} ${await res.text()}`);
	return res.json();
}

/** Exchange an authorization code for tokens (the OAuth connect callback). */
export async function exchangeCode(
	client_id: string,
	client_secret: string,
	code: string,
	redirect_uri: string,
): Promise<{ access_token: string; refresh_token?: string; expires_in: number }> {
	const res = await fetchWithTimeout(TOKEN_URL, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			client_id,
			client_secret,
			code,
			redirect_uri,
			grant_type: 'authorization_code',
		}),
	});
	if (!res.ok) throw new Error(`Gmail code exchange failed: ${res.status} ${await res.text()}`);
	return res.json();
}

interface GmailListResponse {
	messages?: Array<{ id: string; threadId: string }>;
	nextPageToken?: string;
	resultSizeEstimate?: number;
}

export interface GmailMessage {
	id: string;
	threadId: string;
	labelIds?: string[];
	raw?: string;
	internalDate?: string;
}

interface GmailHistoryResponse {
	history?: Array<{
		id: string;
		messagesAdded?: Array<{ message: { id: string; threadId: string; labelIds?: string[] } }>;
		messagesDeleted?: Array<{ message: { id: string; threadId: string } }>;
		labelsAdded?: Array<{ message: { id: string; threadId: string }; labelIds: string[] }>;
		labelsRemoved?: Array<{ message: { id: string; threadId: string }; labelIds: string[] }>;
	}>;
	nextPageToken?: string;
	historyId?: string;
}

export class GmailClient {
	constructor(private access_token: string) {}

	private async call<T>(path: string, init?: RequestInit): Promise<T> {
		const res = await fetchWithTimeout(`${GMAIL_BASE}${path}`, {
			...init,
			headers: {
				authorization: `Bearer ${this.access_token}`,
				'content-type': 'application/json',
				...(init?.headers ?? {}),
			},
		});
		if (res.status === 429 || res.status >= 500) {
			throw new RetryableError(`Gmail ${res.status} on ${path}`);
		}
		if (!res.ok) {
			throw new GmailApiError(res.status, `Gmail ${res.status} on ${path}: ${await res.text()}`);
		}
		return res.json();
	}

	getProfile(): Promise<GmailProfile> {
		return this.call<GmailProfile>('/profile');
	}

	listMessageIds(pageToken?: string, q?: string): Promise<GmailListResponse> {
		const params = new URLSearchParams({ maxResults: '500' });
		if (pageToken) params.set('pageToken', pageToken);
		if (q) params.set('q', q);
		return this.call<GmailListResponse>(`/messages?${params}`);
	}

	getRaw(id: string): Promise<GmailMessage> {
		return this.call<GmailMessage>(`/messages/${id}?format=raw`);
	}

	getMetadata(id: string): Promise<GmailMessage> {
		return this.call<GmailMessage>(`/messages/${id}?format=minimal`);
	}

	listLabels(): Promise<{ labels?: Array<{ id: string; name: string; type: string }> }> {
		return this.call('/labels');
	}

	listHistory(startHistoryId: string, pageToken?: string): Promise<GmailHistoryResponse> {
		const params = new URLSearchParams({ startHistoryId, maxResults: '500' });
		if (pageToken) params.set('pageToken', pageToken);
		return this.call<GmailHistoryResponse>(`/history?${params}`);
	}

	watch(topicName: string): Promise<{ historyId: string; expiration: string }> {
		return this.call('/watch', {
			method: 'POST',
			body: JSON.stringify({ topicName, labelIds: ['INBOX'] }),
		});
	}

	stopWatch(): Promise<unknown> {
		return this.call('/stop', { method: 'POST' });
	}

	modify(id: string, addLabelIds: string[], removeLabelIds: string[]): Promise<unknown> {
		return this.call(`/messages/${id}/modify`, {
			method: 'POST',
			body: JSON.stringify({ addLabelIds, removeLabelIds }),
		});
	}

	trash(id: string): Promise<unknown> {
		return this.call(`/messages/${id}/trash`, { method: 'POST' });
	}

	untrash(id: string): Promise<unknown> {
		return this.call(`/messages/${id}/untrash`, { method: 'POST' });
	}

	send(rawBase64Url: string, threadId?: string): Promise<{ id: string; threadId: string }> {
		return this.call('/messages/send', {
			method: 'POST',
			body: JSON.stringify({ raw: rawBase64Url, ...(threadId ? { threadId } : {}) }),
		});
	}

	/**
	 * Find an already-sent message by its RFC822 Message-ID. Used to
	 * dedup an outbound send on retry: Gmail's messages.send is NOT idempotent, so
	 * if a prior attempt delivered before we recorded it (a crash in the
	 * send→record window), we must detect the existing copy instead of re-sending.
	 */
	async findSentByRfc822MessageId(
		messageId: string,
	): Promise<{ id: string; threadId: string } | null> {
		const clean = messageId.replace(/[<>]/g, '').trim();
		if (!clean) return null;
		const res = await this.listMessageIds(undefined, `rfc822msgid:${clean}`);
		const first = res.messages?.[0];
		return first ? { id: first.id, threadId: first.threadId } : null;
	}
}

export class RetryableError extends Error {
	readonly retryable = true;
}

/** A non-retryable Gmail API HTTP error, carrying the status so callers can tell
 *  a definitively-gone message (404/410) apart from a transient/auth failure. */
export class GmailApiError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
		this.name = 'GmailApiError';
	}
}

/** True only when a message is DEFINITIVELY gone at Gmail (deleted between the
 *  list and the fetch) — the one case where skipping it is safe. Everything else
 *  (401 token expiry, 403 quota, 400, network timeout) is transient and must
 * retry rather than advance the sync cursor past un-fetched mail. */
export function isMessageGoneError(err: unknown): boolean {
	return err instanceof GmailApiError && (err.status === 404 || err.status === 410);
}

/** True when Gmail rejected the access token (401) — the caller should drop the
 *  cached token so the retry forces a refresh. */
export function isAuthError(err: unknown): boolean {
	return err instanceof GmailApiError && err.status === 401;
}

/** Map Gmail label ids to DelightMail folder + flags. */
export function gmailLabelsToState(labelIds: string[] = []): {
	folder: string;
	is_read: boolean;
	is_starred: boolean;
	is_outbound: boolean;
} {
	const set = new Set(labelIds);
	let folder = 'archive'; // no INBOX label = archived
	if (set.has('TRASH')) folder = 'trash';
	else if (set.has('SPAM')) folder = 'spam';
	else if (set.has('DRAFT')) folder = 'drafts';
	else if (set.has('SENT')) folder = 'sent';
	else if (set.has('INBOX')) folder = 'inbox';
	return {
		folder,
		is_read: !set.has('UNREAD'),
		is_starred: set.has('STARRED'),
		is_outbound: set.has('SENT') || set.has('DRAFT'),
	};
}

/** Gmail's built-in system labels — everything else is a user label. */
const SYSTEM_LABELS = new Set([
	'INBOX',
	'SENT',
	'DRAFT',
	'TRASH',
	'SPAM',
	'UNREAD',
	'STARRED',
	'IMPORTANT',
	'CHAT',
	'CATEGORY_PERSONAL',
	'CATEGORY_SOCIAL',
	'CATEGORY_PROMOTIONS',
	'CATEGORY_UPDATES',
	'CATEGORY_FORUMS',
]);

/** Decode Gmail's base64url `raw`, parse, sanitize, write bodies, normalize. */
export async function gmailToNormalized(
	msg: GmailMessage,
	ctx: { account_id: string; org_id: string; r2: R2Bucket; labelMap?: Record<string, string> },
): Promise<NormalizedMessage> {
	const rawBytes = base64UrlToBytes(msg.raw ?? '');
	const parsed = await parseEmail(rawBytes, {
		receivedAt: msg.internalDate ? Number(msg.internalDate) : undefined,
	});
	const state = gmailLabelsToState(msg.labelIds);

	// User (non-system) Gmail labels → DelightMail labels, carrying the Gmail label
	// id so the provider_map can round-trip. Names come from the cached map.
	const labels = (msg.labelIds ?? [])
		.filter((id) => !SYSTEM_LABELS.has(id) && ctx.labelMap?.[id])
		.map((id) => ({ name: ctx.labelMap![id], provider_id: id }));

	const html = parsed.html ? sanitizeEmailHtml(parsed.html, { cidBase: '/api/attachments' }) : '';
	const prefix = await messagePrefix(ctx.org_id, parsed.rfc822_message_id);
	// R2 writes are the transient-failure surface here. Wrap them as RetryableError
	// so a storage blip retries the whole page instead of dropping the message and
	// letting the sync cursor advance past it (never silently lose mail).
	let body_keys: BodyKeys;
	let attachments: StoredAttachment[];
	try {
		body_keys = await writeBodies(ctx.r2, prefix, {
			raw: rawBytes,
			html: html || undefined,
			text: parsed.text || undefined,
		});
		// format=raw carries attachment bytes inline, so store them here. (The >2MB
		// lazy-fetch optimization is a follow-up; correctness first.)
		attachments = await writeAttachments(
			ctx.r2,
			prefix,
			parsed.attachments.map((a) => ({
				filename: a.filename,
				mime_type: a.mime_type,
				content: a.content,
				content_id: a.content_id,
				size_bytes: a.size_bytes,
			})),
		);
	} catch (err) {
		if (err instanceof RetryableError) throw err;
		throw new RetryableError(`R2 write failed for message ${msg.id}: ${String(err)}`);
	}

	return {
		rfc822_message_id: parsed.rfc822_message_id,
		account_id: ctx.account_id,
		gmail_thread_id: msg.threadId,
		in_reply_to: parsed.in_reply_to,
		references: parsed.references,
		provider_ids: { gmail_id: msg.id, gmail_thread_id: msg.threadId },
		from: parsed.from,
		to: parsed.to,
		cc: parsed.cc,
		bcc: parsed.bcc,
		reply_to: parsed.reply_to,
		subject: parsed.subject,
		snippet: parsed.snippet,
		text_excerpt: parsed.text_excerpt,
		body_keys,
		date: parsed.date,
		is_read: state.is_read,
		is_starred: state.is_starred,
		is_outbound: state.is_outbound,
		folder: state.folder,
		headers_subset: parsed.headers_subset as Record<string, unknown>,
		attachments,
		labels,
		attachment_count: parsed.attachments.length,
		size_bytes: parsed.size_bytes,
	};
}

export function base64UrlToBytes(b64url: string): Uint8Array {
	const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
	const padded = b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), '=');
	const bin = atob(padded);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}
