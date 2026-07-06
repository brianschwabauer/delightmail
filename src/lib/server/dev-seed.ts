/**
 * Dev-only mailbox seeding (wired only when `dev` in mail-handle). Creates a
 * demo account + a spread of sample threads so the read/action UI can be
 * exercised without a live Gmail connection. Never reachable in production.
 */
import type { RequestEvent } from '@sveltejs/kit';

const SENDERS = [
	['Sarah Chen', 'sarah@example.com'],
	['Cloudflare', 'noreply@cloudflare.com'],
	['Mom', 'mom@family.net'],
	['GitHub', 'notifications@github.com'],
	['Stripe', 'receipts@stripe.com'],
	['The Verge', 'newsletter@theverge.com'],
	['Linear', 'notifications@linear.app'],
	['Amazon', 'ship-confirm@amazon.com'],
];
const SUBJECTS = [
	'Re: Q3 planning doc — one more thought',
	'Your deployment succeeded ✓',
	'Sunday dinner?',
	'[delightstack] PR #142 merged',
	'Receipt: $12.00 — Workers Paid',
	'The best gadgets of the year',
	'You were assigned an issue',
	'Your package is on the way',
];

export async function handleDevSeed(event: RequestEvent): Promise<Response> {
	const db = event.locals.db;
	if (!db) return new Response('No mailbox', { status: 400 });

	// One demo account (messages FK-reference it) + a default identity to send as.
	const account = (await db.create('account', {
		kind: 'gmail',
		email: 'demo@gmail.com',
		display_name: 'Demo Gmail',
		color: '#d97706',
		status: 'live',
		config: { gmail_address: 'demo@gmail.com' },
	})) as { id: string };
	await db.create('identity', {
		account_id: account.id,
		email: 'demo@gmail.com',
		name: 'Demo',
		is_default: true,
	});

	const now = Date.now();
	const batch = Array.from({ length: 40 }, (_, i) => {
		const [name, emailAddr] = SENDERS[i % SENDERS.length];
		const subject = SUBJECTS[i % SUBJECTS.length];
		return {
			rfc822_message_id: `<seed-${i}-${now}@demo>`,
			account_id: account.id,
			subject: `${subject}${i >= SENDERS.length ? ` (${i})` : ''}`,
			from: { name, email: emailAddr },
			to: [{ email: 'me@demo.com' }],
			text_excerpt: `This is sample message ${i} from ${name}. It exercises the list, reading pane, and actions without a live account.`,
			snippet: `Sample message ${i} from ${name}.`,
			date: now - i * 3_600_000,
			is_read: i % 3 === 0,
			is_outbound: false,
			folder: 'inbox',
			references: [],
		};
	});

	const result = await db.ingestMessages(batch);
	return Response.json({ account_id: account.id, ...result });
}
