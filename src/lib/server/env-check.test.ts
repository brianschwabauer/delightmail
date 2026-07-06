import { describe, it, expect } from 'vitest';
import { checkEnv } from './env-check';

const HEX = '0'.repeat(64);

describe('checkEnv', () => {
	it('passes with a complete production config', () => {
		const r = checkEnv(
			{
				PUBLIC_APP_URL: 'https://mail.example.com',
				JWT_KEY_SECRET: HEX,
				CREDENTIALS_ENCRYPTION_KEY: HEX,
				OWNER_EMAIL: 'me@example.com',
				MAIL_FROM: 'mail@example.com',
			},
			{ dev: false },
		);
		expect(r.errors).toEqual([]);
	});

	it('flags a non-hex JWT secret', () => {
		const r = checkEnv(
			{ PUBLIC_APP_URL: 'x', JWT_KEY_SECRET: 'not-hex', CREDENTIALS_ENCRYPTION_KEY: HEX, OWNER_EMAIL: 'a@b.c', MAIL_FROM: 'm@x.c' },
			{ dev: false },
		);
		expect(r.errors.some((e) => e.includes('JWT_KEY_SECRET'))).toBe(true);
	});

	it('requires OWNER_EMAIL or open signups', () => {
		const r = checkEnv(
			{ PUBLIC_APP_URL: 'x', JWT_KEY_SECRET: HEX, CREDENTIALS_ENCRYPTION_KEY: HEX, MAIL_FROM: 'm@x.c' },
			{ dev: false },
		);
		expect(r.errors.some((e) => e.includes('OWNER_EMAIL'))).toBe(true);
	});

	it('detects enabled feature groups', () => {
		const r = checkEnv({
			GOOGLE_CLIENT_ID: 'x',
			GOOGLE_CLIENT_SECRET: 'y',
			AI_GATEWAY_NAME: 'gw',
			VAPID_PUBLIC_KEY: 'a',
			VAPID_PRIVATE_KEY: 'b',
		});
		expect(r.features.gmail).toBe(true);
		expect(r.features.ai_triage).toBe(true);
		expect(r.features.web_push).toBe(true);
		expect(r.features.smtp_relay).toBe(false);
	});

	it('is lenient in dev', () => {
		const r = checkEnv({}, { dev: true });
		expect(r.errors).toEqual([]);
	});

	it('errors when VAPID public key lacks its private key', () => {
		const r = checkEnv({ VAPID_PUBLIC_KEY: 'a' }, { dev: true });
		expect(r.errors.some((e) => e.includes('VAPID_PRIVATE_KEY'))).toBe(true);
	});
});
