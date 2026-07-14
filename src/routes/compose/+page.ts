import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';

/**
 * PWA entry point for the `mailto:` protocol handler and the share target
 * Both land here; we translate their params into a compose request and
 * bounce into the mail layout, which owns the compose overlay.
 */
export const load: PageLoad = ({ url }) => {
	const out = new URLSearchParams();

	const mailto = url.searchParams.get('mailto');
	if (mailto) {
		// mailto:addr[,addr]?subject=..&body=..
		const rest = mailto.replace(/^mailto:/i, '');
		const [addr, qs] = rest.split('?');
		if (addr) out.set('to', decodeURIComponent(addr));
		const q = new URLSearchParams(qs ?? '');
		const subject = q.get('subject');
		const body = q.get('body');
		const cc = q.get('cc');
		if (subject) out.set('subject', subject);
		if (body) out.set('body', body);
		if (cc) out.set('cc', cc);
	} else {
		// Web Share Target (GET): title / text / url.
		const title = url.searchParams.get('title');
		const text = url.searchParams.get('text');
		const shared = url.searchParams.get('url');
		const to = url.searchParams.get('to');
		if (title) out.set('subject', title);
		const body = [text, shared].filter(Boolean).join('\n');
		if (body) out.set('body', body);
		if (to) out.set('to', to);
	}

	out.set('compose', '1');
	redirect(302, `/mail/inbox?${out}`);
};
