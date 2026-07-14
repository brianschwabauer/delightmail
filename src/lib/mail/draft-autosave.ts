/**
 * Serialized compose-draft autosave. Guarantees at most one save is ever in
 * flight, so a *create* finishes (and yields its draft id) before the next save
 * runs. Without that, fast typing during an in-flight create issues a second
 * create — two draft rows, one orphaned. On send, `discardAfterSend()` stops
 * autosaving and waits for any in-flight save before deleting, so a racing save
 * can't re-create an orphan after the delete.
 *
 * Framework-free and injected with `save`/`remove` so it is unit-testable; the
 * Svelte component wires it to `/api/drafts`.
 */
export interface DraftAutosaverOptions {
	/** Current content signature; an unchanged signature skips the save. */
	signature: () => string;
	/** Whether there is enough content to be worth persisting. */
	hasContent: () => boolean;
	/** Persist the draft. `id` is undefined for a create; returns the draft id. */
	save: (id: string | undefined) => Promise<string>;
	/** Delete the draft by id (best-effort). */
	remove: (id: string) => Promise<void>;
}

export class DraftAutosaver {
	#opts: DraftAutosaverOptions;
	#draftId: string | undefined;
	#lastSig = '';
	#inFlight: Promise<void> | null = null;
	#stopped = false;

	constructor(opts: DraftAutosaverOptions, initialDraftId?: string) {
		this.#opts = opts;
		this.#draftId = initialDraftId;
	}

	/** The draft id once a save has produced one (undefined until then). */
	get draftId(): string | undefined {
		return this.#draftId;
	}

	/** True while a save is in flight (exposed for tests / callers that care). */
	get saving(): boolean {
		return this.#inFlight !== null;
	}

	/**
	 * Idle-tick entry point. Serialized: if a save is already in flight, or the
	 * content is unchanged/empty, this is a no-op.
	 */
	async tick(): Promise<void> {
		if (this.#stopped || this.#inFlight || !this.#opts.hasContent()) return;
		const sig = this.#opts.signature();
		if (sig === this.#lastSig) return;
		this.#inFlight = this.#run(sig);
		try {
			await this.#inFlight;
		} finally {
			this.#inFlight = null;
		}
	}

	async #run(sig: string): Promise<void> {
		if (this.#stopped) return;
		try {
			this.#draftId = await this.#opts.save(this.#draftId);
			// Only record the signature as saved once the server confirms, so a
			// failed save naturally retries on the next tick.
			this.#lastSig = sig;
		} catch {
			/* transient — retry next tick (signature left unchanged) */
		}
	}

	/**
	 * The sent message supersedes the draft. Stop autosaving, wait for any
	 * in-flight save to settle (so `draftId` is known and no save lands after the
	 * delete), then delete the draft. Safe to call fire-and-forget.
	 */
	async discardAfterSend(): Promise<void> {
		this.#stopped = true;
		if (this.#inFlight) {
			try {
				await this.#inFlight;
			} catch {
				/* ignore */
			}
		}
		if (this.#draftId) {
			try {
				await this.#opts.remove(this.#draftId);
			} catch {
				/* best-effort */
			}
		}
	}
}
