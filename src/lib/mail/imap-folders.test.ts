import { describe, it, expect } from 'vitest';
import { imapToLocalFolder } from './imap-folders';

describe('imapToLocalFolder', () => {
	it('maps by special-use flag first', () => {
		expect(imapToLocalFolder('Sent Items', '\\Sent')).toBe('sent');
		expect(imapToLocalFolder('Bin', '\\Trash')).toBe('trash');
		expect(imapToLocalFolder('Junk E-mail', '\\Junk')).toBe('spam');
		expect(imapToLocalFolder('All Mail', '\\All')).toBe('archive');
	});
	it('maps INBOX', () => {
		expect(imapToLocalFolder('INBOX')).toBe('inbox');
	});
	it('maps common folder names without special-use', () => {
		expect(imapToLocalFolder('Sent')).toBe('sent');
		expect(imapToLocalFolder('Trash')).toBe('trash');
		expect(imapToLocalFolder('Deleted Items')).toBe('trash');
		expect(imapToLocalFolder('Spam')).toBe('spam');
		expect(imapToLocalFolder('Archive')).toBe('archive');
	});
	it('returns null for arbitrary folders (become labels)', () => {
		expect(imapToLocalFolder('Work/Projects')).toBeNull();
		expect(imapToLocalFolder('Receipts')).toBeNull();
	});
});
