/**
 * Reply-from identity resolution (§6). Pure — unit-tested in identity.test.ts.
 * Replies default to the address that RECEIVED the thread; new composes default
 * to the last-used identity, then the global default.
 */
import type { Address } from '../schema';

export interface IdentityLike {
	id: string;
	email: string;
	account_id: string;
	is_default?: boolean;
	auto_created?: boolean;
}

export interface ReplyContext {
	/** identity_email recorded on the message being replied to (who received it). */
	received_as?: string;
	/** To/Cc recipients of the message being replied to. */
	recipients?: Address[];
	/** account_id of the message being replied to. */
	account_id?: string;
}

function byEmail(identities: IdentityLike[], email: string | undefined): IdentityLike | undefined {
	if (!email) return undefined;
	const lower = email.toLowerCase();
	return identities.find((i) => i.email.toLowerCase() === lower);
}

/**
 * Resolve the identity to send a reply from.
 * 1. The address the message was received as.
 * 2. Any identity present in To/Cc.
 * 3. The account default, then the global default.
 */
export function resolveReplyIdentity(
	identities: IdentityLike[],
	ctx: ReplyContext,
): IdentityLike | undefined {
	if (!identities.length) return undefined;

	const received = byEmail(identities, ctx.received_as);
	if (received) return received;

	for (const r of ctx.recipients ?? []) {
		const match = byEmail(identities, r.email);
		if (match) return match;
	}

	if (ctx.account_id) {
		const accountDefault = identities.find(
			(i) => i.account_id === ctx.account_id && i.is_default,
		);
		if (accountDefault) return accountDefault;
		const anyOnAccount = identities.find((i) => i.account_id === ctx.account_id);
		if (anyOnAccount) return anyOnAccount;
	}

	return identities.find((i) => i.is_default) ?? identities[0];
}

/**
 * Resolve the identity for a new (non-reply) compose: the last-used identity,
 * falling back to the global default, then the first.
 */
export function resolveComposeIdentity(
	identities: IdentityLike[],
	last_used_id?: string,
): IdentityLike | undefined {
	if (!identities.length) return undefined;
	if (last_used_id) {
		const last = identities.find((i) => i.id === last_used_id);
		if (last) return last;
	}
	return identities.find((i) => i.is_default) ?? identities[0];
}
