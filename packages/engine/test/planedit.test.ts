import { describe, expect, it } from 'vitest';
import {
  EffectError,
  PLANNING,
  attributeDelay,
  buildHistory,
  buildThriveni,
  buildTimeline,
  counterfactualStrategy,
  explainSnapshot,
  previewPlanEdit,
  recordEvent,
  recordPlanEdit,
  startProject,
  voidEvent,
} from '../src';
import type { ForecastSnapshot, ProjectState } from '../src';
import { adjust, makeEvent, makePlanEdit } from './helpers';

const fresh = () => startProject(buildThriveni());
const last = (s: ProjectState): ForecastSnapshot => s.snapshots[s.snapshots.length - 1] as ForecastSnapshot;

// Status dates: Sun 4 Oct = before the project starts, Mon 5 Oct = offset 1, Tue 6 Oct = offset 2.
/** M7 development 5 -> 8 days: M7 now takes 14 days to Alpha, longer than M5's 13, so the plan itself gets a day longer. */
const longerM7 = (asOf = '2026-10-06') => makePlanEdit('longer-m7', asOf, [adjust('m7.dev', 3) as never], { title: 'M7 dev re-estimated', reason: 'new scope agreed with client' });
/** M5 development +1 day, recorded on the first day of the project. */
const m5Slip = () => makeEvent('m5-slip', '2026-10-05', [adjust('m5.dev', 1)], { type: 'DEPENDENCY_DELAY' });

describe('a plan edit on its own', () => {
  const before = fresh();
  const after = recordPlanEdit(before, longerM7());
  const snap = last(after);

  it('is a PLAN snapshot that moves the plan: delivery Fri 30 Oct becomes Mon 2 Nov', () => {
    expect(snap).toMatchObject({ revision: 1, kind: 'PLAN', eventId: null, planEditId: 'longer-m7', asOf: '2026-10-06' });
    expect(snap.baselineDelivery).toEqual({ offset: 21, date: '2026-11-02' });
    expect(snap.baselineStepDays).toBe(1);
  });

  it('is planning, not delay: the forecast moves with it, so variance does not', () => {
    expect(snap.forecastDelivery).toEqual({ offset: 21, date: '2026-11-02' });
    expect(snap.variance).toBe(0);
    expect(snap.stepDays).toBe(0);
    expect(snap.effortImpact).toBe(3);
  });

  it('keeps the original plan as it was, in revision 0 and in `origin`', () => {
    expect(after.snapshots[0]?.baselineDelivery.date).toBe('2026-10-30');
    expect(after.origin.tasks.find((t) => t.id === 'm7.dev')?.estimate).toBe(5);
    expect(after.baseline.tasks.find((t) => t.id === 'm7.dev')?.estimate).toBe(8);
    expect(after.plan.tasks.find((t) => t.id === 'm7.dev')?.estimate).toBe(8);
  });

  it('is on the timeline: the original line stays, the plan line moves, and the edit is a marker', () => {
    const tl = buildTimeline(after);
    expect(tl.original.delivery.date).toBe('2026-10-30');
    expect(tl.current.planDelivery).toEqual({ offset: 21, date: '2026-11-02' });
    expect(tl.branches).toEqual([]); // nothing deviated from the plan
    expect(tl.markers).toEqual([
      expect.objectContaining({ revision: 1, kind: 'PLAN', eventId: 'longer-m7', baselineStepDays: 1, stepDays: 0, effortImpact: 3, noScheduleEffect: true }),
    ]);
  });

  it('is explained with the edit named and the plan movement shown', () => {
    const e = explainSnapshot(last(before), snap);
    expect(e).toMatchObject({ kind: 'PLAN', planEditId: 'longer-m7', eventId: null, baselineStepDays: 1, stepDays: 0 });
  });

  it('rebuilds identically from the log', () => {
    expect(buildHistory(buildThriveni(), after.log).snapshots).toEqual(after.snapshots);
  });

  it('never modifies the state it was given', () => {
    const frozen = JSON.stringify(before);
    recordPlanEdit(before, longerM7());
    expect(JSON.stringify(before)).toBe(frozen);
  });

  it('can be previewed without recording', () => {
    const frozen = JSON.stringify(before);
    const preview = previewPlanEdit(before, longerM7());
    expect(preview).toMatchObject({ kind: 'PLAN', baselineStepDays: 1, effortImpact: 3 });
    expect(JSON.stringify(before)).toBe(frozen);
  });
});

describe('a plan edit after a slip', () => {
  const state = [m5Slip()].reduce(recordEvent, fresh());
  const after = recordPlanEdit(state, longerM7());

  it('absorbs the slip: the delay that was +1 against the old plan is 0 against the refined plan', () => {
    expect(last(state).variance).toBe(1);
    expect(last(after).variance).toBe(0);
    expect(last(after).stepDays).toBe(-1);
    expect(last(after).baselineStepDays).toBe(1);
    expect(last(after).forecastDelivery.date).toBe('2026-11-02');
  });

  it('is attributed honestly: the slip +1 and the planning change -1, adding to 0', () => {
    const a = attributeDelay(after);
    expect(a.totalVariance).toBe(0);
    expect(a.contributions.map((c) => [c.eventId, c.kind, c.days, c.category])).toEqual([
      ['m5-slip', 'EVENT', 1, 'Dependency delays'],
      ['longer-m7', 'PLAN', -1, PLANNING],
    ]);
    expect(a.interaction).toBe(0);
  });

  it('counterfactual: removing the slip saves nothing, removing the edit would leave the delay, and the overlap is shown', () => {
    const a = attributeDelay(after, { strategy: counterfactualStrategy });
    expect(a.contributions.map((c) => [c.eventId, c.days])).toEqual([['m5-slip', 0], ['longer-m7', -1]]);
    expect(a.interaction).toBe(1);
    expect(a.contributions.reduce((s, c) => s + c.days, 0) + a.interaction).toBe(a.totalVariance);
  });

  it('survives voiding an event: the plan edit stays in force', () => {
    const withLater = recordEvent(after, makeEvent('m2-slip', '2026-10-13', [adjust('m2.dev', 3)], { type: 'TASK_DELAY' }));
    const voided = voidEvent(withLater, { kind: 'VOID', id: 'v', eventId: 'm2-slip', asOf: '2026-10-14' });
    expect(voided.baseline.tasks.find((t) => t.id === 'm7.dev')?.estimate).toBe(8); // still refined
    expect(last(voided).baselineDelivery.date).toBe('2026-11-02');
    expect(last(voided).variance).toBe(0);
    expect(voided.activeEntries.map((e) => (e.kind === 'EVENT' ? e.event.id : e.edit.id))).toEqual(['m5-slip', 'longer-m7']);
  });

  it('voiding the slip leaves the plan edit alone, and attribution still adds up', () => {
    const voided = voidEvent(after, { kind: 'VOID', id: 'v', eventId: 'm5-slip', asOf: '2026-10-07' });
    expect(last(voided).variance).toBe(0);
    const a = attributeDelay(voided);
    expect(a.contributions.map((c) => [c.eventId, c.days])).toEqual([['longer-m7', 0]]);
  });
});

describe('plan edits that shorten or add', () => {
  it('removing work before it starts shortens the plan: M5 loses its storyboard, M3 now sets the pace', () => {
    // Sun 4 Oct is before the project starts, so nothing has begun.
    const r = recordPlanEdit(fresh(), makePlanEdit('no-m5-sb', '2026-10-04', [{ op: 'REMOVE_TASK', taskId: 'm5.sb' }]));
    expect(last(r).baselineDelivery).toEqual({ offset: 19, date: '2026-10-29' });
    expect(last(r).baselineStepDays).toBe(-1);
    expect(last(r).variance).toBe(0);
    expect(last(r).effortImpact).toBe(-3);
  });

  it('adding a task refines the plan in the same way', () => {
    const edit = makePlanEdit('add-review', '2026-10-06', [
      { op: 'ADD_TASK', task: { id: 'm3.review', moduleId: 'm3', teamId: 'lxd', kind: 'TASK', name: 'M3 review', estimate: 3 }, dependsOn: ['m3.dev'], blocks: ['m3.alpha'] },
    ]);
    const r = last(recordPlanEdit(fresh(), edit));
    expect(r.baselineDelivery).toEqual({ offset: 22, date: '2026-11-03' }); // M3: 12 + 3 = 15 > M5's 13, so +2
    expect(r.baselineStepDays).toBe(2);
    expect(r.variance).toBe(0);
  });
});

describe('plan edits that are refused', () => {
  const run = (edit = longerM7(), state = fresh()) => () => recordPlanEdit(state, edit);

  it('work that has already started cannot be re-planned: that is an event', () => {
    // By Wed 14 Oct the forecast has M7 development under way.
    const started = longerM7('2026-10-14');
    expect(run(started)).toThrow(EffectError);
    expect(run(started)).toThrow(/Plan edit longer-m7: Effect 1 \(ADJUST_ESTIMATE\): .*already started/);
  });

  it('only planning changes are allowed: capacity, actuals and the calendar are events', () => {
    const bad = makePlanEdit('cap', '2026-10-06', [{ op: 'SET_CAPACITY', teamId: 'dev', from: '2026-10-14', headcount: 2 } as never]);
    expect(run(bad)).toThrow(/SET_CAPACITY is not a planning change; record it as an event/);
    const hol = makePlanEdit('hol', '2026-10-06', [{ op: 'ADD_HOLIDAY', date: '2026-10-28' } as never]);
    expect(run(hol)).toThrow(/ADD_HOLIDAY is not a planning change/);
  });

  it('cannot touch work that an event added: the plan has never heard of it', () => {
    // x.new waits for M7 development, so it has not started and only its absence from the plan can stop the edit.
    const state = recordEvent(
      fresh(),
      makeEvent('adds', '2026-10-05', [
        { op: 'ADD_TASK', task: { id: 'x.new', moduleId: 'm7', teamId: 'lxd', kind: 'TASK', name: 'New', estimate: 1 }, dependsOn: ['m7.dev'], blocks: [] },
      ]),
    );
    expect(run(makePlanEdit('touch-new', '2026-10-06', [adjust('x.new', 1) as never]), state)).toThrow(/unknown task x.new/);
  });

  it('refuses a reused id, an invalid date, and a failed edit leaves the state alone', () => {
    const once = recordPlanEdit(fresh(), longerM7());
    expect(run(longerM7('2026-10-07'), once)).toThrow(/id already used/);
    expect(run({ ...longerM7(), asOf: 'soon' })).toThrow(/invalid asOf/);
    expect(once.snapshots).toHaveLength(2);
  });

  it('an id may not be reused across events, plan edits and voids', () => {
    const state = recordEvent(fresh(), makeEvent('same', '2026-10-05', []));
    expect(run(makePlanEdit('same', '2026-10-06', [adjust('m7.dev', 1) as never]), state)).toThrow(/id already used/);
  });
});

describe('status dates', () => {
  it('a plan edit is clamped to the latest status date like any other entry', () => {
    const state = recordEvent(fresh(), makeEvent('later', '2026-10-06', []));
    const r = recordPlanEdit(state, makePlanEdit('early', '2026-10-05', [adjust('m7.dev', 1) as never]));
    expect(last(r).asOf).toBe('2026-10-06');
  });
});
