import { describe, it, expect } from 'vitest';
import {
	computeThreadPatch,
	invertPatch,
	type ThreadStateForAction,
} from './actions';

const base: ThreadStateForAction = {
	folder: 'inbox',
	starred: false,
	unread_count: 2,
	message_count: 3,
	label_ids: [],
};

describe('computeThreadPatch', () => {
	it('archive moves to archive folder', () => {
		expect(computeThreadPatch('archive', base)).toMatchObject({
			folder: 'archive',
			provider_op: 'archive',
		});
	});

	it('trash moves to trash', () => {
		expect(computeThreadPatch('trash', base)).toMatchObject({
			folder: 'trash',
			provider_op: 'trash',
		});
	});

	it('delete forever moves to trash AND hard-deletes locally', () => {
		const p = computeThreadPatch('delete', base);
		expect(p.folder).toBe('trash');
		expect(p.hard_delete).toBe(true);
		expect(p.provider_op).toBe('delete_forever');
	});

	it('spam moves to spam', () => {
		expect(computeThreadPatch('spam', base).folder).toBe('spam');
	});

	it('read clears unread and marks messages read', () => {
		const p = computeThreadPatch('read', base);
		expect(p.unread_count).toBe(0);
		expect(p.mark_read).toBe(true);
		expect(p.folder).toBeUndefined();
	});

	it('unread restores unread count to at least message_count', () => {
		const p = computeThreadPatch('unread', { ...base, unread_count: 0 });
		expect(p.unread_count).toBe(3);
		expect(p.mark_unread).toBe(true);
	});

	it('star / unstar toggle the starred flag', () => {
		expect(computeThreadPatch('star', base).starred).toBe(true);
		expect(computeThreadPatch('unstar', { ...base, starred: true }).starred).toBe(false);
	});

	it('move honors the target folder', () => {
		expect(computeThreadPatch('move', base, { folder: 'spam' }).folder).toBe('spam');
	});

	it('label adds a label id without duplicating', () => {
		const p = computeThreadPatch('label', { ...base, label_ids: ['a'] }, { label_id: 'b' });
		expect(p.label_ids?.sort()).toEqual(['a', 'b']);
		const p2 = computeThreadPatch('label', { ...base, label_ids: ['a'] }, { label_id: 'a' });
		expect(p2.label_ids).toEqual(['a']);
	});
});

describe('invertPatch', () => {
	it('restores the previous folder for archive', () => {
		const before: ThreadStateForAction = { ...base, folder: 'inbox' };
		const patch = computeThreadPatch('archive', before);
		const inv = invertPatch(before, patch);
		expect(inv.folder).toBe('inbox');
	});

	it('swaps read/unread on undo', () => {
		const before: ThreadStateForAction = { ...base, unread_count: 2 };
		const patch = computeThreadPatch('read', before);
		const inv = invertPatch(before, patch);
		expect(inv.unread_count).toBe(2);
		expect(inv.mark_unread).toBe(true);
	});

	it('restores previous starred state', () => {
		const before: ThreadStateForAction = { ...base, starred: false };
		const patch = computeThreadPatch('star', before);
		const inv = invertPatch(before, patch);
		expect(inv.starred).toBe(false);
	});
});
