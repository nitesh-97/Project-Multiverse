import { describe, expect, it } from 'vitest';
import {
  buildThriveni,
  buildTimeline,
  firstBreach,
  forecastDrift,
  milestoneHistory,
  recordEvent,
  startProject,
  voidEvent,
} from '../src';
import type { Event, ProjectState } from '../src';
import { adjust, extinguisherEffects, makeEvent } from './helpers';

const fresh = () => startProject(buildThriveni());
const run = (...events: Event[]): ProjectState => events.reduce(recordEvent, fresh());

// Status dates: Tue 13 Oct = offset 7, Wed 14 Oct = offset 8, Wed 21 Oct = offset 13, Thu 22 Oct = offset 14.
const t2 = () => makeEvent('t2', '2026-10-13', [adjust('m2.dev', 3)]);
const t3 = () => makeEvent('t3', '2026-10-14', [adjust('m5.dev', 1)]);
const hs = () => makeEvent('hs', '2026-10-14', extinguisherEffects());
/** M5 Dev finishes on its originally planned day (offset 13), undoing T3's slip. */
const m5Back = () => makeEvent('m5-back', '2026-10-21', [{ op: 'RECORD_PROGRESS', taskId: 'm5.dev', finishedOn: '2026-10-21' }]);
const qaLonger = () => makeEvent('qa+1', '2026-10-22', [adjust('proj.qa', 1)]);

const branchOf = (state: ProjectState, moduleId: string) => {
  const b = buildTimeline(state).branches.find((x) => x.moduleId === moduleId);
  if (!b) throw new Error(`no branch for ${moduleId}`);
  return b;
};

describe('the original line', () => {
  const tl = buildTimeline(fresh());

  it('is the baseline plan, with no branches and no markers', () => {
    expect(tl.original.delivery).toEqual({ offset: 20, date: '2026-10-30' });
    expect(tl.branches).toEqual([]);
    expect(tl.markers).toEqual([]);
    expect(tl.current).toEqual({ delivery: { offset: 20, date: '2026-10-30' }, variance: 0, asOf: null });
  });

  it('lists every module and milestone as originally planned', () => {
    expect(tl.original.modules).toHaveLength(9); // seven modules, shared, project
    expect(tl.original.modules.find((m) => m.moduleId === 'm5')).toEqual({
      moduleId: 'm5',
      name: 'Module 5',
      kind: 'DELIVERABLE',
      finish: { offset: 13, date: '2026-10-21' },
    });
    expect(tl.original.modules.find((m) => m.moduleId === 'shared')?.kind).toBe('SHARED');
    expect(tl.original.milestones).toHaveLength(8);
    expect(tl.original.milestones.find((m) => m.taskId === 'proj.delivery')).toMatchObject({
      name: 'Delivery',
      moduleId: 'project',
      baseline: { offset: 20, date: '2026-10-30' },
    });
  });
});

describe('T2: a module slips inside its float', () => {
  const state = run(t2());
  const tl = buildTimeline(state);

  it('gives only that module a branch, flagged as absorbed', () => {
    expect(tl.branches).toHaveLength(1);
    expect(tl.branches[0]).toEqual({
      moduleId: 'm2',
      moduleName: 'Module 2',
      isDelivery: false,
      forkAt: '2026-10-13',
      baselineFinish: { offset: 9, date: '2026-10-15' },
      currentFinish: { offset: 12, date: '2026-10-20' },
      currentDelta: 3,
      status: 'OPEN',
      steps: [
        {
          revision: 1,
          kind: 'EVENT',
          eventId: 't2',
          asOf: '2026-10-13',
          delta: 3,
          variance: 3,
          finishAfter: { offset: 12, date: '2026-10-20' },
          origin: 'DIRECT',
          fromModuleIds: [],
          deliveryDelta: 0,
          absorbed: true,
          onCriticalPath: false,
        },
      ],
    });
  });

  it('leaves delivery on the original date, with no delivery branch', () => {
    expect(tl.current.delivery.date).toBe('2026-10-30');
    expect(tl.branches.some((b) => b.isDelivery)).toBe(false);
  });

  it('records the event as a marker', () => {
    expect(tl.markers).toEqual([
      expect.objectContaining({ revision: 1, eventId: 't2', effortImpact: 3, stepDays: 0, absorbed: true, onCriticalPath: false, modulesMoved: 1, noScheduleEffect: false }),
    ]);
  });
});

describe('T3: a critical slip', () => {
  const tl = buildTimeline(run(t3()));

  it('branches the module and delivery, linked by where the delay came from', () => {
    expect(tl.branches.map((b) => b.moduleId)).toEqual(['m5', 'project']);
    const [m5, project] = tl.branches;
    expect(m5?.steps[0]).toMatchObject({ delta: 1, origin: 'DIRECT', fromModuleIds: [], onCriticalPath: true, absorbed: false });
    expect(project).toMatchObject({
      isDelivery: true,
      baselineFinish: { offset: 20, date: '2026-10-30' },
      currentFinish: { offset: 21, date: '2026-11-02' },
      currentDelta: 1,
    });
    expect(project?.steps[0]).toMatchObject({ delta: 1, origin: 'PROPAGATED', fromModuleIds: ['m5'], deliveryDelta: 1 });
  });
});

describe('the late extinguisher', () => {
  const tl = buildTimeline(run(hs()));

  it('branches all seven modules and delivery at the moment the event arrived', () => {
    expect(tl.branches).toHaveLength(8);
    expect(tl.branches.every((b) => b.forkAt === '2026-10-14')).toBe(true);
    expect(tl.branches.filter((b) => b.isDelivery).map((b) => b.moduleId)).toEqual(['project']);
    expect(tl.branches.filter((b) => b.moduleId.startsWith('m')).every((b) => b.currentDelta === 2 && b.steps[0]?.origin === 'DIRECT')).toBe(true);
    expect(tl.branches.find((b) => b.moduleId === 'project')?.steps[0]).toMatchObject({ origin: 'PROPAGATED', fromModuleIds: ['m5'], delta: 2 });
  });

  it('shows 14 effort-days against a 2-day schedule step', () => {
    expect(tl.markers).toEqual([expect.objectContaining({ eventId: 'hs', effortImpact: 14, stepDays: 2, onCriticalPath: true, modulesMoved: 8 })]);
  });
});

describe('a sequence of events', () => {
  const state = run(t2(), t3(), hs());
  const tl = buildTimeline(state);

  it('creates branches in the order modules first deviated, one per module', () => {
    expect(tl.branches.map((b) => b.moduleId)).toEqual(['m2', 'm5', 'project', 'm1', 'm3', 'm4', 'm6', 'm7']);
  });

  it('adds a step to a module each time an event moves it', () => {
    const m2 = branchOf(state, 'm2');
    expect(m2.steps.map((s) => [s.revision, s.delta, s.variance])).toEqual([[1, 3, 3], [3, 2, 5]]);
    expect(m2.forkAt).toBe('2026-10-13');
    const project = branchOf(state, 'project');
    expect(project.steps.map((s) => [s.revision, s.delta, s.variance])).toEqual([[2, 1, 1], [3, 2, 3]]);
    expect(project.currentFinish).toEqual({ offset: 23, date: '2026-11-04' });
  });

  it('has a marker for every event, and the original line is untouched', () => {
    expect(tl.markers.map((m) => [m.eventId, m.stepDays])).toEqual([['t2', 0], ['t3', 1], ['hs', 2]]);
    expect(tl.original.delivery).toEqual({ offset: 20, date: '2026-10-30' });
    expect(tl.current.variance).toBe(3);
  });

  it('is derived, so building it twice gives the same answer', () => {
    expect(buildTimeline(state)).toEqual(tl);
  });
});

describe('events that move nothing', () => {
  it('still appear as markers, with their effort', () => {
    // Evaluation (5d) is not the last task of the Shared module (Localization ends at 7), so +1 day changes no finish.
    const state = run(makeEvent('eval+1', '2026-10-06', [adjust('shared.eval', 1)]));
    const tl = buildTimeline(state);
    expect(tl.branches).toEqual([]);
    expect(tl.markers).toEqual([
      expect.objectContaining({ eventId: 'eval+1', effortImpact: 1, stepDays: 0, absorbed: false, modulesMoved: 0, noScheduleEffect: true }),
    ]);
  });
});

describe('recovery and re-opening', () => {
  const recovered = run(t3(), m5Back());

  it('merges a branch back when the module returns to its original date', () => {
    const m5 = branchOf(recovered, 'm5');
    expect(m5.steps.map((s) => s.delta)).toEqual([1, -1]);
    expect(m5).toMatchObject({ status: 'MERGED', currentDelta: 0, currentFinish: { offset: 13, date: '2026-10-21' } });
    expect(branchOf(recovered, 'project')).toMatchObject({ status: 'MERGED', currentDelta: 0 });
  });

  it('re-opens the same branch if the module deviates again', () => {
    const again = recordEvent(recovered, qaLonger());
    const project = branchOf(again, 'project');
    expect(buildTimeline(again).branches.filter((b) => b.moduleId === 'project')).toHaveLength(1);
    expect(project.steps.map((s) => [s.revision, s.delta])).toEqual([[1, 1], [2, -1], [3, 1]]);
    expect(project).toMatchObject({ status: 'OPEN', currentDelta: 1, currentFinish: { offset: 21, date: '2026-11-02' } });
    expect(project.steps[2]).toMatchObject({ origin: 'DIRECT' });
    expect(branchOf(again, 'm5').status).toBe('MERGED');
  });
});

describe('a voided event', () => {
  const state = voidEvent(run(hs()), { kind: 'VOID', id: 'v1', eventId: 'hs', asOf: '2026-10-15' });
  const tl = buildTimeline(state);

  it('adds a VOID step to each branch and merges them all', () => {
    expect(tl.branches).toHaveLength(8);
    for (const b of tl.branches) {
      expect(b.steps.map((s) => [s.kind, s.delta])).toEqual([['EVENT', 2], ['VOID', -2]]);
      expect(b.steps[1]?.eventId).toBe('hs');
      expect(b).toMatchObject({ status: 'MERGED', currentDelta: 0 });
    }
  });

  it('marks the void', () => {
    expect(tl.markers.map((m) => [m.kind, m.eventId, m.stepDays, m.effortImpact])).toEqual([
      ['EVENT', 'hs', 2, 14],
      ['VOID', 'hs', -2, -14],
    ]);
  });
});

describe('derived views', () => {
  it('forecastDrift lists the delivery forecast at every revision', () => {
    const drift = forecastDrift(run(t2(), t3(), hs()));
    expect(drift.map((d) => d.forecastDelivery.date)).toEqual(['2026-10-30', '2026-10-30', '2026-11-02', '2026-11-04']);
    expect(drift.map((d) => d.stepDays)).toEqual([0, 0, 1, 2]);
    expect(drift.map((d) => d.eventId)).toEqual([null, 't2', 't3', 'hs']);
  });

  it('milestoneHistory shows how one milestone moved', () => {
    const state = run(t2(), t3(), hs());
    expect(milestoneHistory(state, 'proj.delivery').map((p) => p.forecast.date)).toEqual([
      '2026-10-30', '2026-10-30', '2026-11-02', '2026-11-04',
    ]);
    expect(milestoneHistory(state, 'proj.delivery').every((p) => p.baseline?.date === '2026-10-30')).toBe(true);
    expect(milestoneHistory(run(t2()), 'm2.alpha').map((p) => [p.revision, p.forecast.offset])).toEqual([[0, 9], [1, 12]]);
    expect(milestoneHistory(state, 'no-such-task')).toEqual([]);
  });

  it('firstBreach finds the first snapshot that is later than the original date', () => {
    expect(firstBreach(fresh())).toBeNull();
    expect(firstBreach(run(t2()))).toBeNull(); // absorbed
    expect(firstBreach(run(t2(), t3(), hs()))).toEqual({
      revision: 2,
      eventId: 't3',
      asOf: '2026-10-14',
      variance: 1,
      forecastDelivery: { offset: 21, date: '2026-11-02' },
    });
  });
});
