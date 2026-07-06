/**
 * List-Unsubscribe / RFC 8058 one-click extraction (§7.5). Pure — unit-tested in
 * unsubscribe.test.ts. Produces an unsubscribe-task candidate from a message's
 * headers; execution (server-side POST / mailto / manual link) is in the mail
 * pipeline.
 */
export type UnsubscribeMethod = 'http_oneclick' | 'mailto' | 'link_manual';

export interface UnsubscribeCandidate {
	method: UnsubscribeMethod;
	/** The URL to POST (oneclick), mailto: URI, or link to open (manual). */
	target: string;
	sender_domain: string;
}

/** Extract the `<...>` entries from a List-Unsubscribe header value. */
export function parseListUnsubscribe(value: string | undefined): string[] {
	if (!value) return [];
	return (value.match(/<([^>]+)>/g) ?? []).map((s) => s.slice(1, -1).trim());
}

export function senderDomain(fromEmail: string | undefined): string {
	if (!fromEmail) return '';
	const at = fromEmail.lastIndexOf('@');
	return at >= 0 ? fromEmail.slice(at + 1).toLowerCase().replace(/>$/, '') : '';
}

/**
 * Decide the best unsubscribe method for a message.
 * - RFC 8058 one-click: an https entry AND `List-Unsubscribe-Post: List-Unsubscribe=One-Click`.
 * - Otherwise a mailto: entry → email unsubscribe.
 * - Otherwise the first http(s) link → manual (open in browser).
 */
export function extractUnsubscribe(input: {
	list_unsubscribe?: string;
	list_unsubscribe_post?: string;
	from_email?: string;
	body_links?: string[];
}): UnsubscribeCandidate | undefined {
	const domain = senderDomain(input.from_email);
	const entries = parseListUnsubscribe(input.list_unsubscribe);
	const httpEntries = entries.filter((e) => /^https?:\/\//i.test(e));
	const mailtoEntries = entries.filter((e) => /^mailto:/i.test(e));

	const isOneClick =
		/one-?click/i.test(input.list_unsubscribe_post ?? '') && httpEntries.length > 0;

	if (isOneClick) {
		return { method: 'http_oneclick', target: httpEntries[0], sender_domain: domain };
	}
	if (mailtoEntries.length) {
		return { method: 'mailto', target: mailtoEntries[0], sender_domain: domain };
	}
	if (httpEntries.length) {
		return { method: 'link_manual', target: httpEntries[0], sender_domain: domain };
	}
	// Fall back to a body "unsubscribe" link if the header was absent.
	const bodyLink = (input.body_links ?? []).find((l) => /unsub|opt.?out|preferences/i.test(l));
	if (bodyLink) {
		return { method: 'link_manual', target: bodyLink, sender_domain: domain };
	}
	return undefined;
}
