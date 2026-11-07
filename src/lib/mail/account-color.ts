/**
 * A stable, distinct colour per account. Accounts rarely have one set, and the
 * old fallback painted every dot the same primary blue, so the colour carried
 * no information. Hues are spread around the OKLCH wheel and picked by a hash
 * of the account id, so an account keeps its colour across devices and reloads.
 */
const HUES = [250, 25, 150, 300, 70, 195, 340, 110];

/** FNV-1a — mixes every character into every bit, so similar ids still land on different hues. */
function hash(value: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < value.length; i++) h = Math.imul(h ^ value.charCodeAt(i), 0x01000193);
	return h >>> 0;
}

export function accountColor(id: string, explicit?: string | null): string {
	if (explicit) return explicit;
	return `oklch(66% 0.15 ${HUES[hash(id) % HUES.length]})`;
}

const KIND_LABELS: Record<string, string> = {
	gmail: 'Gmail',
	imap: 'IMAP',
	cf_domain: 'Domain',
};

/**
 * Secondary text that tells accounts apart when their labels collide (the same
 * address connected twice, or over two protocols). Empty for unique labels.
 */
export function accountDetails(
	accounts: Array<{ id: string; label: string; kind?: string }>,
): Map<string, string> {
	const out = new Map<string, string>();
	const groups = new Map<string, typeof accounts>();
	for (const a of accounts) {
		const key = a.label.toLowerCase();
		groups.set(key, [...(groups.get(key) ?? []), a]);
	}
	for (const group of groups.values()) {
		if (group.length < 2) continue;
		const kinds = new Set(group.map((a) => a.kind));
		// One of each protocol: the protocol is the difference worth naming.
		if (kinds.size === group.length && !kinds.has(undefined)) {
			for (const a of group) out.set(a.id, KIND_LABELS[a.kind!] ?? a.kind!);
			continue;
		}
		// Otherwise just number them, in list order — short enough that the
		// address itself still fits.
		group.forEach((a, i) => out.set(a.id, String(i + 1)));
	}
	return out;
}
