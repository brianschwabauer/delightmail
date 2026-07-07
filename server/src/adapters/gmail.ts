/**
 * Gmail API adapter (§5.1). Thin, dependency-free client over the Gmail REST API
 * plus the normalization that turns a raw Gmail message into a NormalizedMessage
 * (writing raw/html/text to R2 along the way). Called by SyncEngine job handlers.
 */
import { parseEmail } from '../../../src/lib/mail/mime';
import { sanitizeEmailHtml } from '../../../src/lib/mail/sanitize';
import { messagePrefix, writeBodies, writeAttachments } from '../body-store';
import type { NormalizedMessage } from '../ingest';

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
	const res = await fetch(TOKEN_URL, {
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
	const res = await fetch(TOKEN_URL, {
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

interface GmailMessage {
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
		const res = await fetch(`${GMAIL_BASE}${path}`, {
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
		if (!res.ok) throw new Error(`Gmail ${res.status} on ${path}: ${await res.text()}`);
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

	send(rawBase64Url: string, threadId?: string): Promise<{ id: string; threadId: string }> {
		return this.call('/messages/send', {
			method: 'POST',
			body: JSON.stringify({ raw: rawBase64Url, ...(threadId ? { threadId } : {}) }),
		});
	}
}

export class RetryableError extends Error {
	readonly retryable = true;
}

/** Map Gmail label ids to DelightMail folder + flags (§5.1). */
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

/** Decode Gmail's base64url `raw`, parse, sanitize, write bodies, normalize. */
export async function gmailToNormalized(
	msg: GmailMessage,
	ctx: { account_id: string; org_id: string; r2: R2Bucket },
): Promise<NormalizedMessage> {
	const rawBytes = base64UrlToBytes(msg.raw ?? '');
	const parsed = await parseEmail(rawBytes, {
		receivedAt: msg.internalDate ? Number(msg.internalDate) : undefined,
	});
	const state = gmailLabelsToState(msg.labelIds);

	const html = parsed.html ? sanitizeEmailHtml(parsed.html, { cidBase: '/api/attachments' }) : '';
	const prefix = await messagePrefix(ctx.org_id, parsed.rfc822_message_id);
	const body_keys = await writeBodies(ctx.r2, prefix, {
		raw: rawBytes,
		html: html || undefined,
		text: parsed.text || undefined,
	});
	// format=raw carries attachment bytes inline, so store them here. (The >2MB
	// lazy-fetch optimization from §5.1 is a follow-up; correctness first.)
	const attachments = await writeAttachments(
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
		attachment_count: parsed.attachments.length,
		size_bytes: parsed.size_bytes,
	};
}

function base64UrlToBytes(b64url: string): Uint8Array {
	const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
	const padded = b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), '=');
	const bin = atob(padded);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}
