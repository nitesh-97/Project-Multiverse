import { describe, expect, it } from 'vitest';
import {
  EffectError,
  buildHistory,
  buildThriveni,
  explainSnapshot,
  previewEvent,
  recordEvent,
  startProject,
  voidEvent,
} from '../src';
import type { ForecastSnapshot, LogEntry, ProjectState } from '../src';
import { adjust, extinguisherEffects, makeEvent } from './helpers';

const fresh = () => startProject(buildThriveni());
const last = (s: ProjectState): ForecastSnapshot => s.snapshots[s.snapshots.length - 1] as ForecastSnapshot;
const explain = (before: ProjectState, after: ProjectState) =>
  explainSnapshot(last(before), last(after));

// Status dates used below: Tue 13 Oct = offset 7, Wed 14 Oct = offset 8, Fri 16 Oct = offset 10.
const t2 = () => makeEvent('t2', '2026-10-13', [adjust('m2.dev', 3)], { type: 'TASK_DELAY' });
const t3 = () => makeEvent('t3', '2026-10-14', [adjust('m5.dev', 1)], { type: 'TASK_DELAY' });
const t4 = () => makeEvent('t4', '2026-10-14', [adjust('m3.dev', 3)], { type: 'TASK_DELAY' });
const hs = () => makeEvent('hs', '2026-10-14', extinguisherEffects(), { type: 'FEEDBACK', linkedFeatureId: 'extinguisher' });

describe('revision 0: the baseline', () => {
  const s = last(fresh());

  it('is the original plan with no variance', () => {
    expect(s.revision).toBe(0);
    expect(s.kind).toBe('BASELINE');
    expect(s.asOf).toBeNull();
    expect(s.forecastDelivery).toEqual({ offset: 20, date: '2026-10-30' });
    expect(s.baselineDelivery).toEqual({ offset: 20, date: '2026-10-30' });
    expect(s.variance).toBe(0);
    expect(s.stepDays).toBe(0);
    expect(s.engineVersion).toBeTruthy();
  });

  it('records each module and milestone against its baseline', () => {
    expect(s.modules.m5).toMatchObject({ baselineFinish: 13, forecastFinish: 13, variance: 0 });
    expect(s.milestones['proj.delivery']).toEqual({
      baseline: { offset: 20, date: '2026-10-30' },
      forecast: { offset: 20, date: '2026-10-30' },
    });
    expect(Object.keys(s.milestones)).toHaveLength(8); // seven alphas and delivery
  });
});

describe('T2: a delay inside the float', () => {
  const before = fresh();
  const after = recordEvent(before, t2());
  const snap = last(after);

  it('slips the module but not delivery', () => {
    expect(snap.forecastDelivery.date).toBe('2026-10-30');
    expect(snap.stepDays).toBe(0);
    expect(snap.effortImpact).toBe(3);
    expect(snap.modules.m2).toMatchObject({ baselineFinish: 9, forecastFinish: 12, variance: 3 });
    expect(snap.tasks['m2.dev']?.state).toBe('IN_PROGRESS');
  });

  it('is explained as absorbed by float', () => {
    const e = explain(before, after);
    expect(e.absorbed).toBe(true);
    expect(e.onCriticalPath).toBe(false);
    expect(e.criticalPath.changed).toBe(false);
    expect(e.modules).toEqual([
      expect.objectContaining({ moduleId: 'm2', delta: 3, origin: 'DIRECT', absorbed: true, deliveryDelta: 0, onCriticalPath: false }),
    ]);
  });
});

describe('T3: a critical delay', () => {
  const before = fresh();
  const after = recordEvent(before, t3());
  const snap = last(after);

  it('moves delivery across the weekend', () => {
    expect(snap.forecastDelivery).toEqual({ offset: 21, date: '2026-11-02' });
    expect(snap.stepDays).toBe(1);
    expect(snap.variance).toBe(1);
  });

  it('is explained as a direct slip in M5 that propagates to delivery', () => {
    const e = explain(before, after);
    expect(e.absorbed).toBe(false);
    expect(e.onCriticalPath).toBe(true);
    expect(e.criticalPath.changed).toBe(false);
    expect(e.delivery).toEqual({ before: '2026-10-30', after: '2026-11-02' });
    expect(e.modules).toEqual([
      expect.objectContaining({ moduleId: 'm5', delta: 1, origin: 'DIRECT', fromModuleIds: [], absorbed: false, onCriticalPath: true }),
      expect.objectContaining({ moduleId: 'project', delta: 1, origin: 'PROPAGATED', fromModuleIds: ['m5'], deliveryDelta: 1 }),
    ]);
  });
});

describe('T4: a delay larger than the float', () => {
  const before = fresh();
  const after = recordEvent(before, t4());
  const snap = last(after);

  it('moves delivery by the excess over the float', () => {
    expect(snap.forecastDelivery).toEqual({ offset: 22, date: '2026-11-03' });
    expect(snap.stepDays).toBe(2);
    expect(snap.modules.m3).toMatchObject({ baselineFinish: 12, forecastFinish: 15, variance: 3 });
  });

  it('switches the critical path from M5 to M3', () => {
    const e = explain(before, after);
    expect(e.criticalPath.changed).toBe(true);
    expect(e.criticalPath.entered).toEqual(expect.arrayContaining(['m3.sb', 'm3.art', 'm3.dev', 'm3.alpha']));
    expect(e.criticalPath.left).toEqual(expect.arrayContaining(['m5.sb', 'm5.art', 'm5.dev', 'm5.alpha']));
    expect(e.modules.map((m) => m.moduleId).sort()).toEqual(['m3', 'project']); // M5 is not on the list
    expect(e.modules.find((m) => m.moduleId === 'project')).toMatchObject({ origin: 'PROPAGATED', fromModuleIds: ['m3'], delta: 2 });
  });
});

describe('HS: the late extinguisher (spec §28 / §40)', () => {
  const before = fresh();
  const after = recordEvent(before, hs());
  const snap = last(after);
  const e = explain(before, after);

  it('creates a new forecast and keeps the original one', () => {
    expect(after.snapshots).toHaveLength(2);
    expect(after.snapshots[0]?.forecastDelivery.date).toBe('2026-10-30');
    expect(snap.forecastDelivery).toEqual({ offset: 22, date: '2026-11-03' });
    expect(snap.baselineDelivery.date).toBe('2026-10-30');
    expect(snap.variance).toBe(2);
    expect(snap.eventId).toBe('hs');
  });

  it('costs 14 effort-days but only 2 schedule days', () => {
    expect(snap.effortImpact).toBe(14);
    expect(snap.stepDays).toBe(2);
    expect(e.effortImpact).toBe(14);
    expect(e.stepDays).toBe(2);
  });

  it('puts all seven modules on their own deviation, plus delivery propagated from M5', () => {
    const direct = e.modules.filter((m) => m.origin === 'DIRECT');
    expect(direct.map((m) => m.moduleId)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7']);
    expect(direct.every((m) => m.delta === 2 && !m.absorbed)).toBe(true);
    expect(e.modules).toHaveLength(8);
    expect(e.modules.find((m) => m.moduleId === 'project')).toMatchObject({
      origin: 'PROPAGATED',
      fromModuleIds: ['m5'],
      delta: 2,
    });
  });

  it('is on the critical path and lists the seven new tasks', () => {
    expect(e.onCriticalPath).toBe(true);
    expect(e.criticalPath.entered).toContain('m5.ext');
    const added = e.tasks.filter((t) => t.change === 'ADDED').map((t) => t.taskId).sort();
    expect(added).toEqual([1, 2, 3, 4, 5, 6, 7].map((n) => `m${n}.ext`));
  });
});

describe('a sequence of events', () => {
  const state = [t2(), t3(), hs()].reduce(recordEvent, fresh());

  it('accumulates variance step by step and ends on Wed 4 Nov', () => {
    expect(state.snapshots.map((s) => s.stepDays)).toEqual([0, 0, 1, 2]);
    expect(state.snapshots.map((s) => s.variance)).toEqual([0, 0, 1, 3]);
    expect(last(state).forecastDelivery).toEqual({ offset: 23, date: '2026-11-04' });
  });

  it('keeps every earlier forecast exactly as it was', () => {
    const early = recordEvent(fresh(), t2());
    const frozen = JSON.stringify(early.snapshots);
    const later = recordEvent(recordEvent(early, t3()), hs());
    expect(JSON.stringify(later.snapshots.slice(0, 2))).toBe(frozen);
    expect(later.snapshots.map((s) => s.revision)).toEqual([0, 1, 2, 3]);
  });

  it('never modifies the state or event it was given', () => {
    const base = fresh();
    const snapshot = JSON.stringify(base);
    const ev = hs();
    const evSnapshot = JSON.stringify(ev);
    recordEvent(base, ev);
    expect(JSON.stringify(base)).toBe(snapshot);
    expect(JSON.stringify(ev)).toBe(evSnapshot);
  });

  it('rebuilds identically from the log', () => {
    expect(buildHistory(buildThriveni(), state.log).snapshots).toEqual(state.snapshots);
  });
});

describe('recovery', () => {
  const before = fresh();
  const done = makeEvent('m5-done', '2026-10-16', [{ op: 'RECORD_PROGRESS', taskId: 'm5.dev', finishedOn: '2026-10-16' }], {
    type: 'TASK_COMPLETION',
  });
  const after = recordEvent(before, done);

  it('pulls delivery in when the critical task finishes early, up to the next-slowest module', () => {
    // M5 Dev finishes at offset 10 instead of 13. M3 (12) now sets the pace: delivery 19 = Thu 29 Oct.
    expect(last(after).forecastDelivery).toEqual({ offset: 19, date: '2026-10-29' });
    expect(last(after).stepDays).toBe(-1);
    expect(last(after).variance).toBe(-1);
    expect(last(after).tasks['m5.dev']).toMatchObject({ state: 'DONE', start: 7, finish: 10 });
  });

  it('explains it as M5 getting faster, even though the critical path moved to M3', () => {
    const e = explain(before, after);
    expect(e.criticalPath.changed).toBe(true);
    expect(e.criticalPath.entered).toContain('m3.dev');
    expect(e.modules).toEqual([
      expect.objectContaining({ moduleId: 'm5', delta: -3, origin: 'DIRECT' }),
      expect.objectContaining({ moduleId: 'project', delta: -1, origin: 'PROPAGATED', fromModuleIds: ['m5'] }),
    ]);
  });
});

describe('capacity change (Dev 4 -> 2 people)', () => {
  // Status Tue 13 Oct (offset 7); Dev has half the people from Wed 14 Oct. Every remaining Dev task takes twice as long:
  // M5 Dev 6d -> 12d (ends 19), M3 Dev 5d -> 10d (ends 17); then client changes 2d -> 4d, integration 1d -> 2d.
  // 19 + review 1 + changes 4 + integration 2 + QA 2 + beta 1 = 29.
  const before = fresh();
  const cut = makeEvent('dev-cut', '2026-10-13', [{ op: 'SET_CAPACITY', teamId: 'dev', from: '2026-10-14', headcount: 2 }], {
    type: 'RESOURCE_CHANGE',
  });
  const after = recordEvent(before, cut);
  const e = explain(before, after);

  it('has no effort impact but moves delivery by 9 working days', () => {
    expect(last(after).effortImpact).toBe(0);
    expect(last(after).forecastDelivery).toEqual({ offset: 29, date: '2026-11-12' });
    expect(last(after).stepDays).toBe(9);
  });

  it('moves every module that still has Dev work, and only those', () => {
    const deltas = Object.fromEntries(e.modules.map((m) => [m.moduleId, m.delta]));
    expect(deltas).toEqual({ m1: 3, m2: 2, m3: 5, m4: 4, m5: 6, m6: 3, m7: 4, project: 9 });
    expect(e.modules.every((m) => m.origin === 'DIRECT')).toBe(true); // capacity touches all of them directly
    expect(last(after).touchedModuleIds).not.toContain('shared'); // all its work is finished by then
  });
});

describe('status dates', () => {
  it('never go backwards: a back-dated event is forecast as of the latest date', () => {
    const first = recordEvent(fresh(), makeEvent('e1', '2026-10-14', []));
    const second = recordEvent(first, makeEvent('e2', '2026-10-12', [], { occurredAt: '2026-10-12' }));
    expect(last(second).asOf).toBe('2026-10-14');
    expect(second.asOf).toBe('2026-10-14');
    expect(second.activeEvents[1]?.occurredAt).toBe('2026-10-12');
  });

  it('moves forward with each event', () => {
    const s = recordEvent(recordEvent(fresh(), makeEvent('e1', '2026-10-12', [])), makeEvent('e2', '2026-10-20', []));
    expect(s.snapshots.map((x) => x.asOf)).toEqual([null, '2026-10-12', '2026-10-20']);
  });
});

describe('errors', () => {
  it('names the event that cannot be applied, and leaves the state alone', () => {
    const base = fresh();
    // By Thu 22 Oct (offset 14) every Alpha has happened, so new work can no longer block it.
    const late = makeEvent('hs-late', '2026-10-22', extinguisherEffects());
    let error: unknown;
    try {
      recordEvent(base, late);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(EffectError);
    expect((error as EffectError).eventId).toBe('hs-late');
    expect((error as EffectError).message).toMatch(/Event hs-late: Effect 1 \(ADD_TASK\).*already started/);
    expect(base.snapshots).toHaveLength(1);
  });

  it('reports actuals recorded after the status date', () => {
    const bad = makeEvent('bad', '2026-10-14', [{ op: 'RECORD_PROGRESS', taskId: 'm1.sb', finishedOn: '2026-10-20' }]);
    expect(() => recordEvent(fresh(), bad)).toThrow(/Event bad: .*after the status date/);
  });

  it('rejects reused ids and invalid status dates', () => {
    const once = recordEvent(fresh(), t3());
    expect(() => recordEvent(once, makeEvent('t3', '2026-10-15', []))).toThrow(/id already used/);
    expect(() => recordEvent(fresh(), makeEvent('x', 'soon', []))).toThrow(/invalid asOf/);
  });
});

describe('voiding an event', () => {
  const withHs = recordEvent(fresh(), hs());
  const voided = voidEvent(withHs, { kind: 'VOID', id: 'v1', eventId: 'hs', asOf: '2026-10-15', reason: 'entered by mistake' });
  const snap = last(voided);

  it('returns the forecast to what it was without the event, and records that as a new snapshot', () => {
    expect(voided.snapshots).toHaveLength(3);
    expect(snap.kind).toBe('VOID');
    expect(snap.eventId).toBe('hs');
    expect(snap.voidId).toBe('v1');
    expect(snap.forecastDelivery.date).toBe('2026-10-30');
    expect(snap.variance).toBe(0);
    expect(snap.stepDays).toBe(-2);
    expect(snap.effortImpact).toBe(-14);
    expect(snap.tasks['m1.ext']).toBeUndefined();
    expect(voided.activeEvents).toHaveLength(0);
  });

  it('leaves the voided event and its original snapshot in the history', () => {
    expect(voided.log.map((l) => l.kind)).toEqual(['EVENT', 'VOID']);
    expect(voided.snapshots[1]).toEqual(withHs.snapshots[1]);
    expect(voided.snapshots[1]?.forecastDelivery.date).toBe('2026-11-03');
  });

  it('is explained as the removal of the seven tasks', () => {
    const e = explainSnapshot(last(withHs), snap);
    expect(e.tasks.filter((t) => t.change === 'REMOVED')).toHaveLength(7);
    expect(e.stepDays).toBe(-2);
  });

  it('keeps status dates monotonic', () => {
    const early = voidEvent(withHs, { kind: 'VOID', id: 'v2', eventId: 'hs', asOf: '2026-10-01' });
    expect(last(early).asOf).toBe('2026-10-14');
  });

  it('can be replayed from the log', () => {
    expect(buildHistory(buildThriveni(), voided.log).snapshots).toEqual(voided.snapshots);
  });

  it('lets later events build on the corrected history', () => {
    const next = recordEvent(voided, t3());
    expect(last(next).forecastDelivery.date).toBe('2026-11-02');
    expect(next.activeEvents.map((e) => e.id)).toEqual(['t3']);
  });

  it('keeps the effect of events that remain', () => {
    const state = recordEvent(recordEvent(fresh(), t3()), hs());
    const without = voidEvent(state, { kind: 'VOID', id: 'v', eventId: 'hs', asOf: '2026-10-14' });
    expect(last(without).forecastDelivery).toEqual({ offset: 21, date: '2026-11-02' }); // T3 alone
  });

  it('refuses when a later event relied on the voided one', () => {
    const dependent = makeEvent('more', '2026-10-14', [adjust('m1.ext', 1)]);
    const state = recordEvent(withHs, dependent);
    expect(() => voidEvent(state, { kind: 'VOID', id: 'v3', eventId: 'hs', asOf: '2026-10-14' })).toThrow(/Cannot void event hs/);
  });

  it('refuses unknown events, repeated voids and reused ids', () => {
    expect(() => voidEvent(withHs, { kind: 'VOID', id: 'v', eventId: 'ghost', asOf: '2026-10-14' })).toThrow(/does not exist or is already voided/);
    expect(() => voidEvent(voided, { kind: 'VOID', id: 'v9', eventId: 'hs', asOf: '2026-10-16' })).toThrow(/already voided/);
    expect(() => voidEvent(withHs, { kind: 'VOID', id: 'hs', eventId: 'hs', asOf: '2026-10-14' })).toThrow(/id already used/);
  });
});

describe('previewEvent', () => {
  it('answers "what would this do?" without changing anything', () => {
    const state = fresh();
    const before = JSON.stringify(state);
    const e = previewEvent(state, hs());
    expect(e.stepDays).toBe(2);
    expect(e.delivery).toEqual({ before: '2026-10-30', after: '2026-11-03' });
    expect(e.onCriticalPath).toBe(true);
    expect(JSON.stringify(state)).toBe(before);
    expect(state.snapshots).toHaveLength(1);
  });

  it('matches what recording the event then explains', () => {
    const state = recordEvent(fresh(), t2());
    const preview = previewEvent(state, t3());
    const actual = explainSnapshot(last(state), last(recordEvent(state, t3())));
    expect(preview).toEqual(actual);
  });
});

describe('the log as the source of truth', () => {
  it('rebuilds the same history from a plain list of entries', () => {
    const log: LogEntry[] = [
      { kind: 'EVENT', event: t2() },
      { kind: 'EVENT', event: t3() },
      { kind: 'EVENT', event: hs() },
      { kind: 'VOID', id: 'v', eventId: 't3', asOf: '2026-10-15' },
    ];
    const state = buildHistory(buildThriveni(), log);
    expect(state.snapshots.map((s) => s.kind)).toEqual(['BASELINE', 'EVENT', 'EVENT', 'EVENT', 'VOID']);
    // T2 + HS without T3: M2 absorbed, extinguisher +2 on M5's unchanged chain.
    expect(last(state).forecastDelivery.offset).toBe(22);
  });
});
