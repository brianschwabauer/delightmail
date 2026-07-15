/**
 * Snooze presets. Pure (clock injected) — unit-tested in snooze.test.ts.
 * Mornings are 8:00, evenings 18:00 local time.
 */
export interface SnoozeOption {
	key: string;
	label: string;
	/** Epoch-ms wake time. */
	at: number;
}

const MORNING = 8;
const EVENING = 18;

export function snoozeOptions(now: Date = new Date()): SnoozeOption[] {
	const out: SnoozeOption[] = [];

	// Later today: +3 hours, only while it still lands today.
	const later = new Date(now.getTime() + 3 * 60 * 60_000);
	if (later.getDate() === now.getDate()) {
		out.push({ key: 'later', label: 'Later today', at: later.getTime() });
	}

	// This evening: today 18:00, only if that is still ≥1h away.
	const evening = new Date(now);
	evening.setHours(EVENING, 0, 0, 0);
	if (evening.getTime() - now.getTime() >= 60 * 60_000) {
		out.push({ key: 'evening', label: 'This evening', at: evening.getTime() });
	}

	// Tomorrow morning.
	const tomorrow = new Date(now);
	tomorrow.setDate(tomorrow.getDate() + 1);
	tomorrow.setHours(MORNING, 0, 0, 0);
	out.push({ key: 'tomorrow', label: 'Tomorrow', at: tomorrow.getTime() });

	// This weekend: the NEXT Saturday morning strictly after today.
	const weekend = new Date(now);
	const toSaturday = (6 - weekend.getDay() + 7) % 7 || 7;
	weekend.setDate(weekend.getDate() + toSaturday);
	weekend.setHours(MORNING, 0, 0, 0);
	out.push({ key: 'weekend', label: 'This weekend', at: weekend.getTime() });

	// Next week: the next Monday morning strictly after today.
	const monday = new Date(now);
	const toMonday = (1 - monday.getDay() + 7) % 7 || 7;
	monday.setDate(monday.getDate() + toMonday);
	monday.setHours(MORNING, 0, 0, 0);
	out.push({ key: 'week', label: 'Next week', at: monday.getTime() });

	return out;
}

/** Short human label for a wake time ("Tue 8:00", "Today 17:32"). */
export function fmtWake(at: number, now: Date = new Date()): string {
	const d = new Date(at);
	const sameDay = d.toDateString() === now.toDateString();
	const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
	if (sameDay) return `Today ${time}`;
	const day = d.toLocaleDateString(undefined, { weekday: 'short' });
	return `${day} ${time}`;
}
