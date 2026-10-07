/**
 * Calendar dates as `YYYY-MM-DD` strings, the same as the engine. Everything here works on whole days in UTC, so the
 * result never depends on the viewer's time zone.
 */

const DAY_MS = 86_400_000;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const WEEKDAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'] as const;

/** Whole days since 1970-01-01. */
export function dayNumber(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return Math.round(Date.UTC(y, m - 1, d) / DAY_MS);
}

export function fromDayNumber(n: number): string {
  const d = new Date(n * DAY_MS);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

export const addDays = (iso: string, n: number): string => fromDayNumber(dayNumber(iso) + n);

/** Calendar days from `a` to `b` (negative if `b` is earlier). */
export const daysBetween = (a: string, b: string): number => dayNumber(b) - dayNumber(a);

/** 0 = Sunday ... 6 = Saturday, as in the project calendar. */
export function weekday(iso: string): number {
  return new Date(dayNumber(iso) * DAY_MS).getUTCDay();
}

export interface CalendarLike {
  weekendDays: readonly number[];
  holidays: readonly string[];
}

export const isWeekend = (iso: string, cal: CalendarLike): boolean => cal.weekendDays.includes(weekday(iso));
export const isHoliday = (iso: string, cal: CalendarLike): boolean => cal.holidays.includes(iso);
export const isWorkingDay = (iso: string, cal: CalendarLike): boolean => !isWeekend(iso, cal) && !isHoliday(iso, cal);

function parts(iso: string): { y: number; m: number; d: number; wd: number } {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return { y, m, d, wd: weekday(iso) };
}

/** "Wed 14 Oct". Add the year with `{ year: true }`. */
export function formatDate(iso: string, options: { year?: boolean } = {}): string {
  const { y, m, d, wd } = parts(iso);
  return `${WEEKDAYS[wd]} ${d} ${MONTHS[m - 1]}${options.year ? ` ${y}` : ''}`;
}

/** "Wednesday 14 October 2026". */
export function formatLongDate(iso: string): string {
  const { y, m, d, wd } = parts(iso);
  return `${WEEKDAYS_LONG[wd]} ${d} ${MONTHS_LONG[m - 1]} ${y}`;
}

/** "14 Oct", for axis ticks. */
export function formatShortDate(iso: string): string {
  const { m, d } = parts(iso);
  return `${d} ${MONTHS[m - 1]}`;
}

export const WEEKDAY_INITIALS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'] as const;
