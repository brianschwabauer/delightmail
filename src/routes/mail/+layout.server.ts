import { redirect } from '@sveltejs/kit';
import { countDocs, type ListableDb } from '$lib/server/db-list';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ locals }) => {
	if (!locals.session) throw redirect(307, '/signin');

	// Does this mailbox have any account at all? Answered here, during SSR, so the very
	// first paint already knows which shell to render: the mail UI, or the setup wizard.
	//
	// The client's own account search cannot answer until its local index has loaded, and
	// treating "hasn't answered yet" as "no accounts" is what made the wizard flash over
	// the mail UI on every cold load.
	let has_accounts = true; // Fail open — a transient DO error must not look like a fresh install.
	try {
		const db = locals.db as unknown as ListableDb | undefined;
		if (db) has_accounts = (await countDocs(db, 'account')) > 0;
	} catch (err) {
		console.error('[mail] could not read accounts during SSR:', err);
	}

	return { has_accounts };
};
