import { redirect } from '@sveltejs/kit';
import { dev } from '$app/environment';
import { createClients } from '$lib/clients';
import type { LayoutLoad } from './$types';

export const load: LayoutLoad = async ({ parent, fetch, data }) => {
	const { auth } = await parent();

	if (auth.signed_out) throw redirect(307, '/signin');

	// The one org per user ("personal workspace") is provisioned server-side
	// in hooks.server.ts, so `auth.org_id` is always set by the time we get here —
	// which matters, because the local database below is namespaced by it.
	const clients = await createClients({ auth, fetch, dev });

	// Forward the server load's answer explicitly: this universal load's return value
	// *replaces* it as the layout's data, so anything not passed through is dropped.
	return { auth, has_accounts: data.has_accounts, ...clients };
};
