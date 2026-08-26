<script lang="ts">
	import { tick, onMount } from "svelte";
	import { Editor as EditorClass, defaultBlocks } from "@delightstack/editor";
	// The package's generated Editor.svelte.d.ts has an internal name collision
	// (component `Editor` vs the core `Editor` type it imports), so the named
	// re-export resolves type-only under verbatimModuleSyntax. A namespace import
	// is unambiguously a value import; pull the component off it.
	import * as EditorComponents from "@delightstack/editor/components";
	// The same .d.ts collision types the value as the editor INSTANCE, not the
	// component, so cast it back to a Svelte component that takes `editor`.
	const EditorView =
		EditorComponents.Editor as unknown as import("svelte").Component<{
			editor: EditorClass;
		}>;
	import {
		Avatar,
		Button,
		Expand,
		Input,
		List,
		ListItem,
		Modal,
		toast,
	} from "@delightstack/components";
	import type { InputOption } from "@delightstack/components";
	import Icon from "./Icon.svelte";
	import type { MailDatabaseClient } from "$lib/clients";
	import type { Address, Identity } from "$lib/schema";
	import { verifiedAvatarUrl } from "$lib/mail/avatar.svelte";
	import { mergeSignatureDoc, docToText } from "$lib/mail/compose";
	import { DraftAutosaver } from "$lib/mail/draft-autosave";

	export interface ComposeInit {
		to?: Address[];
		cc?: Address[];
		bcc?: Address[];
		subject?: string;
		bodyDoc?: unknown;
		identity_id?: string;
		in_reply_to?: string;
		references?: string[];
		thread_id?: string;
		/** Set when editing an existing draft so autosave updates it in place. */
		draft_id?: string;
	}

	interface Props {
		db: MailDatabaseClient;
		init: ComposeInit;
		onClose: () => void;
	}
	const { db, init, onClose }: Props = $props();

	// The Modal is open for the lifetime of this component (it only mounts while a
	// draft is being composed). Closing it — Escape, backdrop, or the ✕ — resolves
	// through `onClose`, which unmounts us. Escape is owned by the Modal alone, so
	// it can no longer leak past compose to close the mail you were reading.
	let open = $state(true);

	const MAX_TOTAL_BYTES = 25 * 1024 * 1024;

	interface Attachment {
		id: string;
		filename: string;
		size: number;
		mime_type: string;
		r2_key: string;
		uploading: boolean;
	}

	const identities = db.list("identity", { limit: 50 });

	let identityId = $state(init.identity_id ?? "");
	let showCc = $state((init.cc?.length ?? 0) > 0);
	let showBcc = $state((init.bcc?.length ?? 0) > 0);
	// Recipients are held as the delightstack <Input multiple> value: a string[]
	// of chips. Each chip is the email address (a picked contact stores its email;
	// a typed "Name <email>" is kept verbatim) — both round-trip back to an
	// Address via parseAddress. Display names for picked/known contacts live in
	// `nameByEmail` so the sent message still carries them (chips show the email).
	let to = $state<string[]>(initChips(init.to));
	let cc = $state<string[]>(initChips(init.cc));
	let bcc = $state<string[]>(initChips(init.bcc));
	let subject = $state(init.subject ?? "");
	let sending = $state(false);
	let attachments = $state<Attachment[]>([]);
	let fileInput = $state<HTMLInputElement>();
	let overlayEl = $state<HTMLElement>();

	// email → display name, so a chip (which shows only the email) can still be
	// reconstituted into a named Address at send time. Primed from any incoming
	// draft and topped up as autocomplete options stream in. Plain map (a lookup
	// cache, not reactive UI state).
	const nameByEmail = new Map<string, string>();
	for (const a of [
		...(init.to ?? []),
		...(init.cc ?? []),
		...(init.bcc ?? []),
	]) {
		if (a.email && a.name) nameByEmail.set(a.email.toLowerCase(), a.name);
	}

	const editor = new EditorClass({
		placeholder: "Write your message…",
		blocks: defaultBlocks(),
		content: (init.bodyDoc as never) ?? undefined,
	});

	const fromIdentity = $derived(
		(identities.items as Identity[]).find((i) => String(i.id) === identityId) ??
			(identities.items[0] as Identity | undefined),
	);

	// The uncommitted text sitting in each recipient field. It lives inside the
	// <Input>, which doesn't expose it — but its `input` events bubble, so we
	// mirror them here (see onFieldInput). That lets Send light up for an address
	// that's fully typed but not yet a chip.
	const drafts = $state({ to: "", cc: "", bcc: "" });
	const typedTo = $derived.by(() => {
		const a = parseAddress(drafts.to);
		return a?.email && isSendableEmail(a.email) ? a : null;
	});

	// The Send button is enabled only when the message can actually go out: a
	// recipient (chipped, or typed and complete — send() commits it), a sending
	// identity, and no attachment mid-upload.
	const canSend = $derived(
		!sending &&
			!!fromIdentity &&
			(to.length > 0 || !!typedTo) &&
			!attachments.some((a) => a.uploading),
	);

	// --- draft autosave. Saves are driven by CHANGES (a short idle debounce after
	// the last edit), and forced on every way out of the composer — Escape / ✕,
	// the tab hiding or unloading — so a long message can't be lost between
	// timer ticks. The saver serializes saves, so fast typing during an in-flight
	// create can't spawn a second create (duplicate/orphan drafts). ---
	let sent = $state(false);
	const SAVE_IDLE_MS = 1200;
	const SAVE_MAX_WAIT_MS = 5000;

	// Once the composer is closing the editor is about to be destroyed, so the
	// final save reads from this snapshot instead of the live doc.
	let frozen_doc: unknown = null;
	function currentDoc(): unknown {
		return frozen_doc ?? editor.doc;
	}
	function currentSig(): string {
		return JSON.stringify({ s: subject, t: to, c: cc, d: currentDoc() });
	}
	function hasContent(): boolean {
		return !!(subject.trim() || to.length || docToText(currentDoc()).trim());
	}

	const saver = new DraftAutosaver(
		{
			signature: currentSig,
			hasContent,
			save: async (id, final) => {
				if (!fromIdentity) throw new Error("no identity to save under");
				const res = await fetch("/api/drafts", {
					method: "POST",
					headers: { "content-type": "application/json" },
					// keepalive lets the last save outlive a closing tab.
					keepalive: final,
					body: JSON.stringify({
						draft_id: id,
						identity_id: fromIdentity.id,
						to: toAddresses(to),
						cc: showCc ? toAddresses(cc) : [],
						subject,
						doc: currentDoc(),
					}),
				});
				if (!res.ok) throw new Error("draft save failed");
				return ((await res.json()) as { draft_id: string }).draft_id;
			},
			remove: async (id) => {
				await fetch(`/api/drafts/${encodeURIComponent(id)}`, {
					method: "DELETE",
				});
			},
		},
		init.draft_id,
	);

	onMount(() => {
		if (!identityId && identities.items.length) {
			identityId = String((identities.items[0] as Identity).id);
		}
		// Land the cursor in the first empty recipient field the moment compose
		// opens — and, because focus is now inside the overlay, Esc reaches the
		// overlay's own handler (fixing "n then Esc doesn't close it").
		void tick().then(() => {
			overlayEl?.querySelector<HTMLInputElement>("#to")?.focus();
		});
		// The tab going away is a way out of the composer too — flush the draft
		// (the request is keepalive, so it survives the unload).
		const onHidden = () => {
			if (document.visibilityState === "hidden") void saver.flush();
		};
		window.addEventListener("pagehide", flushDraft);
		document.addEventListener("visibilitychange", onHidden);
		return () => {
			window.removeEventListener("pagehide", flushDraft);
			document.removeEventListener("visibilitychange", onHidden);
			clearTimeout(idle_timer);
			clearTimeout(max_wait_timer);
			editor.destroy();
		};
	});

	// Change-driven autosave: each edit restarts a short idle timer; a longer
	// max-wait timer guarantees a save lands during continuous typing. Reading
	// `currentSig()` inside the effect subscribes it to every input the draft
	// depends on (editor.doc is reactive).
	let idle_timer: ReturnType<typeof setTimeout> | undefined;
	let max_wait_timer: ReturnType<typeof setTimeout> | undefined;
	let last_seen_sig = currentSig();
	function saveSoon(): void {
		clearTimeout(idle_timer);
		clearTimeout(max_wait_timer);
		idle_timer = undefined;
		max_wait_timer = undefined;
		if (sent || sending || !fromIdentity) return;
		void saver.tick();
	}
	$effect(() => {
		const sig = currentSig();
		if (sig === last_seen_sig) return;
		last_seen_sig = sig;
		clearTimeout(idle_timer);
		idle_timer = setTimeout(saveSoon, SAVE_IDLE_MS);
		if (!max_wait_timer)
			max_wait_timer = setTimeout(saveSoon, SAVE_MAX_WAIT_MS);
	});
	// A save that failed (offline, server hiccup) keeps its signature unsaved —
	// retry on a slow cadence so it isn't stuck until the next keystroke.
	$effect(() => {
		const retry = setInterval(() => {
			if (sent || sending || !fromIdentity) return;
			void saver.tick();
		}, 15000);
		return () => clearInterval(retry);
	});

	function flushDraft(): void {
		if (sent || sending) return;
		void saver.flush();
	}
	/** Every way out of the composer (Escape, backdrop, ✕) lands here: snapshot
	 *  the doc, persist it, then unmount. */
	function close(): void {
		clearTimeout(idle_timer);
		clearTimeout(max_wait_timer);
		if (!sent && !sending) {
			frozen_doc = editor.doc;
			void saver.flush();
		}
		onClose();
	}

	// Signature preview: shown below the body, swapped when the identity
	// changes, and merged into the doc at send time without touching what's written.
	const signatureDoc = $derived.by(() => {
		const raw = fromIdentity?.signature_doc;
		if (!raw) return null;
		try {
			return JSON.parse(raw) as { type: string; content?: unknown[] };
		} catch {
			return null;
		}
	});
	const signaturePreview = $derived(
		signatureDoc ? docToText(signatureDoc) : "",
	);

	function parseAddress(raw: string): Address | null {
		const trimmed = raw.trim().replace(/[,;]+$/, "");
		if (!trimmed) return null;
		const m = trimmed.match(/^(.*)<(.+@.+)>$/);
		if (m) return { name: m[1].trim() || undefined, email: m[2].trim() };
		if (/^[^@\s]+@[^@\s]+$/.test(trimmed)) return { email: trimmed };
		return null;
	}
	// Deliberately stricter than parseAddress (which also accepts intranet-style
	// `user@host`): this gates the two places we commit an address the user never
	// explicitly picked — Enter and blur — so half-typed text can't become a chip.
	function isSendableEmail(email: string): boolean {
		return /^[^\s@<>,;]+@[^\s@<>,;.]+(\.[^\s@<>,;.]+)+$/.test(email);
	}
	// Address[] (from init/draft) → chip strings for <Input multiple>. We store the
	// bare email as the chip and stash the name in `nameByEmail` for send time.
	function initChips(list?: Address[]): string[] {
		return (list ?? []).map((a) => a.email).filter((e): e is string => !!e);
	}
	// Chip strings → deduped, named Address[] for the draft/send payloads.
	function toAddresses(chips: string[]): Address[] {
		const out: Address[] = [];
		const seen = new Set<string>();
		for (const chip of chips) {
			const a = parseAddress(chip);
			if (!a?.email) continue;
			const key = a.email.toLowerCase();
			if (seen.has(key)) continue;
			seen.add(key);
			out.push({ email: a.email, name: a.name ?? nameByEmail.get(key) });
		}
		return out;
	}

	// <Input onfilter> — one-shot contact search feeding the autocomplete panel.
	// Ranks known correspondents first (send_count), drops anyone already added
	// across To/Cc/Bcc, and records each name so the chip's email can be re-named
	// at send. label === the email so the picked chip is the address itself.
	//
	// An empty query (the field just focused, or the panel refreshing after a
	// pick) suggests five people instead of "No results": a blend of who you
	// write to MOST (top send_count) and who you wrote to LATEST
	// (last_interacted_at) — see suggestRecipients — so the usual names are
	// Enter/Enter/Enter away.
	//
	// When the query is itself a complete address, it leads the list: the <Input>
	// parks its highlight on the first row, so writing to someone who isn't a
	// contact yet is the same Enter-to-commit flow as writing to someone who is.
	type ContactHit = { email?: string; name?: string; send_count?: number };
	const SUGGESTIONS = 5;
	/** A search (`term`) answers with scored `hits`; a plain ordered list with
	 *  `items`. Read whichever came back. */
	function contactDocs(res: { hits?: Array<{ document?: unknown }>; items?: unknown[] }): ContactHit[] {
		if (res.hits) return res.hits.map((h) => h.document as ContactHit);
		return (res.items ?? []) as ContactHit[];
	}

	/** Two lists, blended by rank: the all-time top recipients and the most
	 *  recent ones each contribute their position (1..5; absent = 6), lowest
	 *  sum wins, and a tie goes to the more recent. Someone you mail weekly and
	 *  mailed yesterday tops both lists; a one-off from this morning and an old
	 *  regular still both make the cut. Only contacts you've actually written to
	 *  count — a sender you've never replied to isn't a recipient suggestion. */
	async function suggestRecipients(usable: (c: ContactHit) => boolean): Promise<ContactHit[]> {
		const list = (field: "send_count" | "last_interacted_at") =>
			db
				.list("contact", { limit: SUGGESTIONS * 3, order: [{ field, direction: "DESC" }] })
				.load()
				.then((res) =>
					contactDocs(res)
						.filter((c) => usable(c) && (c.send_count ?? 0) > 0)
						.slice(0, SUGGESTIONS),
				)
				.catch((err): ContactHit[] => {
					console.warn("[compose] recipient suggestions failed:", err);
					return [];
				});
		const [top, recent] = await Promise.all([list("send_count"), list("last_interacted_at")]);
		const score = new Map<string, { c: ContactHit; sum: number; recent: number }>();
		const absent = SUGGESTIONS + 1;
		for (const c of [...top, ...recent]) {
			const key = c.email!.toLowerCase();
			if (score.has(key)) continue;
			const t = top.findIndex((x) => x.email!.toLowerCase() === key);
			const r = recent.findIndex((x) => x.email!.toLowerCase() === key);
			const tr = t < 0 ? absent : t + 1;
			const rr = r < 0 ? absent : r + 1;
			score.set(key, { c, sum: tr + rr, recent: rr });
		}
		const blended = [...score.values()]
			.sort((a, b) => a.sum - b.sum || a.recent - b.recent)
			.slice(0, SUGGESTIONS)
			.map((s) => s.c);
		if (blended.length) return blended;
		// Nothing sent yet (a fresh account): fall back to whoever you've heard
		// from most recently rather than an empty panel.
		return db
			.list("contact", {
				limit: SUGGESTIONS * 2,
				order: [{ field: "last_interacted_at", direction: "DESC" }],
			})
			.load()
			.then((res) =>
				contactDocs(res)
					.filter(usable)
					.slice(0, SUGGESTIONS),
			)
			.catch((err): ContactHit[] => {
					console.warn("[compose] recipient suggestions failed:", err);
					return [];
				});
	}
	async function contactOptions(query: string): Promise<InputOption[]> {
		const term = query.trim();
		const chosen = new Set(
			[...to, ...cc, ...bcc].map((c) =>
				(parseAddress(c)?.email ?? c).toLowerCase(),
			),
		);
		const typed = parseAddress(term);
		const typedEmail =
			typed?.email &&
			isSendableEmail(typed.email) &&
			!chosen.has(typed.email.toLowerCase())
				? typed.email
				: null;
		if (typedEmail && typed?.name)
			nameByEmail.set(typedEmail.toLowerCase(), typed.name);

		const usable = (c: ContactHit) =>
			!!c.email && !chosen.has(c.email.toLowerCase());
		const toOption = (c: ContactHit): InputOption => {
			const email = c.email!.toLowerCase();
			if (c.name) nameByEmail.set(email, c.name);
			return { value: email, label: email, description: c.name };
		};

		if (!term) return (await suggestRecipients(usable)).map(toOption);

		const res = await db.list("contact", { term, limit: 8 }).load();
		const contacts = contactDocs(res)
			.filter(usable)
			.sort((a, b) => (b.send_count ?? 0) - (a.send_count ?? 0))
			.map(toOption);

		if (!typedEmail) return contacts.slice(0, 6);
		// The typed address may also be a known contact — show it once, at the top,
		// keeping the contact's name (the panel keys rows by `value`, so a duplicate
		// would collide).
		const key = typedEmail.toLowerCase();
		const known = contacts.find((c) => c.value === key);
		return [
			{
				value: key,
				label: typedEmail,
				description: known?.description ?? nameByEmail.get(key),
			},
			...contacts.filter((c) => c.value !== key).slice(0, 5),
		];
	}

	// --- committing a typed (unpicked) address ---
	// The <Input> only turns text into a chip when you pick a suggestion (or type a
	// comma); Enter always takes the highlighted suggestion, and its filter is
	// debounced, so the panel can be a keystroke behind what you actually typed.
	// Left alone, a complete address you typed and never "picked" is silently
	// dropped at send. So compose commits it itself, on Enter and on blur.
	type Field = "to" | "cc" | "bcc";
	function chipsOf(field: Field): string[] {
		return field === "to" ? to : field === "cc" ? cc : bcc;
	}
	function setChips(field: Field, next: string[]): void {
		if (field === "to") to = next;
		else if (field === "cc") cc = next;
		else bcc = next;
	}
	/** The recipient field an event came from, or null if it came from anywhere else. */
	function recipientField(target: EventTarget | null): Field | null {
		const id = (target as HTMLElement | null)?.id;
		return id === "to" || id === "cc" || id === "bcc" ? id : null;
	}
	/** The <Input> opens its panel on focus but only asks `onfilter` for options
	 *  on an `input` event — so a freshly focused, empty field shows "No results".
	 *  Nudge it with a synthetic input so the empty query runs and the panel
	 *  opens on the recipient suggestions instead. */
	function onFieldFocus(e: FocusEvent): void {
		const field = recipientField(e.target);
		if (!field) return;
		const el = e.target as HTMLInputElement;
		if (el.value === "") el.dispatchEvent(new Event("input", { bubbles: true }));
	}
	/** Mirror each recipient field's draft text into `drafts` (the events bubble
	 *  up to `.compose`; the subject input isn't a recipient field, so it's ignored). */
	function onFieldInput(e: Event): void {
		const field = recipientField(e.target);
		if (field) drafts[field] = (e.target as HTMLInputElement).value;
	}
	/** Re-read a field's draft text from the DOM. Picking a suggestion clears the
	 *  <Input>'s text without firing `input`, so typing alone doesn't keep `drafts`
	 *  honest — chip changes have to resync it, after Svelte has flushed the clear. */
	function syncDraft(field: Field): void {
		void tick().then(() => {
			drafts[field] =
				overlayEl?.querySelector<HTMLInputElement>(`#${field}`)?.value ?? "";
		});
	}
	/** Commit the field's uncommitted text as a chip if it's a real address.
	 *  Returns whether it did — Enter uses that to decide who owns the keystroke. */
	function commitTypedAddress(field: Field): boolean {
		const el = overlayEl?.querySelector<HTMLInputElement>(`#${field}`);
		const addr = parseAddress(el?.value ?? "");
		if (!addr?.email || !isSendableEmail(addr.email)) return false;
		const key = addr.email.toLowerCase();
		if (addr.name) nameByEmail.set(key, addr.name);
		const chips = chipsOf(field);
		if (
			!chips.some((c) => (parseAddress(c)?.email ?? c).toLowerCase() === key)
		) {
			setChips(field, [...chips, addr.email]);
		}
		// The draft text lives in the <Input>'s own state, which we can't reach — so
		// clear it the way the user would, by emptying the field and letting the
		// component's `oninput` handler see it (this also refreshes its panel).
		if (el) {
			el.value = "";
			el.dispatchEvent(new Event("input", { bubbles: true }));
		}
		return true;
	}

	function cycleIdentity(): void {
		const list = identities.items as Identity[];
		if (list.length < 2) return;
		const idx = list.findIndex((i) => String(i.id) === identityId);
		identityId = String(list[(idx + 1) % list.length].id);
	}

	// --- attachments ---
	function totalBytes(): number {
		return attachments.reduce((n, a) => n + a.size, 0);
	}
	async function addFiles(files: FileList | File[]): Promise<void> {
		for (const file of Array.from(files)) {
			if (totalBytes() + file.size > MAX_TOTAL_BYTES) {
				toast("Attachments exceed the 25 MB limit.");
				continue;
			}
			const id = crypto.randomUUID();
			attachments = [
				...attachments,
				{
					id,
					filename: file.name,
					size: file.size,
					mime_type: file.type || "application/octet-stream",
					r2_key: "",
					uploading: true,
				},
			];
			try {
				const form = new FormData();
				form.set("file", file);
				const res = await fetch("/api/attachments/upload", {
					method: "POST",
					body: form,
				});
				if (!res.ok) {
					const b = (await res.json().catch(() => ({}))) as {
						message?: string;
					};
					throw new Error(b.message || "Upload failed");
				}
				const j = (await res.json()) as { r2_key: string };
				attachments = attachments.map((a) =>
					a.id === id ? { ...a, r2_key: j.r2_key, uploading: false } : a,
				);
			} catch (e) {
				attachments = attachments.filter((a) => a.id !== id);
				toast((e as Error).message);
			}
		}
	}
	function onFilePicked(e: Event): void {
		const input = e.target as HTMLInputElement;
		if (input.files?.length) void addFiles(input.files);
		input.value = "";
	}
	function onDrop(e: DragEvent): void {
		e.preventDefault();
		if (e.dataTransfer?.files?.length) void addFiles(e.dataTransfer.files);
	}
	function removeAttachment(id: string): void {
		attachments = attachments.filter((a) => a.id !== id);
	}
	function fmtSize(n: number): string {
		return n < 1024
			? `${n} B`
			: n < 1024 * 1024
				? `${Math.round(n / 1024)} KB`
				: `${(n / 1024 / 1024).toFixed(1)} MB`;
	}

	async function send(): Promise<void> {
		// A recipient can still be sitting in a field as text — typed, complete, and
		// never picked (clicking Send from a disabled state fires no blur). Commit
		// those first so the message goes to who it looks like it's going to.
		for (const f of ["to", "cc", "bcc"] as Field[]) commitTypedAddress(f);
		const toList = toAddresses(to);
		const ccList = showCc ? toAddresses(cc) : [];
		const bccList = showBcc ? toAddresses(bcc) : [];
		if (!toList.length) {
			toast("Add at least one recipient.");
			return;
		}
		if (!fromIdentity) {
			toast("No identity to send from. Connect an account first.");
			return;
		}
		if (attachments.some((a) => a.uploading)) {
			toast("Wait for attachments to finish uploading.");
			return;
		}
		sending = true;
		try {
			// Merge the identity's signature into the doc at send (WYSIWYG-neutral).
			const doc = mergeSignatureDoc(editor.doc, signatureDoc);
			const res = await fetch("/api/send", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					identity_id: fromIdentity.id,
					to: toList,
					cc: ccList,
					bcc: bccList,
					subject,
					doc,
					in_reply_to: init.in_reply_to,
					references: init.references,
					thread_id: init.thread_id,
					attachments: attachments
						.filter((a) => a.r2_key)
						.map((a) => ({
							r2_key: a.r2_key,
							filename: a.filename,
							mime_type: a.mime_type,
							size: a.size,
						})),
				}),
			});
			if (!res.ok) {
				const err = (await res.json().catch(() => ({}))) as {
					message?: string;
				};
				throw new Error(err.message || `Send failed (${res.status})`);
			}
			const { message_id } = (await res.json().catch(() => ({}))) as {
				message_id?: string;
			};
			// The sent message supersedes the draft — stop autosaving and drop it,
			// waiting for any in-flight save first so it can't re-create an orphan.
			sent = true;
			void saver.discardAfterSend();

			// A REAL undo button for the whole undo window (the server holds the
			// message in the outbox until it expires). The toast lives exactly as
			// long as undo is possible, so its presence == "you can still stop it".
			const undoSeconds = await undoWindowSeconds();
			if (message_id) {
				toast("Sent.", {
					duration: undoSeconds * 1000,
					action: {
						label: "Undo",
						onclick: () => void undoSend(message_id),
					},
				});
			} else {
				toast("Sent.");
			}
			onClose();
		} catch (e) {
			toast((e as Error).message);
		} finally {
			sending = false;
		}
	}

	async function undoWindowSeconds(): Promise<number> {
		try {
			const e = db.entity("settings", "main");
			await e.load();
			const s = e.loaded
				? (e.value as { undo_send_seconds?: number }).undo_send_seconds
				: undefined;
			return Math.max(1, s ?? 10);
		} catch {
			return 10;
		}
	}

	async function undoSend(message_id: string): Promise<void> {
		try {
			const res = await fetch(
				`/api/send/${encodeURIComponent(message_id)}/undo`,
				{
					method: "POST",
				},
			);
			const body = (await res.json().catch(() => ({}))) as { ok?: boolean };
			if (res.ok && body.ok) {
				toast("Send undone — the message is back in Drafts.");
			} else {
				toast("Too late to undo — the message already left the outbox.");
			}
		} catch {
			toast("Could not reach the outbox to undo.");
		}
	}

	// Ctrl/Cmd+Enter sends. The rich-text editor binds Mod-Enter to "insert a line"
	// on its own contenteditable, so a bubble-phase handler would run only AFTER
	// the newline is already in. Catch it in the CAPTURE phase — before the editor
	// (a descendant) ever sees the key — and stop propagation so the message sends
	// without a stray blank line. Handled here, not in onKeydown, for that reason.
	function onKeydownCapture(e: KeyboardEvent): void {
		if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
			e.preventDefault();
			e.stopPropagation();
			void send();
			return;
		}
		// Enter in a recipient field: a complete typed address wins over the
		// highlighted suggestion (which, mid-debounce, may still be matching the
		// previous keystroke). Claim it in the capture phase so the <Input> never
		// gets to swap in a suggestion. If the user has arrowed off the first row
		// they've chosen a suggestion deliberately — leave that Enter to the Input.
		if (e.key === "Enter" && !e.ctrlKey && !e.metaKey && !e.altKey) {
			const field = recipientField(e.target);
			if (!field) return;
			const active = (e.target as HTMLElement).getAttribute(
				"aria-activedescendant",
			);
			if (active && !active.endsWith("-option-0")) return;
			if (commitTypedAddress(field)) {
				e.preventDefault();
				e.stopPropagation();
			}
		}
	}

	function onKeydown(e: KeyboardEvent): void {
		const mod = e.ctrlKey || e.metaKey;
		if (mod && e.shiftKey && e.key.toLowerCase() === "a") {
			e.preventDefault();
			fileInput?.click();
		} else if (mod && e.shiftKey && e.key.toLowerCase() === "c") {
			e.preventDefault();
			showCc = true;
		} else if (mod && e.shiftKey && e.key.toLowerCase() === "b") {
			e.preventDefault();
			showBcc = true;
		} else if (mod && e.key.toLowerCase() === "j") {
			e.preventDefault();
			cycleIdentity();
		}
		// Escape is deliberately NOT handled here — the Modal owns it, so pressing
		// Escape closes only the compose dialog, never the mail behind it.
		// Ctrl/Cmd+Enter (send) lives in onKeydownCapture so the editor can't
		// insert a newline before we act.
	}
</script>

<!-- One recipient row (To / Cc / Bcc). `isTo` renders the always-present To row
     with its Cc/Bcc convenience toggles; Cc and Bcc reuse this inside <Expand>. -->
<!-- A suggestion row inside <Input>'s autocomplete panel: avatar + name + the
     email (which is also the chip value once picked). `opt.label` is the email,
     `opt.description` the display name. -->
{#snippet contactOption(opt: InputOption)}
	<span class="ac-opt">
		<Avatar
			name={opt.description || opt.label}
			src={verifiedAvatarUrl(opt.label)}
			size="0"
		/>
		<span class="ac-text">
			{#if opt.description}<span class="ac-name">{opt.description}</span>{/if}
			<span class="ac-email">{opt.label}</span>
		</span>
	</span>
{/snippet}

<!-- `.compose-host` scopes the no-animation CSS override to this modal only, so
     the dialog and its backdrop appear instantly (snappy) instead of animating. -->
<div class="compose-host">
	<Modal
		bind:open
		onclose={close}
		class="compose-modal"
		title="New message"
		width="640px"
	>
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="compose"
			bind:this={overlayEl}
			onkeydowncapture={onKeydownCapture}
			onkeydown={onKeydown}
			oninput={onFieldInput}
			onfocusin={onFieldFocus}
			ondragover={(e) => e.preventDefault()}
			ondrop={onDrop}
		>
			<div class="fields">
				<!-- Every header row is the same quiet shape: a muted label column and a
				     borderless field, separated by hairlines — one form, not three
				     different controls. From is a text button (a chevron marks it as
				     switchable only when there is something to switch to). -->
				<div class="row">
					<span class="rowlabel" id="from-label">From</span>
					{#if (identities.items as Identity[]).length > 1}
						<!-- A real dropdown (Button's `menu` Popover sits on the popover layer,
						     above the modal). Ctrl+J still cycles without opening it. -->
						<span class="identity-wrap">
							<Button
								size="0"
								transparent
								show_chevron
								tooltip="Switch identity (Ctrl+J)"
								aria-labelledby="from-label"
								popover_placement="bottom-start"
								popover_close_on_inside_click
							>
								{fromIdentity?.email ?? "No identity"}
								{#snippet menu()}
									<List>
										{#each identities.items as Identity[] as i (i.id)}
											<ListItem
												active={String(i.id) === identityId}
												onclick={() => (identityId = String(i.id))}
											>
												<span class="identity-opt">
													<span>{i.email}</span>
													{#if i.name}<span class="identity-name">{i.name}</span
														>{/if}
												</span>
											</ListItem>
										{/each}
									</List>
								{/snippet}
							</Button>
						</span>
					{:else}
						<span class="identity" aria-labelledby="from-label">
							{fromIdentity?.email ?? "No identity"}
						</span>
					{/if}
				</div>

				<!-- To is always visible; Cc/Bcc slide open (delightstack <Expand>) when
				     toggled instead of snapping in. Each is a delightstack <Input> in
				     chips + autocomplete mode: it owns chip add/remove, the suggestion
				     panel, and keyboard nav; `contactOptions` feeds it and `contactOption`
				     renders each row with an avatar. -->
				<div class="row">
					<label for="to">To</label>
					<div class="field">
						<!-- onblur: leaving the field commits a complete address you typed but
						     never picked, so it can't be lost on the way to Subject or Send.
						     (Clicking a suggestion doesn't blur the field — the panel swallows
						     the pointerdown — so this can't race with a pick.) -->
						<Input
							id="to"
							multiple
							bind:value={to}
							onfilter={contactOptions}
							option={contactOption}
							onblur={() => commitTypedAddress("to")}
							onchange={() => syncDraft("to")}
							placeholder="recipient@example.com"
						/>
					</div>
					<!-- Convenience toggles (also Ctrl+Shift+C / Ctrl+Shift+B): kept out of
					     the Tab sequence so Tab flows To → Subject → body directly. -->
					{#if !showCc || !showBcc}
						<span class="toggles">
							{#if !showCc}<button
									type="button"
									class="toggle"
									tabindex={-1}
									onclick={() => (showCc = true)}>Cc</button
								>{/if}
							{#if !showBcc}<button
									type="button"
									class="toggle"
									tabindex={-1}
									onclick={() => (showBcc = true)}>Bcc</button
								>{/if}
						</span>
					{/if}
				</div>
				<Expand show={showCc}>
					<div class="row">
						<label for="cc">Cc</label>
						<div class="field">
							<Input
								id="cc"
								multiple
								bind:value={cc}
								onfilter={contactOptions}
								option={contactOption}
								onblur={() => commitTypedAddress("cc")}
								onchange={() => syncDraft("cc")}
							/>
						</div>
					</div>
				</Expand>
				<Expand show={showBcc}>
					<div class="row">
						<label for="bcc">Bcc</label>
						<div class="field">
							<Input
								id="bcc"
								multiple
								bind:value={bcc}
								onfilter={contactOptions}
								option={contactOption}
								onblur={() => commitTypedAddress("bcc")}
								onchange={() => syncDraft("bcc")}
							/>
						</div>
					</div>
				</Expand>

				<div class="row">
					<label for="subject">Subject</label>
					<input
						id="subject"
						class="subject"
						bind:value={subject}
						placeholder="Subject"
					/>
				</div>
			</div>

			<div class="body">
				<EditorView {editor} />
				{#if signaturePreview}
					<div class="signature" aria-label="Signature">
						<div class="sig-marker">--</div>
						<pre>{signaturePreview}</pre>
					</div>
				{/if}
			</div>

			{#if attachments.length}
				<div class="attachments">
					{#each attachments as a (a.id)}
						<span class="att-chip" class:uploading={a.uploading}>
							<Icon name="paperclip" size={13} />
							{a.filename} <span class="att-size">{fmtSize(a.size)}</span>
							{#if a.uploading}<span class="att-status">uploading…</span>{/if}
							<button
								onclick={() => removeAttachment(a.id)}
								aria-label="Remove attachment"
								><Icon name="x" size={13} /></button
							>
						</span>
					{/each}
				</div>
			{/if}
		</div>

		<!-- Actions live in the title bar; the shortcuts are on their tooltips
		     (Esc-to-close needs no signpost). No footer. -->
		{#snippet header_end()}
			<div class="actions">
				<input
					bind:this={fileInput}
					type="file"
					multiple
					hidden
					onchange={onFilePicked}
				/>
				<Button
					icon
					transparent
					onclick={() => fileInput?.click()}
					tooltip="Attach (Ctrl+Shift+A)"
					aria-label="Attach files"
				>
					<Icon name="paperclip" size={18} />
				</Button>
				<Button
					accent
					size="0"
					disabled={!canSend}
					loading={sending}
					onclick={send}
					tooltip="Send (Ctrl+Enter)"
				>
					{sending ? "Sending…" : "Send"}
				</Button>
			</div>
		{/snippet}
	</Modal>
</div>

<style>
	/* Fast, not absent: replace the Modal's built-in transitions (inline
	   `animation`, which a stylesheet `!important` beats) with a 120ms
	   fade + settle. Instant-but-easing reads as QUICK; a zero-frame appear
	   reads as a glitch. */
	:global(.compose-host .modal) {
		animation: dm-compose-in 120ms var(--ease-out, ease) !important;
	}
	:global(.compose-host .modal-bg) {
		animation: dm-fade-in 120ms var(--ease-out, ease) !important;
	}
	@keyframes -global-dm-compose-in {
		from {
			opacity: 0;
			transform: scale(0.985);
		}
		to {
			opacity: 1;
			transform: scale(1);
		}
	}
	@keyframes -global-dm-fade-in {
		from {
			opacity: 0;
		}
		to {
			opacity: 1;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		:global(.compose-host .modal),
		:global(.compose-host .modal-bg) {
			animation: none !important;
		}
	}

	/* The editor's block menus — the slash "/" menu, the "+" add-block menu, the
	   selection toolbar and the per-block settings popover — portal themselves to
	   <body> (to escape the editor's overflow) with a hardcoded low z-index (40–60).
	   Out there they share the root stacking context with this modal's panel, which
	   sits at --layer-modal + 1 (401), so the menus open *behind* the dialog and are
	   invisible. Lift them onto delightstack's --layer-popover (500) — the layer
	   meant to sit above modals. Scoped to direct <body> children so it only touches
	   the portalled editor menus, never same-named elements nested in the app (e.g.
	   the settings page's own `.settings`); !important beats the editor's own
	   Svelte-scoped `.slash-menu` rule, which has higher specificity. */
	:global(body > .slash-menu),
	:global(body > .menu-wrap),
	:global(body > .floating),
	:global(body > .settings),
	:global(body > .mobile-bar) {
		z-index: var(--layer-popover, 500) !important;
	}

	:global(.compose-host .modal .body > header) {
		/* Ensure "Send" button equidistant from modal body */
		margin-right: -1.25rem;
	}

	.compose {
		display: flex;
		flex-direction: column;
	}
	/* --- header: one quiet form. Label column + borderless field per row, a
	   hairline between rows, the same type size everywhere. --- */
	.fields {
		padding: 0 0 var(--space-1);
	}
	.row {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		min-height: 40px;
		border-bottom: 1px solid var(--dm-hairline);
	}
	.row label,
	.row .rowlabel {
		width: 56px;
		flex-shrink: 0;
		color: var(--color-text-disabled);
		font-size: var(--font-size-0);
		/* Labels sit on the first line so a chip row that wraps keeps them at top. */
		align-self: flex-start;
		line-height: 40px;
	}
	.field {
		flex: 1;
		min-width: 0;
	}
	/* The recipient <Input> draws its own boxed field chrome; here it is one row
	   of a form, so strip the box (border, radius, height) and let its chips and
	   suggestion panel sit inline with the other rows. Its private tokens are
	   the supported way in — no reaching into its markup. */
	.field :global(.input) {
		--_border: transparent;
		--_border-hover: transparent;
		--_border-focus: transparent;
		--_radius: 0;
		--_height: 40px;
		--_bg: transparent;
		--control-pad-x: 0px;
	}
	/* Single identity: plain text, nothing to click. */
	.identity {
		font-size: var(--font-size-1);
	}
	/* Several: the Button's text sits flush with the other fields (its own
	   padding is pulled back so the email lines up with To/Subject). */
	.identity-wrap {
		margin-left: calc(-1 * var(--control-pad-x, 0.75em));
	}
	.identity-wrap :global(.button) {
		font-size: var(--font-size-1);
		font-weight: normal;
		/* Body text, not the accent a plain transparent Button paints itself with
		   (it sets its own --color-text/-active; inherit hands back the page tokens). */
		--color-text: inherit;
		--color-text-active: inherit;
	}
	/* The Button's own chevron has no intrinsic size at size="0". */
	.identity-wrap :global(.chevron) {
		width: 1em;
		height: 1em;
		opacity: 0.6;
	}
	.identity-opt {
		display: flex;
		flex-direction: column;
		line-height: 1.25;
		text-align: left;
	}
	.identity-name {
		color: var(--color-text-disabled);
		font-size: var(--font-size-0);
	}
	.subject {
		width: 100%;
		border: none;
		background: transparent;
		color: inherit;
		outline: none;
		padding: 0;
		font: inherit;
		font-size: var(--font-size-1);
		line-height: 40px;
	}
	.subject::placeholder {
		color: var(--color-text-disabled);
	}
	.toggle {
		border: none;
		background: transparent;
		color: var(--color-text-disabled);
		font: inherit;
		font-size: var(--font-size-0);
		padding: 4px 6px;
		border-radius: var(--radius-sm);
		cursor: pointer;
		transition:
			color 120ms var(--ease-out, ease),
			background-color 120ms var(--ease-out, ease);
		&:hover {
			color: var(--color-text);
			background: var(--color-bg-3);
		}
	}
	/* A suggestion row rendered into <Input>'s panel via the `option` snippet.
	   The row's <button> centers its content (native button default), so the
	   snippet must claim the full width and pin its text left itself. */
	.ac-opt {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
		width: 100%;
		text-align: left;
	}
	.ac-text {
		display: flex;
		flex-direction: column;
		line-height: 1.25;
		min-width: 0;
	}
	.ac-name {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.ac-email {
		color: var(--color-text-disabled);
		font-size: var(--font-size-00);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	/* Favicon treatment (neutral backdrop + contain) for avatars in the panel. */
	.ac-opt :global(.avatar img) {
		background: var(--color-bg-3);
		object-fit: contain;
		padding: 2px;
		box-sizing: border-box;
	}
	.toggles {
		display: flex;
		gap: 2px;
		align-self: flex-start;
		padding-top: 6px;
	}
	.body {
		flex: 1;
		padding: var(--space-4) 0 var(--space-2);
		min-height: 220px;
	}
	.signature {
		margin-top: var(--space-4);
		color: var(--color-text-disabled);
	}
	.sig-marker {
		font-family: var(--font-mono);
	}
	.signature pre {
		margin: 0;
		white-space: pre-wrap;
		font: inherit;
		font-size: var(--font-size-00);
	}
	.attachments {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		padding: var(--space-2) 0 0;
		border-top: 1px solid var(--color-border);
		margin-top: var(--space-2);
	}
	.att-chip {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		background: var(--color-bg-2);
		border-radius: var(--radius-md);
		padding: 3px 8px;
		font-size: var(--font-size-00);
	}
	.att-chip.uploading {
		opacity: 0.6;
	}
	.att-size,
	.att-status {
		color: var(--color-text-disabled);
	}
	.att-chip button {
		display: inline-flex;
		align-items: center;
		background: none;
		border: none;
		padding: 0;
		color: var(--color-text-disabled);
		cursor: pointer;
	}
	.att-chip button:hover {
		color: var(--color-error);
	}

	/* Title-bar actions (header_end): Attach + Send. */
	.actions {
		display: flex;
		align-items: center;
		gap: var(--space-1);
	}

	/* The email body starts blank — hide the editor's "Heading / Bullet list …"
	   quick-start chips that otherwise appear under the empty-doc placeholder. */
	.body :global(.quick-chips) {
		display: none;
	}
	@media (max-width: 767px) {
		/* Compose fills the screen on a phone. The delightstack Modal already
		   turns into a full-width bottom sheet (title bar stuck at the bottom,
		   in thumb reach) — we only stretch it to full height so a long email
		   never composes through a letterbox. The .body carries inline width/
		   max-height from the width prop, hence the !important. */
		:global(.compose-host .modal .body) {
			width: 100vw !important;
			max-width: 100vw !important;
			min-height: 100dvh;
			max-height: 100dvh !important;
			border-radius: 0 !important;
			padding-top: env(safe-area-inset-top);
			padding-bottom: env(safe-area-inset-bottom);
		}
		/* iOS zooms any focused input under 16px — recipients, subject, editor. */
		:global(.compose-host input),
		.subject,
		.body {
			font-size: 16px;
		}
	}
</style>
