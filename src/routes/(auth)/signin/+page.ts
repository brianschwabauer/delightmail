import type { PageLoad } from './$types';

export const load: PageLoad = async ({ parent }) => {
	const { auth } = await parent();
	return { auth };
};
