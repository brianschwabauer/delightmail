import { describe, it, expect } from 'vitest';
import { snoozeOptions, snoozeChordOptions, nextWeekdayMorning, fmtWake } from './snooze';

// Tuesday 2026-07-14 10:00 local
const TUE_MORNING = new Date(2026, 6, 14, 10, 0, 0);
// Tuesday 2026-07-14 22:30 local
const TUE_NIGHT = new Date(2026, 6, 14, 22, 30, 0);
// Saturday 2026-07-18 09:00 local
const SATURDAY = new Date(2026, 6, 18, 9, 0, 0);

describe('snoozeOptions', () => {
	it('offers later today + this evening on a weekday morning', () => {
		const keys = snoozeOptions(TUE_MORNING).map((o) => o.key);
		expect(keys).toEqual(['later', 'evening', 'tomorrow', 'weekend', 'week']);
	});

	it('drops same-day options late at night', () => {
		const keys = snoozeOptions(TUE_NIGHT).map((o) => o.key);
		expect(keys).toEqual(['tomorrow', 'weekend', 'week']);
	});

	it('every option is strictly in the future', () => {
		for (const base of [TUE_MORNING, TUE_NIGHT, SATURDAY]) {
			for (const o of snoozeOptions(base)) {
				expect(o.at).toBeGreaterThan(base.getTime());
			}
		}
	});

	it('tomorrow is 8:00 the next day', () => {
		const t = snoozeOptions(TUE_MORNING).find((o) => o.key === 'tomorrow')!;
		const d = new Date(t.at);
		expect(d.getDate()).toBe(15);
		expect(d.getHours()).toBe(8);
	});

	it('on a Saturday, "this weekend" means NEXT Saturday', () => {
		const w = snoozeOptions(SATURDAY).find((o) => o.key === 'weekend')!;
		const d = new Date(w.at);
		expect(d.getDay()).toBe(6);
		expect(d.getDate()).toBe(25);
	});

	it('next week is the following Monday 8:00', () => {
		const m = snoozeOptions(TUE_MORNING).find((o) => o.key === 'week')!;
		const d = new Date(m.at);
		expect(d.getDay()).toBe(1);
		expect(d.getHours()).toBe(8);
	});
});

describe('nextWeekdayMorning', () => {
	it('a Tuesday wakes Wednesday 8:00', () => {
		const d = new Date(nextWeekdayMorning(TUE_MORNING));
		expect([d.getDay(), d.getDate(), d.getHours()]).toEqual([3, 15, 8]);
	});
	it('a Friday skips the weekend to Monday', () => {
		const friday = new Date(2026, 6, 17, 10, 0, 0);
		const d = new Date(nextWeekdayMorning(friday));
		expect([d.getDay(), d.getDate()]).toEqual([1, 20]);
	});
	it('a Saturday wakes Monday', () => {
		const d = new Date(nextWeekdayMorning(SATURDAY));
		expect([d.getDay(), d.getDate()]).toEqual([1, 20]);
	});
});

describe('snoozeChordOptions', () => {
	it('always offers the fixed 1–6 keys', () => {
		for (const base of [TUE_MORNING, TUE_NIGHT, SATURDAY]) {
			expect(snoozeChordOptions(base).map((o) => o.key)).toEqual(['1', '2', '3', '4', '5', '6']);
		}
	});
	it('every option is strictly in the future', () => {
		for (const base of [TUE_MORNING, TUE_NIGHT, SATURDAY]) {
			for (const o of snoozeChordOptions(base)) {
				expect(o.at).toBeGreaterThan(base.getTime());
			}
		}
	});
	it('later today late at night rolls to the next weekday morning', () => {
		const later = snoozeChordOptions(TUE_NIGHT).find((o) => o.key === '1')!;
		expect(later.at).toBe(nextWeekdayMorning(TUE_NIGHT));
	});
	it('a couple of weekdays skips the weekend', () => {
		// Friday +2 weekdays = Tuesday
		const friday = new Date(2026, 6, 17, 10, 0, 0);
		const d = new Date(snoozeChordOptions(friday).find((o) => o.key === '3')!.at);
		expect([d.getDay(), d.getDate()]).toEqual([2, 21]);
	});
	it('week after next is 7 days past next week', () => {
		const opts = snoozeChordOptions(TUE_MORNING);
		const next = opts.find((o) => o.key === '4')!.at;
		const after = opts.find((o) => o.key === '5')!.at;
		expect(after - next).toBe(7 * 24 * 60 * 60_000);
	});
});

describe('fmtWake', () => {
	it('same-day wake says Today', () => {
		expect(fmtWake(TUE_MORNING.getTime() + 60 * 60_000, TUE_MORNING)).toMatch(/^Today /);
	});
	it('future days show the weekday', () => {
		const tomorrow = new Date(2026, 6, 15, 8, 0, 0);
		expect(fmtWake(tomorrow.getTime(), TUE_MORNING)).toMatch(/^Wed /);
	});
});
