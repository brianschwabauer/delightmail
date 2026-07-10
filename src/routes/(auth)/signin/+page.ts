import type { PageLoad } from './$types';

export const load: PageLoad = async ({ parent, url }) => {
	const { auth } = await parent();
	// Set by the email-link handle when a link has expired or been used already.
	return { auth, error: url.searchParams.get('error') ?? '' };
};
