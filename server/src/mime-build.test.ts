import { describe, it, expect } from 'vitest';
import { buildMimeMessage } from './mime-build';

describe('buildMimeMessage', () => {
	it('produces raw MIME with the expected headers', () => {
		const { raw, message_id, references } = buildMimeMessage({
			from: { name: 'Brian', email: 'brian@example.com' },
			to: [{ email: 'sarah@x.com' }],
			cc: [{ email: 'bob@x.com' }],
			subject: 'Re: Plan',
			text: 'Hello there',
			html: '<p>Hello there</p>',
			in_reply_to: '<parent@x.com>',
			references: ['<root@x.com>'],
		});
		expect(raw).toContain('brian@example.com');
		expect(raw).toContain('sarah@x.com');
		expect(raw).toContain('bob@x.com');
		expect(raw).toContain('Subject:');
		expect(raw).toContain(Buffer.from('Re: Plan').toString('base64'));
		expect(raw).toContain('<parent@x.com>');
		expect(raw).toContain('<root@x.com>');
		expect(raw).toContain(message_id);
		expect(raw).toMatch(/text\/plain/);
		expect(raw).toMatch(/text\/html/);
		expect(references).toEqual(['<root@x.com>', '<parent@x.com>']);
	});

	it('uses a provided message id', () => {
		const { raw } = buildMimeMessage({
			from: { email: 'a@b.com' },
			to: [{ email: 'c@d.com' }],
			subject: 'Hi',
			text: 'yo',
			message_id: '<fixed@b.com>',
		});
		expect(raw).toContain('<fixed@b.com>');
	});
});
