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

/** The next weekday (Mon–Fri) strictly after `now`, at 8:00 local. */
export function nextWeekdayMorning(now: Date = new Date()): number {
	const d = new Date(now);
	do {
		d.setDate(d.getDate() + 1);
	} while (d.getDay() === 0 || d.getDay() === 6);
	d.setHours(MORNING, 0, 0, 0);
	return d.getTime();
}

/** `count` weekdays (Mon–Fri) after `now`, at 8:00 local. */
function weekdaysFromNow(count: number, now: Date): number {
	const d = new Date(now);
	let left = count;
	while (left > 0) {
		d.setDate(d.getDate() + 1);
		if (d.getDay() !== 0 && d.getDay() !== 6) left--;
	}
	d.setHours(MORNING, 0, 0, 0);
	return d.getTime();
}

/** The next Monday strictly after `now` (+ optional extra weeks), at 8:00 local. */
function nextMonday(now: Date, extra_weeks = 0): number {
	const d = new Date(now);
	const toMonday = (1 - d.getDay() + 7) % 7 || 7;
	d.setDate(d.getDate() + toMonday + extra_weeks * 7);
	d.setHours(MORNING, 0, 0, 0);
	return d.getTime();
}

/**
 * The snooze chord menu (z + number). Fixed number keys so the mapping is
 * muscle-memorizable — unlike snoozeOptions(), entries never drop out.
 */
export function snoozeChordOptions(now: Date = new Date()): SnoozeOption[] {
	// Later today: +3 hours; after ~21:00 that stops being "today", so it rolls
	// to the next weekday morning like the default.
	const later = new Date(now.getTime() + 3 * 60 * 60_000);
	const later_at =
		later.getDate() === now.getDate() ? later.getTime() : nextWeekdayMorning(now);

	const tomorrow = new Date(now);
	tomorrow.setDate(tomorrow.getDate() + 1);
	tomorrow.setHours(MORNING, 0, 0, 0);

	const month = new Date(now);
	month.setMonth(month.getMonth() + 1);
	month.setHours(MORNING, 0, 0, 0);

	return [
		{ key: '1', label: 'Later today', at: later_at },
		{ key: '2', label: 'Tomorrow', at: tomorrow.getTime() },
		{ key: '3', label: 'In a couple of weekdays', at: weekdaysFromNow(2, now) },
		{ key: '4', label: 'Next week', at: nextMonday(now) },
		{ key: '5', label: 'Week after next', at: nextMonday(now, 1) },
		{ key: '6', label: 'In a month', at: month.getTime() },
	];
}

/** Short human label for a wake time ("Tue 8:00", "Today 17:32"). */
export function fmtWake(at: number, now: Date = new Date()): string {
	const d = new Date(at);
	const sameDay = d.toDateString() === now.toDateString();
	const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
	if (sameDay) return `Today ${time}`;
	const day = d.toLocaleDateString(undefined, { weekday: 'short' });
	// Beyond a week, a bare weekday is ambiguous ("Mon" — which one?).
	if (at - now.getTime() > 6.5 * 24 * 60 * 60_000) {
		return `${day} ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
	}
	return `${day} ${time}`;
}
