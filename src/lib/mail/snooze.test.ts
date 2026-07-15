import { describe, it, expect } from 'vitest';
import { snoozeOptions, fmtWake } from './snooze';

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

describe('fmtWake', () => {
	it('same-day wake says Today', () => {
		expect(fmtWake(TUE_MORNING.getTime() + 60 * 60_000, TUE_MORNING)).toMatch(/^Today /);
	});
	it('future days show the weekday', () => {
		const tomorrow = new Date(2026, 6, 15, 8, 0, 0);
		expect(fmtWake(tomorrow.getTime(), TUE_MORNING)).toMatch(/^Wed /);
	});
});
