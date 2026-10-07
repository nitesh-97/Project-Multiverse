import { buildHistory, buildThriveni } from '@multiverse/engine';
import { afterEach, describe, expect, it } from 'vitest';
import { makeApp, makeDraftApp, P, planEdit, t3 } from './helpers';
import type { TestApp } from './helpers';

let app: TestApp;
afterEach(async () => app.close());

/** M5 development +1 day, recorded on the first day of the project (before the plan edit that will absorb it). */
const m5Slip = () => ({ ...t3(), id: 'm5-slip', occurredAt: '2026-10-05' });

describe('changing the plan of a module that has not started', () => {
  it('is recorded in history: the plan moves, the forecast moves with it, and variance does not', async () => {
    app = await makeDraftApp();
    const r = await app.post(`${P}/plan-edits`, planEdit());
    expect(r.status).toBe(201);
    expect(r.body.planEdit).toMatchObject({ id: 'longer-m7', seq: 1, title: 'M7 development re-estimated', reason: 'new scope agreed with the client', createdBy: 'planner' });
    expect(r.body.planEdit.recordedAt).toBeTruthy();
    expect(r.body.snapshot).toMatchObject({ revision: 1, kind: 'PLAN', planEditId: 'longer-m7', variance: 0, stepDays: 0, effortImpact: 3 });
    expect(r.body.snapshot.baselineDelivery).toEqual({ offset: 21, date: '2026-11-02' }); // M7 now takes 14 days
    expect(r.body.snapshot.forecastDelivery).toEqual({ offset: 21, date: '2026-11-02' });
    expect(r.body.explanation).toMatchObject({ kind: 'PLAN', planEditId: 'longer-m7', baselineStepDays: 1 });
  });

  it('appears everywhere history does: snapshots, events log, timeline markers, and the original line stays', async () => {
    app = await makeDraftApp();
    await app.post(`${P}/plan-edits`, planEdit());

    expect((await app.get(`${P}/snapshots`)).body.map((s: { kind: string }) => s.kind)).toEqual(['BASELINE', 'PLAN']);
    const tl = (await app.get(`${P}/timeline`)).body;
    expect(tl.original.delivery.date).toBe('2026-10-30'); // the plan as it was when the project started
    expect(tl.current.planDelivery.date).toBe('2026-11-02'); // the plan as it stands now
    expect(tl.branches).toEqual([]); // nothing slipped
    expect(tl.markers).toEqual([expect.objectContaining({ kind: 'PLAN', eventId: 'longer-m7', baselineStepDays: 1, noScheduleEffect: true })]);

    const edits = (await app.get(`${P}/plan-edits`)).body;
    expect(edits).toHaveLength(1);
    expect(edits[0]).toMatchObject({ id: 'longer-m7', reason: 'new scope agreed with the client' });
  });

  it('shares one sequence with events and voids', async () => {
    app = await makeDraftApp();
    await app.post(`${P}/events`, m5Slip());
    const edit = await app.post(`${P}/plan-edits`, planEdit({ asOf: '2026-10-06' }));
    expect(edit.body.planEdit.seq).toBe(2);
    const v = await app.post(`${P}/events/m5-slip/void`, { asOf: '2026-10-07' });
    expect(v.status).toBe(201);
    expect(app.service.store.nextSeq('thriveni')).toBe(4);
  });

  it('can be previewed without recording, and the preview matches the record', async () => {
    app = await makeDraftApp();
    const preview = await app.post(`${P}/plan-edits/preview`, planEdit());
    expect(preview.status).toBe(200);
    expect(preview.body.explanation).toMatchObject({ kind: 'PLAN', baselineStepDays: 1, effortImpact: 3 });
    expect((await app.get(`${P}/plan-edits`)).body).toEqual([]);
    expect((await app.get(`${P}/snapshots`)).body).toHaveLength(1);

    const recorded = await app.post(`${P}/plan-edits`, planEdit());
    expect(recorded.body.explanation).toEqual(preview.body.explanation);
  });

  it('is attributed: a slip, and the planning change that later absorbed it, add up to the total', async () => {
    app = await makeDraftApp();
    await app.post(`${P}/events`, m5Slip());
    expect((await app.get(`${P}/forecast`)).body.variance).toBe(1); // delivery 21 against a plan of 20
    await app.post(`${P}/plan-edits`, planEdit());
    expect((await app.get(`${P}/forecast`)).body).toMatchObject({ variance: 0 }); // the plan is now 21 too

    const both = (await app.get(`${P}/attribution?strategy=both`)).body;
    expect(Object.keys(both)).toEqual(['sequential', 'counterfactual']);
    const seq = both.sequential.contributions.map((c: { eventId: string; kind: string; days: number; category: string }) => [c.eventId, c.kind, c.days, c.category]);
    expect(seq).toEqual([
      ['m5-slip', 'EVENT', 1, 'Dependency delays'],
      ['longer-m7', 'PLAN', -1, 'Planning changes'],
    ]);
    expect(both.sequential.totalVariance).toBe(0);
    expect(both.counterfactual.interaction).toBe(1);
  });

  it('matches the engine exactly when replayed from the log', async () => {
    app = await makeDraftApp();
    await app.post(`${P}/events`, m5Slip());
    await app.post(`${P}/plan-edits`, planEdit());
    await app.post(`${P}/events`, { ...t3(), id: 'later', occurredAt: '2026-10-14', effects: [{ op: 'ADJUST_ESTIMATE', taskId: 'm2.dev', delta: 2 }] });

    const engine = buildHistory(buildThriveni(), app.service.store.loadLog('thriveni'));
    expect((await app.get(`${P}/snapshots?full=true`)).body).toEqual(JSON.parse(JSON.stringify(engine.snapshots)));
  });
});

describe('plan edits that are refused', () => {
  it('for a module that is locked: its work has started, so it is an event', async () => {
    app = await makeDraftApp();
    const r = await app.post(`${P}/plan-edits`, planEdit({ effects: [{ op: 'ADJUST_ESTIMATE', taskId: 'm6.dev', delta: 1 }] }));
    expect(r.status).toBe(422);
    expect(r.body.error).toBe('EVENT_REJECTED');
    expect(r.body.message).toMatch(/Module m6 is locked.*changes to it are events, not planning/);
    expect((await app.get(`${P}/plan-edits`)).body).toEqual([]);
  });

  it('for work that has already started, even in a module that is not locked', async () => {
    app = await makeDraftApp();
    // By Wed 14 Oct the forecast has M7 development under way.
    const r = await app.post(`${P}/plan-edits`, planEdit({ asOf: '2026-10-14' }));
    expect(r.status).toBe(422);
    expect(r.body.message).toMatch(/Plan edit longer-m7: Effect 1 \(ADJUST_ESTIMATE\): task m7.dev has already started/);
    expect((await app.get(`${P}/snapshots`)).body).toHaveLength(1);
  });

  it('that make new work gate a locked module', async () => {
    app = await makeDraftApp();
    const r = await app.post(
      `${P}/plan-edits`,
      planEdit({
        effects: [{ op: 'ADD_TASK', task: { id: 'm7.gate', moduleId: 'm7', teamId: 'dev', name: 'Gate', estimate: 1 }, dependsOn: [], blocks: ['m6.dev'] }],
      }),
    );
    expect(r.status).toBe(422);
    expect(r.body.message).toMatch(/Module m6 is locked/);
  });

  it('that use effects which are not planning: capacity, holidays and actuals are events', async () => {
    app = await makeDraftApp();
    for (const effect of [
      { op: 'SET_CAPACITY', teamId: 'dev', from: '2026-10-14', headcount: 2 },
      { op: 'ADD_HOLIDAY', date: '2026-10-28' },
      { op: 'RECORD_PROGRESS', taskId: 'm7.sb', finishedOn: '2026-10-06' },
    ]) {
      const r = await app.post(`${P}/plan-edits`, planEdit({ effects: [effect] }));
      expect(r.status, effect.op).toBe(400);
    }
  });

  it('with no effects, unknown tasks, a reused id, or a bad date', async () => {
    app = await makeDraftApp();
    expect((await app.post(`${P}/plan-edits`, planEdit({ effects: [] }))).status).toBe(400);
    expect((await app.post(`${P}/plan-edits`, planEdit({ asOf: 'soon' }))).status).toBe(400);
    expect((await app.post(`${P}/plan-edits`, planEdit({ effects: [{ op: 'ADJUST_ESTIMATE', taskId: 'ghost', delta: 1 }] }))).status).toBe(422);
    await app.post(`${P}/plan-edits`, planEdit());
    const again = await app.post(`${P}/plan-edits`, planEdit({ asOf: '2026-10-07' }));
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('ALREADY_EXISTS');
  });

  it('before the project has started', async () => {
    app = makeApp();
    await app.post('/projects', { id: 'thriveni', name: 'x', startDate: '2026-10-05' });
    const r = await app.post(`${P}/plan-edits`, planEdit());
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('NOT_STARTED');
  });
});

describe('events on a module that has not started', () => {
  it('are refused, with a pointer to plan edits; nothing is recorded', async () => {
    app = await makeDraftApp();
    const r = await app.post(`${P}/events`, { ...t3(), id: 'wrong', effects: [{ op: 'ADJUST_ESTIMATE', taskId: 'm7.dev', delta: 1 }] });
    expect(r.status).toBe(422);
    expect(r.body.error).toBe('EVENT_REJECTED');
    expect(r.body.message).toMatch(/Module m7 is not locked.*plan edit \(POST \/projects\/thriveni\/plan-edits\)/);
    expect(r.body.details).toEqual(['module m7 is not locked']);
    expect((await app.get(`${P}/events`)).body).toEqual([]);
  });

  it('are fine for locked modules, even when they move an unlocked module by propagation', async () => {
    app = await makeDraftApp();
    const r = await app.post(`${P}/events`, t3());
    expect(r.status).toBe(201);
  });

  it('are fine once the module has been locked', async () => {
    app = await makeDraftApp();
    expect((await app.post(`${P}/modules/m7/lock`)).status).toBe(200);
    const r = await app.post(`${P}/events`, { ...t3(), id: 'now-ok', effects: [{ op: 'ADJUST_ESTIMATE', taskId: 'm7.dev', delta: 1 }] });
    expect(r.status).toBe(201);
    // ... and from then on, plan edits to it are refused
    expect((await app.post(`${P}/plan-edits`, planEdit({ id: 'too-late', asOf: '2026-10-15' }))).body.message).toMatch(/Module m7 is locked/);
  });

  it('a capacity or calendar event belongs to no module, so it is always fine', async () => {
    app = await makeDraftApp();
    const r = await app.post(`${P}/events`, { ...t3(), id: 'cap', type: 'RESOURCE_CHANGE', effects: [{ op: 'SET_CAPACITY', teamId: 'dev', from: '2026-10-14', headcount: 3 }] });
    expect(r.status).toBe(201);
  });
});

describe('the plan rows themselves', () => {
  it('cannot be edited directly once the project has started: the database refuses, and says what to do instead', async () => {
    app = await makeDraftApp();
    for (const r of [
      await app.patch(`${P}/tasks/m7.dev`, { estimate: 8 }),
      await app.post(`${P}/tasks`, { id: 'new', moduleId: 'm7', teamId: 'dev', name: 'New', estimate: 1 }),
      await app.del(`${P}/tasks/m7.dev`),
      await app.post(`${P}/dependencies`, { predecessorId: 'm7.sb', successorId: 'm7.dev' }),
      await app.post(`${P}/modules`, { id: 'm8', name: 'Module 8', kind: 'DELIVERABLE' }),
      await app.patch(`${P}/modules/m7`, { name: 'Renamed' }),
      await app.del(`${P}/modules/m7`),
    ]) {
      expect(r.status).toBe(409);
      expect(r.body.error).toBe('LOCKED');
      expect(r.body.message).toMatch(/plan edit/);
    }
    expect((await app.get(P)).body.tasks.find((t: { id: string }) => t.id === 'm7.dev').estimate).toBe(5);
  });

  it('still allow locking more modules, which is the one thing that changes after the start', async () => {
    app = await makeDraftApp();
    const r = await app.post(`${P}/modules/m7/lock`);
    expect(r.status).toBe(200);
    expect(r.body.modules.every((m: { lockedAt: string | null }) => m.lockedAt !== null)).toBe(true);
  });

  it('plan edits cannot be altered or removed: the log is append-only', async () => {
    app = await makeDraftApp();
    await app.post(`${P}/plan-edits`, planEdit());
    expect(() => app.db.prepare(`UPDATE plan_edits SET title = 'rewritten'`).run()).toThrow(/append-only/);
    expect(() => app.db.prepare(`DELETE FROM plan_edits`).run()).toThrow(/append-only/);
  });
});
