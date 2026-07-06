/**
 * Transactional email delivery for magic links (§8 bootstrap).
 *
 * Priority: Cloudflare Email Service (env.EMAIL binding + MAIL_FROM) →
 * SMTP relay (SMTP_RELAY_* env) → dev console fallback (logs the link so a
 * fresh install can sign in before any mail provider is configured).
 *
 * This is the same transport layer used for user mail (§6); kept dependency-free
 * here so it can run in the app worker without pulling worker-only modules.
 */
export interface OutgoingEmail {
	to: string;
	from?: string;
	subject: string;
	html: string;
	text: string;
}

type EmailEnv = Partial<App.CloudflareEnv> & { EMAIL?: { send(msg: unknown): Promise<void> } };

export async function sendTransactionalEmail(
	env: EmailEnv | undefined,
	msg: OutgoingEmail,
	opts: { dev?: boolean } = {},
): Promise<void> {
	const from = msg.from ?? env?.MAIL_FROM;

	// 1. Cloudflare Email Service (added in P4 as the EMAIL binding).
	if (env?.EMAIL && from) {
		const mime = buildSimpleMime({ ...msg, from });
		try {
			// EmailMessage is provided by the `cloudflare:email` module at runtime;
			// imported dynamically (untyped) so this file stays node/test importable.
			const mod: any = await import(/* @vite-ignore */ 'cloudflare:email').catch(() => null);
			if (mod?.EmailMessage) {
				await env.EMAIL.send(new mod.EmailMessage(from, msg.to, mime));
				return;
			}
		} catch (err) {
			console.error('[email] Cloudflare Email Service send failed, falling back:', err);
		}
	}

	// 2. SMTP relay.
	if (env?.SMTP_RELAY_HOST && from) {
		await sendViaSmtp(env, { ...msg, from });
		return;
	}

	// 3. Dev fallback — surface the link so sign-in works with zero config.
	if (opts.dev) {
		const link = msg.text.match(/https?:\/\/\S+/)?.[0];
		console.log(
			`\n📧 [dev] Email to ${msg.to}: ${msg.subject}` + (link ? `\n   → ${link}\n` : `\n`),
		);
		return;
	}

	throw new Error(
		'No email transport configured. Set MAIL_FROM + the EMAIL binding, or SMTP_RELAY_* env vars.',
	);
}

/** Minimal RFC-822 builder for a multipart/alternative message. */
function buildSimpleMime(msg: OutgoingEmail & { from: string }): string {
	const boundary = `dm_${Math.abs(hashString(msg.subject + msg.to)).toString(36)}`;
	return [
		`From: ${msg.from}`,
		`To: ${msg.to}`,
		`Subject: ${msg.subject}`,
		'MIME-Version: 1.0',
		`Content-Type: multipart/alternative; boundary="${boundary}"`,
		'',
		`--${boundary}`,
		'Content-Type: text/plain; charset=utf-8',
		'',
		msg.text,
		`--${boundary}`,
		'Content-Type: text/html; charset=utf-8',
		'',
		msg.html,
		`--${boundary}--`,
		'',
	].join('\r\n');
}

async function sendViaSmtp(
	env: EmailEnv,
	msg: OutgoingEmail & { from: string },
): Promise<void> {
	const mod: any = await import(/* @vite-ignore */ 'worker-mailer').catch(() => null);
	const WorkerMailer = mod?.WorkerMailer;
	if (!WorkerMailer) throw new Error('worker-mailer not available for SMTP relay');
	const mailer = await WorkerMailer.connect({
		host: env.SMTP_RELAY_HOST!,
		port: Number(env.SMTP_RELAY_PORT ?? 587),
		secure: Number(env.SMTP_RELAY_PORT) === 465,
		startTls: Number(env.SMTP_RELAY_PORT ?? 587) !== 465,
		credentials:
			env.SMTP_RELAY_USER && env.SMTP_RELAY_PASS
				? { username: env.SMTP_RELAY_USER, password: env.SMTP_RELAY_PASS }
				: undefined,
		authType: 'plain',
	});
	await mailer.send({
		from: msg.from,
		to: msg.to,
		subject: msg.subject,
		text: msg.text,
		html: msg.html,
	});
	await mailer.close();
}

function hashString(s: string): number {
	let h = 0;
	for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
	return h;
}
