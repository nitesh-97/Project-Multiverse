import { describe, expect, it } from 'vitest';
import { WorkCalendar } from '../src';

const weekdays = (over: Partial<ConstructorParameters<typeof WorkCalendar>[0]> = {}) =>
  new WorkCalendar({ startDate: '2026-10-05', weekendDays: [0, 6], holidays: [], ...over });

describe('WorkCalendar', () => {
  it('numbers working days from the start and skips weekends', () => {
    const cal = weekdays();
    expect(cal.nthWorkingDay(1)).toBe('2026-10-05'); // Mon
    expect(cal.nthWorkingDay(5)).toBe('2026-10-09'); // Fri
    expect(cal.nthWorkingDay(6)).toBe('2026-10-12'); // next Mon
    expect(cal.nthWorkingDay(20)).toBe('2026-10-30'); // Fri
    expect(cal.nthWorkingDay(21)).toBe('2026-11-02'); // Mon
    expect(cal.nthWorkingDay(22)).toBe('2026-11-03'); // Tue
  });

  it('converts dates to start-of-day and end-of-day offsets', () => {
    const cal = weekdays();
    expect(cal.startOffset('2026-10-05')).toBe(0);
    expect(cal.startOffset('2026-10-09')).toBe(4);
    expect(cal.endOffset('2026-10-05')).toBe(1);
    expect(cal.endOffset('2026-10-09')).toBe(5);
    expect(cal.endOffset('2026-10-12')).toBe(6);
  });

  it('maps weekend dates to the nearest working-day boundary', () => {
    const cal = weekdays();
    expect(cal.startOffset('2026-10-10')).toBe(5); // Sat: end of Friday
    expect(cal.startOffset('2026-10-11')).toBe(5);
    expect(cal.endOffset('2026-10-10')).toBe(5);
    expect(cal.endOffset('2026-10-11')).toBe(5);
  });

  it('turns offsets back into dates', () => {
    const cal = weekdays();
    expect(cal.dateAtOffset(0)).toBe('2026-10-05');
    expect(cal.dateAtOffset(0.5)).toBe('2026-10-05');
    expect(cal.dateAtOffset(1)).toBe('2026-10-05');
    expect(cal.dateAtOffset(1.5)).toBe('2026-10-06');
    expect(cal.dateAtOffset(5)).toBe('2026-10-09');
    expect(cal.dateAtOffset(5.0001)).toBe('2026-10-12');
    expect(cal.dateAtOffset(20)).toBe('2026-10-30');
    expect(cal.dateAtOffset(20.5)).toBe('2026-11-02');
  });

  it('ignores floating-point noise when converting offsets to dates', () => {
    const cal = weekdays();
    expect(cal.dateAtOffset(1 + 1e-12)).toBe('2026-10-05');
    expect(cal.startDateAtOffset(5 - 1e-12)).toBe('2026-10-12');
  });

  it('finds the date on which work beginning at an offset starts', () => {
    const cal = weekdays();
    expect(cal.startDateAtOffset(0)).toBe('2026-10-05');
    expect(cal.startDateAtOffset(0.5)).toBe('2026-10-05');
    expect(cal.startDateAtOffset(1)).toBe('2026-10-06');
    expect(cal.startDateAtOffset(5)).toBe('2026-10-12');
  });

  it('skips holidays', () => {
    const cal = weekdays({ holidays: ['2026-10-08'] }); // Thu
    expect(cal.nthWorkingDay(3)).toBe('2026-10-07');
    expect(cal.nthWorkingDay(4)).toBe('2026-10-09');
    expect(cal.startOffset('2026-10-08')).toBe(3);
    expect(cal.endOffset('2026-10-08')).toBe(3);
    expect(cal.startOffset('2026-10-09')).toBe(3);
  });

  it('starts counting at the first working day when the start date is a weekend', () => {
    const cal = weekdays({ startDate: '2026-10-03' }); // Sat
    expect(cal.nthWorkingDay(1)).toBe('2026-10-05');
    expect(cal.startOffset('2026-10-03')).toBe(0);
    expect(cal.endOffset('2026-10-04')).toBe(0);
    expect(cal.startOffset('2026-10-05')).toBe(0);
  });

  it('supports a different weekend (Fri/Sat)', () => {
    const cal = weekdays({ startDate: '2026-10-04', weekendDays: [5, 6] }); // Sun start
    expect(cal.nthWorkingDay(1)).toBe('2026-10-04');
    expect(cal.nthWorkingDay(5)).toBe('2026-10-08'); // Thu
    expect(cal.nthWorkingDay(6)).toBe('2026-10-11'); // Sun again
  });

  it('round-trips every working day', () => {
    const cal = weekdays({ holidays: ['2026-10-08', '2026-10-26'] });
    for (let n = 1; n <= 80; n++) {
      const date = cal.nthWorkingDay(n);
      expect(cal.startOffset(date)).toBe(n - 1);
      expect(cal.endOffset(date)).toBe(n);
      expect(cal.isWorkingDay(date)).toBe(true);
    }
  });

  it('rejects dates before the project start unless clamped', () => {
    const cal = weekdays();
    expect(() => cal.startOffset('2026-10-02')).toThrow(RangeError);
    expect(cal.startOffsetClamped('2026-10-02')).toBe(0);
    expect(cal.endOffsetClamped('2026-10-02')).toBe(0);
  });

  it('rejects malformed or impossible dates and calendars', () => {
    expect(() => weekdays({ startDate: '2026-02-30' })).toThrow(RangeError);
    expect(() => weekdays({ startDate: '10/05/2026' })).toThrow(RangeError);
    expect(() => weekdays({ weekendDays: [0, 1, 2, 3, 4, 5, 6] })).toThrow(/no working days/);
    expect(() => weekdays({ weekendDays: [7] })).toThrow(RangeError);
  });
});
