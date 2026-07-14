import { redirect } from '@sveltejs/kit';
import { dev } from '$app/environment';
import { createClients } from '$lib/clients';
import type { LayoutLoad } from './$types';

export const load: LayoutLoad = async ({ parent, fetch }) => {
	const { auth } = await parent();
	if (auth.signed_out) throw redirect(307, '/signin');
	// Org provisioning lives in hooks.server.ts (see orgHandle).
	const clients = await createClients({ auth, fetch, dev });
	return { auth, ...clients };
};
