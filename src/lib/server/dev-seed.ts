/**
 * Dev-only mailbox seeding (wired only when `dev` in mail-handle). Creates a
 * demo account plus a spread of realistic sample threads — with real bodies in
 * R2, so the reading pane renders — letting the whole read/action UI be
 * exercised without connecting a live account. Never reachable in production.
 */
import type { RequestEvent } from '@sveltejs/kit';

interface SeedAttachment {
	filename: string;
	mime_type: string;
	/** Generates the file bytes (kept lazy so the seed module stays small). */
	content: () => Uint8Array;
}

interface SeedMessage {
	from: [name: string, email: string];
	subject: string;
	body: string;
	/** Hours ago. */
	age: number;
	is_read?: boolean;
	is_starred?: boolean;
	/** Groups messages into one thread; omit for a single-message thread. */
	thread?: string;
	is_outbound?: boolean;
	attachments?: SeedAttachment[];
}

// --- Attachment byte generators (real, openable files) ---------------------

/** A tiny but valid single-page PDF with the given title drawn on it. */
function tinyPdf(title: string): Uint8Array {
	const text = title.replace(/[()\\]/g, '');
	const stream = `BT /F1 18 Tf 72 720 Td (${text}) Tj ET`;
	const objects = [
		'<< /Type /Catalog /Pages 2 0 R >>',
		'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
		'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
		`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
		'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
	];
	let pdf = '%PDF-1.4\n';
	const offsets: number[] = [];
	objects.forEach((obj, i) => {
		offsets.push(pdf.length);
		pdf += `${i + 1} 0 obj\n${obj}\nendobj\n`;
	});
	const xref = pdf.length;
	pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
	pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
	return new TextEncoder().encode(pdf);
}

/** A small solid-color PNG (validly encoded; visible when opened). */
function tinyPng(r: number, g: number, b: number): Uint8Array {
	// 8x8 truecolor PNG, uncompressed deflate (stored blocks).
	const W = 8;
	const raw: number[] = [];
	for (let y = 0; y < W; y++) {
		raw.push(0); // filter: none
		for (let x = 0; x < W; x++) raw.push(r, g, b);
	}
	// zlib stream: header + single stored deflate block + adler32
	const data = new Uint8Array(raw);
	let a = 1,
		bAd = 0;
	for (const byte of data) {
		a = (a + byte) % 65521;
		bAd = (bAd + a) % 65521;
	}
	const stored = [
		0x78, 0x01, 0x01, data.length & 0xff, (data.length >> 8) & 0xff,
		~data.length & 0xff, (~data.length >> 8) & 0xff, ...data,
		(bAd >> 8) & 0xff, bAd & 0xff, (a >> 8) & 0xff, a & 0xff,
	];
	const crcTable = [...Array(256)].map((_, n) => {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		return c >>> 0;
	});
	const crc = (bytes: number[]) => {
		let c = 0xffffffff;
		for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
		return (c ^ 0xffffffff) >>> 0;
	};
	const chunk = (type: string, body: number[]) => {
		const t = [...type].map((ch) => ch.charCodeAt(0));
		const all = [...t, ...body];
		const c = crc(all);
		return [
			(body.length >> 24) & 0xff, (body.length >> 16) & 0xff,
			(body.length >> 8) & 0xff, body.length & 0xff,
			...all,
			(c >> 24) & 0xff, (c >> 16) & 0xff, (c >> 8) & 0xff, c & 0xff,
		];
	};
	const ihdr = chunk('IHDR', [0, 0, 0, W, 0, 0, 0, W, 8, 2, 0, 0, 0]);
	const idat = chunk('IDAT', stored);
	const iend = chunk('IEND', []);
	return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...ihdr, ...idat, ...iend]);
}

function textFile(text: string): () => Uint8Array {
	return () => new TextEncoder().encode(text);
}

const ICS_INVITE = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//DelightMail Seed//EN
BEGIN:VEVENT
UID:seed-dinner@delightmail.dev
DTSTART:20260823T000000Z
DTEND:20260823T020000Z
SUMMARY:Sunday dinner
LOCATION:Mom & Dad's
END:VEVENT
END:VCALENDAR
`;

const CONTRACT_CSV = `line,item,change,decision
1,Liability cap,Raise to 12 months of fees,accept
2,Data deletion clause,Struck entirely,reject
3,Renewal term,Auto-renew 12mo,accept
`;

const ME = 'demo@gmail.com';

const MESSAGES: SeedMessage[] = [
	{
		from: ['Sarah Chen', 'sarah.chen@gmail.com'],
		subject: 'Re: Q3 planning doc — one more thought',
		age: 1,
		thread: 'q3',
		body: `<p>One more thought before we lock this down.</p>
<p>The headcount section assumes we backfill the two open roles by August, but
recruiting told me their pipeline is more like October. If that slips, the whole
delivery timeline in section 4 slips with it.</p>
<p>Can we add a paragraph acknowledging that, rather than discovering it in
September? Happy to write it if you'd rather not touch the doc again.</p>
<p>— Sarah</p>`,
	},
	{
		from: ['Marcus Webb', 'marcus.webb@gmail.com'],
		subject: 'Re: Q3 planning doc — one more thought',
		age: 3,
		thread: 'q3',
		is_read: true,
		body: `<p>Good catch. I'd rather name the risk than pretend it away.</p>
<p>Add the paragraph — keep it to two sentences so it doesn't read as hedging,
and I'll get it in front of leadership on Thursday.</p>`,
	},
	{
		from: ['Cloudflare', 'noreply@cloudflare.com'],
		subject: 'Your deployment succeeded',
		age: 2,
		is_starred: true,
		body: `<p><strong>delightmail-server</strong> deployed successfully.</p>
<p>Version 4a91c2e is now live across 310 locations. Uploaded 106.28 KiB
(22.14 KiB gzipped) in 4.2s.</p>
<p style="color:#666;font-size:13px">You are receiving this because you enabled
deployment notifications for this account.</p>`,
	},
	{
		from: ['Mom', 'jane.h@fastmail.com'],
		subject: 'Sunday dinner?',
		age: 5,
		body: `<p>Are you free this Sunday? Your father is threatening to make the
lasagna again, and I think it would help to have a witness.</p>
<p>Around 6? Bring nothing, he insists.</p>`,
		attachments: [
			{ filename: 'Sunday dinner.ics', mime_type: 'text/calendar', content: textFile(ICS_INVITE) },
		],
	},
	{
		from: ['GitHub', 'notifications@github.com'],
		subject: '[delightstack] PR #142 merged: sanitize cid: image sources',
		age: 7,
		is_read: true,
		body: `<p><strong>rileyk</strong> merged pull request #142 into <code>main</code>.</p>
<blockquote style="border-left:3px solid #ddd;padding-left:12px;color:#555">
Resolves the case where an inline <code>cid:</code> reference in a multipart
message pointed at an attachment that had been stripped at ingest, leaving a
broken image icon in the reading pane.
</blockquote>
<p>3 commits · 47 additions · 12 deletions</p>`,
	},
	{
		from: ['Priya Patel', 'priya.patel@gmail.com'],
		subject: 'Contract redlines — need you by Friday',
		age: 9,
		body: `<p>Legal came back on the vendor agreement. Two things need your call:</p>
<ol>
<li>They want the liability cap raised to 12 months of fees. I think that's fine.</li>
<li>They struck the data-deletion clause entirely. I think that's <em>not</em> fine.</li>
</ol>
<p>If you can look before Friday we can still close this month.</p>`,
		attachments: [
			{
				filename: 'Vendor agreement — redlines v3.pdf',
				mime_type: 'application/pdf',
				content: () => tinyPdf('Vendor agreement - redlines v3'),
			},
			{ filename: 'redline-summary.csv', mime_type: 'text/csv', content: textFile(CONTRACT_CSV) },
		],
	},
	{
		from: ['Stripe', 'receipts@stripe.com'],
		subject: 'Your receipt from Cloudflare — $5.00',
		age: 26,
		is_read: true,
		body: `<p>Receipt #2847-1193</p>
<table style="border-collapse:collapse">
<tr><td style="padding:4px 16px 4px 0">Workers Paid</td><td>$5.00</td></tr>
<tr><td style="padding:4px 16px 4px 0">R2 storage</td><td>$0.14</td></tr>
<tr><td style="padding:4px 16px 4px 0;font-weight:600">Total</td><td style="font-weight:600">$5.14</td></tr>
</table>
<p style="color:#666;font-size:13px">Charged to Visa ending 4242.</p>`,
	},
	{
		from: ['Jordan Lee', 'jordan.lee@gmail.com'],
		subject: 'that bike you were looking at',
		age: 30,
		body: `<p>The shop on Delancey has the exact one in your size, last year's model,
30% off. I told them you'd come by this weekend, which may have been presumptuous
of me.</p>
<p>Go look at it before someone else does.</p>`,
	},
	{
		from: ['The Verge', 'newsletter@theverge.com'],
		subject: 'The best gadgets of the year, ranked',
		age: 33,
		is_read: true,
		body: `<h2 style="margin:0 0 8px">This week in tech</h2>
<p>Our annual list is out, and the top spot went to something nobody expected.</p>
<p><a href="https://example.com/read">Read the full list →</a></p>
<hr style="border:none;border-top:1px solid #eee;margin:16px 0">
<p style="color:#888;font-size:12px">You're receiving this because you subscribed
to The Verge newsletter. <a href="https://example.com/unsubscribe">Unsubscribe</a></p>`,
	},
	{
		from: ['Linear', 'notifications@linear.app'],
		subject: 'Sam assigned you ENG-418: reading pane scroll restoration',
		age: 49,
		body: `<p><strong>Sam Okafor</strong> assigned you an issue.</p>
<p style="font-size:15px"><strong>ENG-418</strong> · Reading pane loses scroll
position when returning from a thread</p>
<p>Priority: Medium · Cycle 12</p>`,
	},
	{
		from: ['Amazon', 'ship-confirm@amazon.com'],
		subject: 'Your package is on the way',
		age: 54,
		is_read: true,
		body: `<p>Arriving <strong>Thursday</strong>.</p>
<p>Mechanical keyboard, tactile switches (1 item)</p>
<p><a href="https://example.com/track">Track your package →</a></p>`,
	},
	{
		from: ['Sam Okafor', 'sam.okafor@fastmail.com'],
		subject: 'Re: lunch Thursday',
		age: 72,
		is_read: true,
		body: `<p>Thursday works. The place with the terrible name and the good noodles?</p>
<p>12:30, and I'm buying — you got the last three.</p>`,
	},
	{
		from: ['Taylor Kim', 'taylor.kim@outlook.com'],
		subject: 'Photos from the trip',
		age: 96,
		is_read: true,
		body: `<p>Finally got around to sorting these. There are 400 of them and roughly
six are good, which feels like a reasonable ratio.</p>
<p><a href="https://example.com/album">Shared album →</a></p>`,
		attachments: [
			{ filename: 'IMG_2481.png', mime_type: 'image/png', content: () => tinyPng(52, 120, 246) },
			{ filename: 'IMG_2497.png', mime_type: 'image/png', content: () => tinyPng(240, 130, 48) },
		],
	},
	{
		from: ['Alex Rivera', 'alex.rivera@gmail.com'],
		subject: 'Re: weekend plans',
		age: 120,
		is_read: true,
		body: `<p>Saturday is out — I've got the thing with my sister. Sunday I'm free
all day though.</p>
<p>Still up for the hike if the weather holds?</p>`,
	},
];

/**
 * People you email who haven't emailed you here — ingest already creates a
 * `contact` for every sender above, so these are the *outbound-only* ones. They
 * seed the To/Cc/Bcc autocomplete with known correspondents (`send_count > 0`),
 * which rank above inbound-only senders in the suggestion list.
 */
const PEOPLE: Array<[name: string, email: string, sent: number, received: number]> = [
	['Devon Cross', 'devon@rivet.dev', 14, 9],
	['Maya Lin', 'maya.lin@gmail.com', 9, 7],
	['Ravi Shah', 'ravi.shah@outlook.com', 4, 2],
];

/** Mirrors server/src/body-store.ts: bodies live at `{org_id}/msg/{hash}/…`. */
async function messagePrefix(org_id: string, rfc822_message_id: string): Promise<string> {
	const data = new TextEncoder().encode(rfc822_message_id);
	const digest = await crypto.subtle.digest('SHA-256', data);
	const hash = [...new Uint8Array(digest)]
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('')
		.slice(0, 40);
	return `${org_id}/msg/${hash}`;
}

/** Strip tags for the plain-text excerpt shown in the list. */
function toText(html: string): string {
	return html
		.replace(/<[^>]+>/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

export async function handleDevSeed(event: RequestEvent): Promise<Response> {
	const db = event.locals.db;
	const r2 = event.locals.r2;
	const org_id = event.locals.org_id;
	if (!db || !r2 || !org_id) return new Response('No mailbox', { status: 400 });

	// One demo account (messages FK-reference it) + a default identity to send as.
	const account = (await db.create('account', {
		kind: 'gmail',
		email: ME,
		display_name: 'Demo Gmail',
		color: '#d97706',
		status: 'live',
		config: { gmail_address: ME },
	})) as { id: string };
	await db.create('identity', {
		account_id: account.id,
		email: ME,
		name: 'Demo',
		is_default: true,
	});

	const now = Date.now();
	const batch = await Promise.all(
		MESSAGES.map(async (m, i) => {
			const rfc822_message_id = `<seed-${i}-${now}@delightmail.dev>`;
			// Real bodies in R2 so the reading pane renders instead of sitting empty.
			const prefix = await messagePrefix(org_id, rfc822_message_id);
			const text = toText(m.body);
			// Attachment bytes live at the same deterministic layout ingest uses
			// (`{prefix}/att/{i}`), so `/api/attachments/:id` serves them for real.
			const attachments = (m.attachments ?? []).map((a, ai) => {
				const bytes = a.content();
				return {
					filename: a.filename,
					mime_type: a.mime_type,
					size_bytes: bytes.length,
					r2_key: `${prefix}/att/${ai}`,
					bytes,
				};
			});
			await Promise.all([
				r2.put(`${prefix}/body.html`, m.body, {
					httpMetadata: { contentType: 'text/html; charset=utf-8' },
				}),
				r2.put(`${prefix}/body.txt`, text, {
					httpMetadata: { contentType: 'text/plain; charset=utf-8' },
				}),
				...attachments.map((a) =>
					r2.put(a.r2_key, a.bytes, { httpMetadata: { contentType: a.mime_type } }),
				),
			]);

			// Messages sharing a `thread` key also share a subject, so the pure
			// threading algorithm groups them exactly as it would for real mail.
			const root = m.thread ? `<seed-thread-${m.thread}@delightmail.dev>` : undefined;
			return {
				rfc822_message_id,
				account_id: account.id,
				subject: m.subject,
				from: { name: m.from[0], email: m.from[1] },
				to: [{ email: ME }],
				body_keys: { html: `${prefix}/body.html`, text: `${prefix}/body.txt` },
				text_excerpt: text.slice(0, 8000),
				snippet: text.slice(0, 140),
				date: now - m.age * 3_600_000,
				is_read: m.is_read ?? false,
				is_starred: m.is_starred ?? false,
				is_outbound: m.is_outbound ?? false,
				folder: 'inbox',
				in_reply_to: root && i > 0 ? root : undefined,
				references: root ? [root] : [],
				attachments: attachments.map(({ bytes: _bytes, ...a }) => a),
				attachment_count: attachments.length,
			};
		}),
	);

	const result = await db.ingestMessages(batch);

	// Ingest already maintained a `contact` for every sender above, so only the
	// outbound-only correspondents are left to add. `contact.email` is uniquely
	// indexed; tolerate a collision rather than failing the whole seed, so this
	// stays safe to re-run.
	const seeded = await Promise.allSettled(
		PEOPLE.map(([name, email, sent, received], i) =>
			db.create('contact', {
				email: email.toLowerCase(),
				name,
				send_count: sent,
				receive_count: received,
				last_interacted_at: now - i * 3_600_000,
				is_known_correspondent: sent > 0,
			}),
		),
	);

	return Response.json({
		account_id: account.id,
		contacts: seeded.filter((s) => s.status === 'fulfilled').length,
		...result,
	});
}
