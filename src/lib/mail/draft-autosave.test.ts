import { describe, it, expect } from 'vitest';
import { DraftAutosaver } from './draft-autosave';

function deferred<T>() {
	let resolve!: (v: T) => void;
	let reject!: (e: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

describe('DraftAutosaver', () => {
	it('does not start a second save while one is in flight (no duplicate drafts)', async () => {
		const idsSeen: Array<string | undefined> = [];
		const gates: Array<ReturnType<typeof deferred<void>>> = [];
		let sig = 0;
		let calls = 0;
		const saver = new DraftAutosaver({
			signature: () => `sig-${sig}`,
			hasContent: () => true,
			save: async (id) => {
				idsSeen.push(id);
				const g = deferred<void>();
				gates.push(g);
				calls++;
				await g.promise;
				return id ?? 'draft-1';
			},
			remove: async () => {},
		});

		sig = 1;
		const t1 = saver.tick(); // starts create #1
		sig = 2;
		const t2 = saver.tick(); // in flight → must NOT start a 2nd create
		expect(calls).toBe(1);

		gates[0].resolve();
		await Promise.all([t1, t2]);
		expect(saver.draftId).toBe('draft-1');
		expect(calls).toBe(1);

		// A later tick with changed content updates the SAME draft in place.
		sig = 3;
		const t3 = saver.tick();
		gates[1].resolve();
		await t3;
		expect(calls).toBe(2);
		expect(idsSeen).toEqual([undefined, 'draft-1']);
	});

	it('skips saving when the signature is unchanged', async () => {
		let calls = 0;
		const saver = new DraftAutosaver({
			signature: () => 'same',
			hasContent: () => true,
			save: async () => {
				calls++;
				return 'd';
			},
			remove: async () => {},
		});
		await saver.tick(); // saves
		await saver.tick(); // unchanged → skip
		expect(calls).toBe(1);
	});

	it('does not save when there is no content', async () => {
		let calls = 0;
		const saver = new DraftAutosaver({
			signature: () => 'x',
			hasContent: () => false,
			save: async () => {
				calls++;
				return 'd';
			},
			remove: async () => {},
		});
		await saver.tick();
		expect(calls).toBe(0);
	});

	it('discardAfterSend waits for the in-flight save, then deletes that draft', async () => {
		const removed: string[] = [];
		const g = deferred<void>();
		const saver = new DraftAutosaver({
			signature: () => 'x',
			hasContent: () => true,
			save: async () => {
				await g.promise;
				return 'draft-9';
			},
			remove: async (id) => {
				removed.push(id);
			},
		});

		const t = saver.tick(); // create in flight, draftId not set yet
		const d = saver.discardAfterSend(); // must wait for the save first
		expect(removed).toEqual([]);

		g.resolve();
		await Promise.all([t, d]);
		expect(saver.draftId).toBe('draft-9');
		expect(removed).toEqual(['draft-9']); // deleted exactly the id the save produced
	});

	it('stops autosaving after discardAfterSend', async () => {
		let calls = 0;
		const saver = new DraftAutosaver({
			signature: () => `s${calls}`,
			hasContent: () => true,
			save: async () => {
				calls++;
				return 'd';
			},
			remove: async () => {},
		});
		await saver.discardAfterSend();
		await saver.tick();
		expect(calls).toBe(0);
	});

	it('retries after a failed save (signature not marked saved)', async () => {
		let calls = 0;
		const saver = new DraftAutosaver({
			signature: () => 'x',
			hasContent: () => true,
			save: async () => {
				calls++;
				if (calls === 1) throw new Error('network');
				return 'd';
			},
			remove: async () => {},
		});
		await saver.tick(); // fails
		expect(saver.draftId).toBeUndefined();
		await saver.tick(); // same signature, but last save failed → retries
		expect(calls).toBe(2);
		expect(saver.draftId).toBe('d');
	});

	it('flush saves pending changes immediately, after any in-flight save', async () => {
		const idsSeen: Array<[string | undefined, boolean]> = [];
		const gate = deferred<void>();
		let sig = 1;
		let calls = 0;
		const saver = new DraftAutosaver({
			signature: () => `sig-${sig}`,
			hasContent: () => true,
			save: async (id, final) => {
				idsSeen.push([id, final]);
				calls++;
				if (calls === 1) await gate.promise;
				return id ?? 'draft-1';
			},
			remove: async () => {},
		});
		const t1 = saver.tick(); // create in flight
		sig = 2; // more typing, then the user closes the composer
		const f = saver.flush();
		expect(calls).toBe(1); // must wait for the create to yield its id
		gate.resolve();
		await Promise.all([t1, f]);
		expect(calls).toBe(2);
		expect(idsSeen).toEqual([
			[undefined, false],
			['draft-1', true],
		]);
		// Nothing new → flush is a no-op.
		await saver.flush();
		expect(calls).toBe(2);
	});

	it('flush is a no-op after discardAfterSend and when there is no content', async () => {
		let calls = 0;
		let content = false;
		const saver = new DraftAutosaver({
			signature: () => 'x',
			hasContent: () => content,
			save: async (id) => {
				calls++;
				return id ?? 'd';
			},
			remove: async () => {},
		});
		await saver.flush();
		expect(calls).toBe(0);
		content = true;
		await saver.discardAfterSend();
		await saver.flush();
		expect(calls).toBe(0);
	});
});
