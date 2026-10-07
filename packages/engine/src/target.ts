import { WorkCalendar, snap } from './calendar';
import type { CalendarSpec, ISODate, WorkDays } from './types';

/**
 * Working days of slack between a forecast delivery and the date promised to the client. Positive: finishing early
 * (days to spare). Negative: finishing late. Zero: finishing on the day. Counted in `calendar`'s working days.
 *
 * This is separate from variance, which compares the forecast with the *plan*. The two differ whenever the plan
 * itself had slack against the client date, or has been refined since.
 */
export function slackToTarget(calendar: CalendarSpec, forecastOffset: number, targetDate: ISODate): WorkDays {
  return snap(new WorkCalendar(calendar).endOffsetClamped(targetDate) - forecastOffset);
}
