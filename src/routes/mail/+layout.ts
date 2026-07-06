import { redirect } from '@sveltejs/kit';
import { dev } from '$app/environment';
import { createClients } from '$lib/clients';
import type { LayoutLoad } from './$types';

export const load: LayoutLoad = async ({ parent, fetch }) => {
	const { auth } = await parent();

	if (auth.signed_out) throw redirect(307, '/signin');

	// One org per user ("personal workspace") — created automatically on first
	// visit so the user never sees an org-picker (§4.1).
	if (!auth.org_id) {
		await auth.createOrg({ name: `${auth.name || 'Personal'}'s Mail` });
	}

	const clients = await createClients({ auth, fetch, dev });

	return { auth, ...clients };
};
