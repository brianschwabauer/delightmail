import { describe, it, expect } from 'vitest';
import { buildMimeMessage, stripBccHeader } from './mime-build';

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

	it('strips the Bcc header for envelope-delivery transports (H1)', () => {
		const { raw } = buildMimeMessage({
			from: { email: 'a@b.com' },
			to: [{ email: 'c@d.com' }],
			bcc: [{ email: 'secret@x.com' }],
			subject: 'Hi',
			text: 'yo',
		});
		expect(raw).toMatch(/^Bcc:/im); // mimetext emits Bcc into the raw
		const stripped = stripBccHeader(raw);
		expect(stripped).not.toMatch(/^Bcc:/im);
		expect(stripped).not.toContain('secret@x.com');
		expect(stripped).toContain('c@d.com'); // other headers intact
		expect(stripped).toContain('yo'); // body intact
	});

	it('neutralizes CRLF header injection in user fields (H4)', () => {
		const { raw } = buildMimeMessage({
			from: { email: 'a@b.com' },
			to: [{ email: 'c@d.com' }],
			subject: 'Hi\r\nBcc: evil@x.com',
			in_reply_to: '<p@x.com>\r\nX-Injected: yes',
			text: 'yo',
		});
		expect(raw).not.toMatch(/^Bcc: evil@x\.com/im);
		expect(raw).not.toMatch(/^X-Injected:/im);
	});
});
