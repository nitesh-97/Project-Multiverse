import { describe, expect, it } from 'vitest';
import {
  EffectError,
  attributeDelay,
  buildHistory,
  buildThriveni,
  buildTimeline,
  explainSnapshot,
  rebaseOffset,
  recordEvent,
  sameCalendar,
  startProject,
  voidEvent,
} from '../src';
import type { CalendarSpec, ForecastSnapshot, ProjectState } from '../src';
import { holiday, makeEvent } from './helpers';

const fresh = () => startProject(buildThriveni());
const last = (s: ProjectState): ForecastSnapshot => s.snapshots[s.snapshots.length - 1] as ForecastSnapshot;
const cal = (holidays: string[] = []): CalendarSpec => ({ startDate: '2026-10-05', weekendDays: [0, 6], holidays });

/** The PM adds Wed 28 Oct as a holiday on Wed 14 Oct. */
const hol = (date = '2026-10-28', on = '2026-10-14', id = 'hol') =>
  makeEvent(id, on, [holiday(date)], { type: 'RESOURCE_CHANGE', title: `Holiday ${date}` });

describe('re-expressing an offset in another calendar', () => {
  it('moves offsets that lie after a new holiday, and only those', () => {
    const withHoliday = cal(['2026-10-28']);
    expect(rebaseOffset(20, cal(), withHoliday)).toBe(19); // Fri 30 Oct is now the 19th working day
    expect(rebaseOffset(13, cal(), withHoliday)).toBe(13); // Wed 21 Oct is before it
    expect(rebaseOffset(0, cal(), withHoliday)).toBe(0);
  });

  it('keeps the unused part of a finishing day', () => {
    expect(rebaseOffset(19.5, cal(), cal(['2026-10-28']))).toBe(18.5);
  });

  it('is the identity when the calendars are the same, whatever the order of their parts', () => {
    expect(rebaseOffset(20, cal(['2026-10-28', '2026-11-03']), cal(['2026-11-03', '2026-10-28']))).toBe(20);
    expect(sameCalendar({ ...cal(), weekendDays: [6, 0] }, cal())).toBe(true);
    expect(sameCalendar(cal(['2026-10-28']), cal())).toBe(false);
  });
});

describe('a holiday added during the project', () => {
  const before = fresh();
  const after = recordEvent(before, hol());
  const snap = last(after);

  it('pushes delivery later by a working day: Fri 30 Oct becomes Mon 2 Nov', () => {
    expect(snap.forecastDelivery).toEqual({ offset: 20, date: '2026-11-02' });
    expect(snap.baselineDelivery).toEqual({ offset: 20, date: '2026-10-30' }); // the plan as made, under the old calendar
    expect(snap.stepDays).toBe(1);
    expect(snap.variance).toBe(1);
    expect(snap.effortImpact).toBe(0);
    expect(snap.calendar.holidays).toEqual(['2026-10-28']);
  });

  it('counts the delay in the new calendar, so modules finishing before the holiday are untouched', () => {
    expect(snap.modules.m5?.variance).toBe(0); // Alpha on Wed 21 Oct
    expect(snap.modules.project?.variance).toBe(1);
  });

  it('is explained as a calendar change that moved only the work after the holiday', () => {
    const e = explainSnapshot(last(before), snap);
    expect(e.stepDays).toBe(1);
    expect(e.modules.map((m) => [m.moduleId, m.delta])).toEqual([['project', 1]]);
    const moved = e.tasks.filter((t) => t.change === 'MOVED').map((t) => t.taskId).sort();
    expect(moved).toEqual(['proj.beta', 'proj.delivery', 'proj.qa']);
    expect(e.tasks.every((t) => t.finishDelta === 1 || t.change !== 'MOVED')).toBe(true);
  });

  it('creates a delivery branch, directly caused', () => {
    const tl = buildTimeline(after);
    expect(tl.branches.map((b) => b.moduleId)).toEqual(['project']);
    expect(tl.branches[0]).toMatchObject({ isDelivery: true, currentDelta: 1, currentFinish: { offset: 20, date: '2026-11-02' } });
    expect(tl.branches[0]?.steps[0]).toMatchObject({ origin: 'DIRECT' });
  });

  it('is attributed to capacity, and the shares add up', () => {
    const a = attributeDelay(after);
    expect(a.totalVariance).toBe(1);
    expect(a.byCategory).toEqual([{ category: 'Capacity changes', days: 1, effortDays: 0, eventIds: ['hol'] }]);
  });

  it('survives later events with no change to the forecast', () => {
    const later = recordEvent(after, makeEvent('noop', '2026-10-20', []));
    expect(last(later).forecastDelivery).toEqual({ offset: 20, date: '2026-11-02' });
    expect(last(later).variance).toBe(1);
    expect(last(later).stepDays).toBe(0);
  });

  it('can be voided: delivery goes back to Fri 30 Oct', () => {
    const voided = voidEvent(after, { kind: 'VOID', id: 'v', eventId: 'hol', asOf: '2026-10-15' });
    expect(last(voided).forecastDelivery.date).toBe('2026-10-30');
    expect(last(voided).variance).toBe(0);
    expect(last(voided).calendar.holidays).toEqual([]);
  });

  it('rebuilds identically from the log', () => {
    expect(buildHistory(buildThriveni(), after.log).snapshots).toEqual(after.snapshots);
  });
});

describe('more than one holiday', () => {
  it('each one costs a day while it is before delivery', () => {
    const state = [hol('2026-10-28', '2026-10-14', 'h1'), hol('2026-10-29', '2026-10-15', 'h2')].reduce(recordEvent, fresh());
    expect(last(state).forecastDelivery).toEqual({ offset: 20, date: '2026-11-03' });
    expect(last(state).variance).toBe(2);
    expect(last(state).stepDays).toBe(1);
  });

  it('a holiday after delivery changes nothing', () => {
    const state = recordEvent(fresh(), hol('2026-11-10'));
    expect(last(state).forecastDelivery.date).toBe('2026-10-30');
    expect(last(state).variance).toBe(0);
  });

  it('a holiday already in the baseline calendar is simply part of the plan', () => {
    const plan = buildThriveni();
    plan.calendar.holidays = ['2026-10-28'];
    const s = last(startProject(plan));
    expect(s.forecastDelivery).toEqual({ offset: 20, date: '2026-11-02' });
    expect(s.variance).toBe(0);
  });

  it('a task constrained to a date keeps that date', () => {
    const plan = buildThriveni();
    const t = plan.tasks.find((x) => x.id === 'proj.qa');
    if (t) t.startNoEarlierThan = '2026-10-29';
    const state = recordEvent(startProject(plan), hol('2026-10-28'));
    expect(last(state).tasks['proj.qa']?.startDate).toBe('2026-10-29');
  });
});

describe('holidays that cannot be added', () => {
  const run = (date: string, on = '2026-10-14') => () => recordEvent(fresh(), hol(date, on));

  it('not on a weekend or a day that is already a holiday', () => {
    expect(run('2026-10-24')).toThrow(/already a non-working day/);
    const once = recordEvent(fresh(), hol());
    expect(() => recordEvent(once, hol('2026-10-28', '2026-10-15', 'again'))).toThrow(/already a non-working day/);
  });

  it('not on or before the status date: history is not rewritten', () => {
    expect(run('2026-10-14')).toThrow(/not after the status date 2026-10-14/);
    expect(run('2026-10-08')).toThrow(/not after the status date/);
  });

  it('not with an invalid date, and the error names the event', () => {
    expect(run('28/10/2026')).toThrow(EffectError);
    expect(run('28/10/2026')).toThrow(/Event hol: Effect 1 \(ADD_HOLIDAY\): invalid date/);
  });
});
