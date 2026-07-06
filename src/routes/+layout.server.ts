import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = ({ locals }) => {
	return {
		auth_client_data: locals.auth_client_data,
	};
};
