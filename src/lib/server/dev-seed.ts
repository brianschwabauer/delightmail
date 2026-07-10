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

// People you'd actually email — they seed the To/Cc/Bcc autocomplete so it has
// something to suggest locally. `sent > 0` marks them known correspondents, so
// they rank above the inbound-only senders (the panel sorts by send_count). A
// deliberate mix of personal (gmail/outlook → Gravatar/initials) and company
// (→ favicon) addresses so avatars in the suggestion rows are visible too.
const PEOPLE: Array<[name: string, email: string, sent: number, received: number]> = [
	['Alex Rivera', 'alex.rivera@gmail.com', 12, 9],
	['Priya Patel', 'priya@acme.co', 8, 6],
	['Jordan Lee', 'jordan.lee@gmail.com', 5, 4],
	['Sam Okafor', 'sam@nimbus.io', 3, 5],
	['Taylor Kim', 'taylor.kim@outlook.com', 2, 1],
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

	// Seed the contact table too. In the live app this is maintained by ingest
	// (server/src/ingest.ts → maintainContacts); the dev seed writes messages
	// directly and so never touches it, which is why autocomplete looked empty
	// locally. Frequent correspondents first, then the inbound-only senders so
	// replies/forwards autocomplete as well.
	const contacts = [
		...PEOPLE.map(([name, email, sent, received]) => ({ name, email, sent, received })),
		...SENDERS.map(([name, email]) => ({ name, email, sent: 0, received: 5 })),
	];
	await Promise.all(
		contacts.map((c, i) =>
			db.create('contact', {
				email: c.email.toLowerCase(),
				name: c.name,
				send_count: c.sent,
				receive_count: c.received,
				last_interacted_at: now - i * 3_600_000,
				is_known_correspondent: c.sent > 0,
			}),
		),
	);

	return Response.json({ account_id: account.id, contacts: contacts.length, ...result });
}
