/**
 * Org maintenance (§4.1).
 *
 * An org here is not a product concept — it's the key the mailbox Durable Object is
 * addressed by, one per user, never surfaced in the UI. A bug in the old client-side
 * `createOrg` (it fired whenever org resolution returned null, which it did as soon as
 * a second org existed) could leave an account owning a pile of empty duplicates. This
 * cleans them up.
 */
import type { RequestEvent } from '@sveltejs/kit';
import { DelightError } from '@delightstack/utilities';
import { countDocs, type ListableDb } from './db-list';

interface AuthLite {
	listOrgs(query: unknown): Promise<{ id: string; name?: string }[]>;
	markOrgDeleted(id: string): Promise<void>;
}

/**
 * POST /api/accounts/orgs/consolidate — soft-delete the caller's duplicate orgs.
 *
 * Deliberately narrow: it only ever touches orgs the caller OWNS, never the one this
 * session resolves to, and never one that still holds an account. Mail hangs off an
 * account, so "no accounts" is the same statement as "no mail to lose" — an org that
 * has one is reported back untouched rather than deleted.
 *
 * `markOrgDeleted`, not `deleteOrg`: deleteOrg hard-deletes the org row and leaves the
 * org_user membership rows pointing at it, and every later session refresh looks up the
 * org behind each membership. A hard delete would therefore throw on the next refresh
 * and lock the user out of their own account. The soft delete is what the library's own
 * DELETE /org/:id route uses, and `createSessionToken` skips orgs carrying a deleted_at.
 */
export async function handleOrgConsolidate(event: RequestEvent): Promise<Response> {
	const penv = (event.platform as App.Platform | undefined)?.env;
	const active = event.locals.org_id;
	const user_id = (event.locals as { session?: { uid?: string } }).session?.uid;
	if (!penv?.AUTH || !penv.MAILBOX || !active || !user_id) {
		return DelightError.badRequest('No mailbox for this session').toResponse();
	}

	const auth = penv.AUTH.get(penv.AUTH.idFromName('main')) as unknown as AuthLite;
	const owned = await auth.listOrgs({
		where: { key: 'owner_id', is: '=', value: user_id },
		limit: 100,
	});

	const deleted: string[] = [];
	const kept: { id: string; reason: string }[] = [];

	for (const org of owned) {
		if (org.id === active) {
			kept.push({ id: org.id, reason: 'active mailbox' });
			continue;
		}

		// Opening the org's mailbox to count its accounts. A read failure is not a
		// licence to delete — an org we can't inspect is an org we leave alone.
		let accounts: number;
		try {
			const db = penv.MAILBOX.get(penv.MAILBOX.idFromName(org.id)) as unknown as ListableDb;
			accounts = await countDocs(db, 'account');
		} catch (err) {
			console.error(`[orgs] could not inspect org ${org.id}, leaving it alone:`, err);
			kept.push({ id: org.id, reason: `could not inspect: ${(err as Error)?.message ?? err}` });
			continue;
		}

		if (accounts > 0) {
			kept.push({ id: org.id, reason: 'has accounts' });
			continue;
		}

		await auth.markOrgDeleted(org.id);
		deleted.push(org.id);
	}

	return Response.json({ active, deleted, kept });
}
