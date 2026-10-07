import { describe, expect, it } from 'vitest';
import {
  attributeDelay,
  buildThriveni,
  buildTimeline,
  explainSnapshot,
  findAdvisories,
  recordEvent,
  slackToTarget,
  startProject,
} from '../src';
import type { CalendarSpec, ForecastSnapshot, ProjectState } from '../src';
import { extinguisherEffects, makeEvent, sharedExtinguisherEffects } from './helpers';

const fresh = () => startProject(buildThriveni());
const last = (s: ProjectState): ForecastSnapshot => s.snapshots[s.snapshots.length - 1] as ForecastSnapshot;
const extinguisherAdvisory = (s: ProjectState) => findAdvisories(s.plan).filter((a) => a.featureId === 'extinguisher');

/** The extinguisher as the team experienced it: one shared 2-day effort, found late, linked to the feature. */
const shared = () =>
  makeEvent('ext', '2026-10-14', sharedExtinguisherEffects(), {
    type: 'SCOPE_CHANGE',
    title: 'Extinguisher system',
    linkedFeatureId: 'extinguisher',
  });

describe('the extinguisher as one shared effort', () => {
  const before = fresh();
  const after = recordEvent(before, shared());
  const snap = last(after);

  it('costs 2 effort-days and 2 days of delivery: Fri 30 Oct becomes Tue 3 Nov', () => {
    expect(snap.effortImpact).toBe(2);
    expect(snap.stepDays).toBe(2);
    expect(snap.forecastDelivery).toEqual({ offset: 22, date: '2026-11-03' });
  });

  it('sits on the critical path, between client changes and integration', () => {
    expect(snap.criticalPath).toContain('proj.ext');
    expect(snap.tasks['proj.ext']).toMatchObject({ start: 16, finish: 18, critical: true });
    expect(snap.tasks['proj.integration']?.start).toBe(18);
  });

  it('moves one lane, not seven: the delivery lane, caused directly', () => {
    const e = explainSnapshot(last(before), snap);
    expect(e.modules.map((m) => [m.moduleId, m.delta, m.origin])).toEqual([['project', 2, 'DIRECT']]);
  });

  it('still says which modules it is for: all seven use the extinguisher', () => {
    expect(snap.linkedModuleIds).toEqual(['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7']);
    expect(explainSnapshot(last(before), snap).linkedModuleIds).toEqual(['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7']);
  });

  it('is on the timeline as one delivery branch', () => {
    const tl = buildTimeline(after);
    expect(tl.branches.map((b) => b.moduleId)).toEqual(['project']);
    expect(tl.branches[0]).toMatchObject({ isDelivery: true, currentDelta: 2 });
  });

  it('is attributed as late scope discovery', () => {
    const a = attributeDelay(after);
    expect(a.byCategory).toEqual([{ category: 'Late scope discovery', days: 2, effortDays: 2, eventIds: ['ext'] }]);
  });
});

describe('the advisory', () => {
  it('fires for the extinguisher at the start: used by 7 modules, nothing shared', () => {
    expect(extinguisherAdvisory(fresh())).toHaveLength(1);
  });

  it('is resolved once the shared implementation exists, because the work is done once, outside any one module', () => {
    expect(extinguisherAdvisory(recordEvent(fresh(), shared()))).toEqual([]);
  });

  it('is not resolved by implementing it seven times inside the modules', () => {
    const perModule = recordEvent(
      fresh(),
      makeEvent(
        'per-module',
        '2026-10-14',
        extinguisherEffects().map((e) => (e.op === 'ADD_TASK' ? { ...e, task: { ...e.task, featureId: 'extinguisher' } } : e)),
      ),
    );
    expect(extinguisherAdvisory(perModule)).toHaveLength(1);
  });
});

describe('days to the client date', () => {
  const calendar = (holidays: string[] = []): CalendarSpec => ({ startDate: '2026-10-05', weekendDays: [0, 6], holidays });

  it('is positive when there is slack, zero on the day, negative when late', () => {
    expect(slackToTarget(calendar(), 20, '2026-10-30')).toBe(0);
    expect(slackToTarget(calendar(), 17, '2026-10-30')).toBe(3);
    expect(slackToTarget(calendar(), 22, '2026-10-30')).toBe(-2); // Tue 3 Nov
  });

  it('counts working days, so a weekend between is not a delay', () => {
    expect(slackToTarget(calendar(), 21, '2026-10-30')).toBe(-1); // Mon 2 Nov is one working day after Fri 30 Oct
  });

  it('uses the current calendar: a holiday before the date shortens the runway', () => {
    expect(slackToTarget(calendar(['2026-10-28']), 20, '2026-10-30')).toBe(-1);
  });

  it('is independent of variance: a plan with slack against the client date', () => {
    const plan = buildThriveni();
    // Plan finishes Fri 30 Oct but the client date is Fri 6 Nov: five working days of slack that no delay has used.
    const s = last(startProject(plan));
    expect(s.variance).toBe(0);
    expect(slackToTarget(plan.calendar, s.forecastDelivery.offset, '2026-11-06')).toBe(5);
  });
});
