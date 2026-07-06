import { redirect } from '@sveltejs/kit';
import { dev, browser } from '$app/environment';
import { createClients } from '$lib/clients';
import type { LayoutLoad } from './$types';

export const load: LayoutLoad = async ({ parent, fetch }) => {
	const { auth } = await parent();
	if (auth.signed_out) throw redirect(307, '/signin');
	if (browser && !auth.org_id) await auth.createOrg({ name: `${auth.name || 'Personal'}'s Mail` });
	const clients = await createClients({ auth, fetch, dev });
	return { auth, ...clients };
};
