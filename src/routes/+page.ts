import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ parent }) => {
	const { auth } = await parent();
	if (auth.signed_out) throw redirect(307, '/signin');
	throw redirect(307, '/mail/inbox');
};
