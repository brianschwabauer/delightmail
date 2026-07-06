import { error } from '@sveltejs/kit';
import type { PageLoad } from './$types';

const VIEWS = new Set([
	'inbox',
	'filtered',
	'starred',
	'sent',
	'drafts',
	'archive',
	'spam',
	'trash',
	'search',
]);

export const load: PageLoad = async ({ params, parent }) => {
	const data = await parent();
	if (!VIEWS.has(params.view) && !params.view.startsWith('label')) {
		throw error(404, `Unknown mail view: ${params.view}`);
	}
	return { ...data, view: params.view };
};
