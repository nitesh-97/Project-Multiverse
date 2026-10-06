import { describe, expect, it } from 'vitest';
import { CapacityModel, WorkCalendar } from '../src';

const calendar = new WorkCalendar({ startDate: '2026-10-05', weekendDays: [0, 6], holidays: [] });
const dev = (from: string, headcount: number) => ({ teamId: 'dev', from, headcount });

describe('CapacityModel.workBetween', () => {
  it('is the elapsed time when a team has no capacity rows', () => {
    const m = new CapacityModel([], calendar);
    expect(m.workBetween('dev', 1, 3.5)).toBe(2.5);
    expect(m.workBetween('dev', 3, 3)).toBe(0);
    expect(m.workBetween('dev', 4, 3)).toBe(0);
  });

  it('integrates the capacity factor across a change', () => {
    // 4 -> 2 people from offset 2: two days at 1, then two days at 0.5.
    const m = new CapacityModel([dev('2026-10-05', 4), dev('2026-10-07', 2)], calendar);
    expect(m.workBetween('dev', 0, 4)).toBe(3);
    expect(m.workBetween('dev', 1.5, 2.5)).toBe(0.75);
  });

  it('is the inverse of timeToComplete', () => {
    const m = new CapacityModel(
      [dev('2026-10-05', 4), dev('2026-10-07', 2), dev('2026-10-09', 0), dev('2026-10-13', 6)],
      calendar,
    );
    for (const [from, work] of [[0, 1], [0.5, 2.25], [1.25, 3], [2, 0.4], [3.5, 5]] as const) {
      const finish = m.timeToComplete('dev', from, work);
      expect(m.workBetween('dev', from, finish)).toBeCloseTo(work, 7); // offsets are rounded to a 1e-9 grid
    }
  });
});
