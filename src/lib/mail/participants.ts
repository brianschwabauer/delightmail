/**
 * The sender label shown on a thread row. Pure + unit-tested.
 *
 * `thread.participant_text` is built for the search index: a blob of
 * "Name email, Name email" so a query matches either a name or an address. It is
 * NOT a display string — rendering it directly puts a raw address beside every
 * name and repeats your own address on every row.
 *
 * It is also the ONLY participant data a thread search hit carries (hits project
 * indexed fields only; the structured `participants` array is not one), so the
 * display label is reconstructed from it here.
 */

/**
 * The DSL types stored addresses with nullable fields ({name: string | null}),
 * so accept that shape rather than making every caller normalize first.
 */
export interface Participant {
	name?: string | null;
	email?: string | null;
}

export interface SelfAddresses {
	/** Full addresses you own. */
	emails?: string[];
	/** Domains you own — every address at them is yours (custom-domain catch-all). */
	domains?: string[];
}

/**
 * Invert `participantText()` (server/src/ingest.ts): entries are joined with
 * ", " and each is "Name email", "Name", or "email".
 *
 * A display name containing a comma ("Doe, John") splits into two entries, which
 * still renders as "Doe, John" once the names are re-joined — so the label stays
 * right even though the parse is imperfect.
 */
export function parseParticipantText(text: string | null | undefined): Participant[] {
	if (!text?.trim()) return [];
	return text
		.split(',')
		.map((entry) => entry.trim())
		.filter(Boolean)
		.map((entry) => {
			const at = entry.lastIndexOf(' ');
			const tail = at === -1 ? entry : entry.slice(at + 1);
			// The address is the last token, and only if it looks like one.
			if (tail.includes('@')) {
				return { name: at === -1 ? undefined : entry.slice(0, at).trim(), email: tail };
			}
			return { name: entry };
		});
}

function isSelf(email: string, self: SelfAddresses): boolean {
	const addr = email.toLowerCase();
	if (self.emails?.some((e) => e.toLowerCase() === addr)) return true;
	const at = addr.lastIndexOf('@');
	if (at === -1) return false;
	const domain = addr.slice(at + 1);
	return !!self.domains?.some((d) => d.toLowerCase() === domain);
}

/** A person's display name, falling back to their address. */
function displayName(a: Participant): string {
	const name = a.name?.trim();
	if (name) return name;
	return a.email?.trim() ?? '';
}

/**
 * Names of everyone on the thread except you, in order (ingest puts `from`
 * first). A thread with only your own addresses — a note to self, or your own
 * sent mail — falls back to showing you, since "nobody" reads as a bug.
 */
export function participantLabel(
	participants: Participant[] | null | undefined,
	self: SelfAddresses = {},
): string {
	const all = (participants ?? []).filter((p) => p.email || p.name);
	if (!all.length) return '';

	const others = all.filter((p) => !p.email || !isSelf(p.email, self));
	const shown = others.length ? others : all;

	// Two people can share a display name ("Support"); dedupe so a row doesn't
	// read "Support, Support".
	const seen = new Set<string>();
	const names: string[] = [];
	for (const p of shown) {
		const name = displayName(p);
		if (!name || seen.has(name.toLowerCase())) continue;
		seen.add(name.toLowerCase());
		names.push(name);
	}
	return names.join(', ');
}

/** The participants of a thread, whether it came from a search hit or a full row. */
export function threadParticipants(thread: {
	participants?: Participant[] | null;
	participant_text?: string | null;
}): Participant[] {
	if (thread.participants?.length) return thread.participants;
	return parseParticipantText(thread.participant_text);
}

/** The sender label for a thread row — the other people on it, by name. */
export function threadSenderLabel(
	thread:
		| { participants?: Participant[] | null; participant_text?: string | null }
		| null
		| undefined,
	self: SelfAddresses = {},
): string {
	if (!thread) return '';
	return participantLabel(threadParticipants(thread), self);
}
