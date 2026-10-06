import type { CalendarSpec, ISODate } from './types';

/**
 * Comparison tolerance for offsets, in working days (about 8 ms of a day). Deliberately 100,000x coarser than the
 * rounding grid of {@link snap}, so rounding drift accumulated over a long history can never flip a comparison
 * (for example, a task that ends exactly at the end of a day being reported as finishing on the next day).
 */
export const EPS = 1e-7;

/**
 * Rounds to a 1e-12 grid to remove floating-point noise (0.1 + 0.2) so offsets print cleanly. The grid is fine so
 * that the error from rounding stays negligible when forecasts are carried forward many times. Exact for offsets up
 * to roughly 9,000 working days. Normalises -0 to 0.
 */
export const snap = (x: number): number => Math.round(x * 1e12) / 1e12 + 0;

const MS_PER_DAY = 86_400_000;
const MAX_WORKING_DAYS = 100_000;

function toDayNumber(iso: ISODate): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) throw new RangeError(`Invalid date "${iso}", expected YYYY-MM-DD`);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const ms = Date.UTC(y, mo - 1, d);
  const check = new Date(ms);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) {
    throw new RangeError(`Invalid date "${iso}"`);
  }
  return Math.round(ms / MS_PER_DAY);
}

export function isISODate(value: string): boolean {
  try {
    toDayNumber(value);
    return true;
  } catch {
    return false;
  }
}

function fromDayNumber(n: number): ISODate {
  return new Date(n * MS_PER_DAY).toISOString().slice(0, 10);
}

/** 0 = Sunday ... 6 = Saturday. Day 0 (1970-01-01) was a Thursday. */
function dayOfWeek(n: number): number {
  return (((n + 4) % 7) + 7) % 7;
}

/**
 * Maps calendar dates to working-day offsets and back.
 *
 * An offset `t` is a position on a timeline that only contains working days:
 * offset 0 is the start of working day 1, offset 1 the end of day 1 (= start of day 2), and so on.
 */
export class WorkCalendar {
  private readonly startDay: number;
  private readonly weekend: ReadonlySet<number>;
  private readonly holidays: ReadonlySet<number>;
  /** Working days found so far, as day numbers, ascending. Extended lazily. */
  private readonly days: number[] = [];
  private cursor: number;

  constructor(spec: CalendarSpec) {
    for (const d of spec.weekendDays) {
      if (!Number.isInteger(d) || d < 0 || d > 6) throw new RangeError(`Invalid weekend day ${d}, expected 0-6`);
    }
    if (new Set(spec.weekendDays).size >= 7) throw new RangeError('Calendar has no working days');
    this.startDay = toDayNumber(spec.startDate);
    this.cursor = this.startDay;
    this.weekend = new Set(spec.weekendDays);
    this.holidays = new Set(spec.holidays.map(toDayNumber));
  }

  get startDate(): ISODate {
    return fromDayNumber(this.startDay);
  }

  isWorkingDay(date: ISODate): boolean {
    return this.isWorking(toDayNumber(date));
  }

  /** The date of working day `n` (1-based). */
  nthWorkingDay(n: number): ISODate {
    if (!Number.isInteger(n) || n < 1) throw new RangeError(`Working day index must be a positive integer, got ${n}`);
    if (n > MAX_WORKING_DAYS) throw new RangeError(`Working day ${n} is beyond the supported horizon`);
    while (this.days.length < n) this.pushNext();
    return fromDayNumber(this.days[n - 1] as number);
  }

  /** Working days strictly before `date` since the start: the offset of the start of `date`'s day. */
  startOffset(date: ISODate): number {
    const day = this.dayNumberOnOrAfterStart(date);
    this.extendThrough(day);
    return this.countBefore(day);
  }

  /** Working days up to and including `date`: the offset of the end of `date`'s day. */
  endOffset(date: ISODate): number {
    const day = this.dayNumberOnOrAfterStart(date);
    this.extendThrough(day);
    return this.countBefore(day) + (this.isWorking(day) ? 1 : 0);
  }

  /** Like {@link startOffset} but dates before the project start map to 0 instead of throwing. */
  startOffsetClamped(date: ISODate): number {
    return toDayNumber(date) < this.startDay ? 0 : this.startOffset(date);
  }

  /** Like {@link endOffset} but dates before the project start map to 0 instead of throwing. */
  endOffsetClamped(date: ISODate): number {
    return toDayNumber(date) < this.startDay ? 0 : this.endOffset(date);
  }

  /** The date on which work that ends at `offset` finishes. Offsets <= 0 map to day 1. */
  dateAtOffset(offset: number): ISODate {
    return this.nthWorkingDay(Math.max(Math.ceil(offset - EPS), 1));
  }

  /** The date on which work that begins at `offset` starts. */
  startDateAtOffset(offset: number): ISODate {
    return this.nthWorkingDay(Math.max(Math.floor(offset + EPS), 0) + 1);
  }

  private dayNumberOnOrAfterStart(date: ISODate): number {
    const day = toDayNumber(date);
    if (day < this.startDay) {
      throw new RangeError(`Date ${date} is before the project start ${fromDayNumber(this.startDay)}`);
    }
    return day;
  }

  private isWorking(day: number): boolean {
    return !this.weekend.has(dayOfWeek(day)) && !this.holidays.has(day);
  }

  private pushNext(): void {
    const day = this.cursor++;
    if (this.isWorking(day)) this.days.push(day);
  }

  private extendThrough(day: number): void {
    while (this.cursor <= day) this.pushNext();
  }

  /** Number of known working days with day number < `day` (binary search, lower bound). */
  private countBefore(day: number): number {
    let lo = 0;
    let hi = this.days.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((this.days[mid] as number) < day) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
}
