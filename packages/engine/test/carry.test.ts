import { describe, expect, it } from 'vitest';
import { buildThriveni, recordEvent, schedule, startProject } from '../src';
import type { Plan, Schedule } from '../src';
import { makeEvent, makePlan } from './helpers';

/** Carrying a forecast forward with no other change must reproduce it exactly (DESIGN.md §3.2). */
function expectSameForecast(actual: Schedule, expected: Schedule): void {
  expect(Object.keys(actual.tasks)).toEqual(Object.keys(expected.tasks));
  for (const [id, want] of Object.entries(expected.tasks)) {
    const got = actual.tasks[id];
    expect(got, id).toBeDefined();
    expect(got?.start, `${id} start`).toBeCloseTo(want.start, 6);
    expect(got?.finish, `${id} finish`).toBeCloseTo(want.finish, 6);
    expect(got?.totalFloat, `${id} float`).toBeCloseTo(want.totalFloat, 6);
    expect(got?.critical, `${id} critical`).toBe(want.critical);
    expect(got?.finishDate, `${id} date`).toBe(want.finishDate);
  }
  expect(actual.criticalPath).toEqual(expected.criticalPath);
  expect(actual.delivery.date).toBe(expected.delivery.date);
}

const noop = (id: string, asOf: string) => makeEvent(id, asOf, []);

const DATES = [
  '2026-10-05', '2026-10-06', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-12', '2026-10-14',
  '2026-10-20', '2026-10-27', '2026-11-03', '2026-11-10',
];

const thriveniWithDevCut = (): Plan => {
  const plan = buildThriveni();
  plan.capacity.push({ teamId: 'dev', from: '2026-10-14', headcount: 2 });
  return plan;
};

/** Fractional estimates and a 3 -> 2 headcount change (factor 2/3), the worst case for rounding drift. */
const awkwardPlan = (): Plan =>
  makePlan(
    [
      { id: 'a', est: 1.3 },
      { id: 'b', est: 2.7 },
      { id: 'c', est: 0.9, team: 'art' },
      { id: 'd', est: 3.1 },
      { id: 'e', est: 0.4, team: 'art' },
    ],
    [['a', 'b'], ['b', 'c'], ['d', 'c'], ['c', 'e']],
    { capacity: [{ teamId: 'dev', from: '2026-10-05', headcount: 3 }, { teamId: 'dev', from: '2026-10-07', headcount: 2 }] },
  );

describe.each([
  ['Thriveni', buildThriveni],
  ['Thriveni with a mid-project Dev cut', thriveniWithDevCut],
  ['fractional estimates with a 2/3 capacity factor', awkwardPlan],
])('carrying the forecast forward: %s', (_name, build) => {
  const baseline = schedule(build());

  it.each(DATES)('reproduces the baseline when jumping straight to %s', (asOf) => {
    const state = recordEvent(startProject(build()), noop('e', asOf));
    expectSameForecast(state.schedule, baseline);
    expect(state.snapshots[1]?.stepDays).toBe(0);
  });

  it('reproduces the baseline when stepping through every date in turn', () => {
    let state = startProject(build());
    DATES.forEach((asOf, i) => {
      state = recordEvent(state, noop(`e${i}`, asOf));
      expectSameForecast(state.schedule, baseline);
    });
    expect(state.snapshots.every((s) => s.variance === 0)).toBe(true);
  });
});

describe('what carrying forward decides', () => {
  const at = (asOf: string) => recordEvent(startProject(buildThriveni()), noop('e', asOf)).schedule;

  it('marks finished, started and untouched work as the previous forecast implies (end of Wed 14 Oct = offset 8)', () => {
    const s = at('2026-10-14');
    expect(s.statusOffset).toBe(8);
    expect(s.tasks['m1.sb']?.state).toBe('DONE');
    expect(s.tasks['m5.art']?.state).toBe('DONE'); // finished at 7
    expect(s.tasks['m5.dev']?.state).toBe('IN_PROGRESS'); // started at 7
    expect(s.tasks['m5.dev']?.remainingEffort).toBe(5); // 6 days, 1 burned
    expect(s.tasks['m1.dev']?.remainingEffort).toBe(2); // 5 days from offset 5, 3 burned
    expect(s.tasks['m2.alpha']?.state).toBe('NOT_STARTED'); // due at 9
    expect(s.tasks['proj.review']?.state).toBe('NOT_STARTED');
  });

  it('finishes a milestone once the status date reaches it', () => {
    expect(at('2026-10-15').tasks['m2.alpha']?.state).toBe('DONE'); // offset 9
  });

  it('treats a task that starts exactly on the status date as not started', () => {
    expect(at('2026-10-13').tasks['m5.dev']?.state).toBe('NOT_STARTED'); // starts at 7, status 7
  });
});
