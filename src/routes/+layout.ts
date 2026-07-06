import { AuthClient } from '@delightstack/auth/client';
import type { LayoutLoad } from './$types';

export const load: LayoutLoad = ({ data }) => {
	const auth = new AuthClient(data.auth_client_data);
	return { auth };
};
