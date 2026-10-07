import { describe, expect, it } from 'vitest';
import { buildThriveni, recordEvent, startProject } from '../src';
import type { ForecastSnapshot, ProjectState } from '../src';
import { makeEvent } from './helpers';

const fresh = () => startProject(buildThriveni());
const last = (s: ProjectState): ForecastSnapshot => s.snapshots[s.snapshots.length - 1] as ForecastSnapshot;
const record = (id: string, asOf: string, taskId: string, finishedOn: string) =>
  makeEvent(id, asOf, [{ op: 'RECORD_PROGRESS', taskId, finishedOn }], { type: 'TASK_COMPLETION' });
const progressOf = (s: ProjectState, id: string) => s.plan.tasks.find((t) => t.id === id)?.progress;

/**
 * M5: storyboard 0-3, art 3-7, development 7-13. Between events the forecast assumes this happened. When someone
 * records that an earlier task really finished later, the work after it cannot have started when the old forecast said.
 */
describe('a task recorded as finishing later than the forecast assumed', () => {
  it('pushes the work after it: art finished on Thu 15 Oct (offset 9) instead of Tue 13 Oct (7), so delivery is 2 days late', () => {
    const s = recordEvent(fresh(), record('late-art', '2026-10-15', 'm5.art', '2026-10-15'));
    expect(last(s).forecastDelivery).toEqual({ offset: 22, date: '2026-11-03' });
    expect(last(s).stepDays).toBe(2);
    expect(s.schedule.tasks['m5.dev']).toMatchObject({ start: 9, finish: 15, state: 'NOT_STARTED' });
  });

  it('is accurate when recorded afterwards: development started when art really finished, not on the day it was told', () => {
    // Recorded on Tue 20 Oct (offset 12), but art finished on Thu 15 Oct (9). Development has been running since then.
    const s = recordEvent(fresh(), record('late-art', '2026-10-20', 'm5.art', '2026-10-15'));
    expect(last(s).forecastDelivery).toEqual({ offset: 22, date: '2026-11-03' }); // not 25, which "starts today" would give
    expect(s.schedule.tasks['m5.dev']).toMatchObject({ state: 'IN_PROGRESS', start: 9, finish: 15 });
    expect(progressOf(s, 'm5.dev')).toMatchObject({ startedAt: 9, remaining: 3, assumed: true });
  });

  it('carries a delay through a chain of assumed work: storyboard 2 days late delays everything after it', () => {
    const s = recordEvent(fresh(), record('late-sb', '2026-10-14', 'm5.sb', '2026-10-09')); // offset 5, forecast 3
    expect(last(s).forecastDelivery).toEqual({ offset: 22, date: '2026-11-03' });
    expect(s.schedule.tasks['m5.art']).toMatchObject({ state: 'IN_PROGRESS', start: 5, finish: 9 });
    expect(s.schedule.tasks['m5.dev']).toMatchObject({ state: 'NOT_STARTED', start: 9 });
  });

  it('leaves work someone recorded alone: reality wins over a later correction of its predecessor', () => {
    const s = [
      makeEvent('dev-started', '2026-10-15', [{ op: 'RECORD_PROGRESS', taskId: 'm5.dev', startedOn: '2026-10-14', remaining: 5 }]),
      record('late-art', '2026-10-15', 'm5.art', '2026-10-15'),
    ].reduce(recordEvent, fresh());
    expect(progressOf(s, 'm5.dev')).toMatchObject({ startedOn: '2026-10-14', remaining: 5 });
    expect(last(s).forecastDelivery.offset).toBe(21); // 9 + 5 = 14 for development: only the recorded numbers count
  });
});

describe('a task recorded as finishing no later than forecast', () => {
  it('changes nothing about the work after it: finishing early does not start the next task early', () => {
    const s = recordEvent(fresh(), record('early-art', '2026-10-14', 'm5.art', '2026-10-12')); // offset 6, forecast 7
    expect(last(s).forecastDelivery).toEqual({ offset: 20, date: '2026-10-30' });
    expect(last(s).stepDays).toBe(0);
    expect(s.schedule.tasks['m5.dev']?.start).toBe(7);
  });

  it('on the forecast date is a plain confirmation', () => {
    const s = recordEvent(fresh(), record('on-time', '2026-10-14', 'm5.art', '2026-10-13'));
    expect(last(s).forecastDelivery.offset).toBe(20);
    expect(progressOf(s, 'm5.art')?.assumed).toBeUndefined();
    expect(progressOf(s, 'm5.dev')?.assumed).toBe(true); // still only assumed
  });
});

describe('a task recorded as not finished after all', () => {
  it('stops the work after it from having started', () => {
    // The forecast had storyboard finished by 14 Oct. Someone records it started on 5 Oct with 2 days still to do.
    const s = recordEvent(
      fresh(),
      makeEvent('not-done', '2026-10-14', [{ op: 'RECORD_PROGRESS', taskId: 'm5.sb', startedOn: '2026-10-05', remaining: 2 }]),
    );
    expect(s.schedule.tasks['m5.sb']).toMatchObject({ state: 'IN_PROGRESS', finish: 10 }); // offset 8 + 2
    expect(s.schedule.tasks['m5.art']).toMatchObject({ state: 'NOT_STARTED', start: 10 });
    expect(last(s).forecastDelivery.offset).toBe(10 + 4 + 6 + 1 + 2 + 1 + 2 + 1); // sb -> art -> dev -> alpha -> ... -> delivery
  });
});
