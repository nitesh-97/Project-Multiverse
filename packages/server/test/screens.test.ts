import { afterEach, describe, expect, it } from 'vitest';
import { hs, makeApp, makeDraftApp, makeSeededApp, P, planEdit, sharedExt, t3 } from './helpers';
import type { TestApp } from './helpers';

let app: TestApp;
afterEach(async () => app.close());

describe('GET /control-room', () => {
  it('at the start: on plan, on the client date, nothing done, M5 setting the pace', async () => {
    app = makeSeededApp();
    const res = await app.get(`${P}/control-room`);
    expect(res.status).toBe(200);
    const cr = res.body;
    expect(cr).toMatchObject({ asOf: null, variance: 0, firstBreach: null });
    expect(cr.forecast).toEqual({ offset: 20, date: '2026-10-30' });
    expect(cr.target).toEqual({ date: '2026-10-30', daysToSpare: 0 });
    expect(cr.progress).toEqual({ doneEffort: 0, totalEffort: 97, percent: 0, confirmedPercent: 0 });
    expect(cr.bottleneck.current.taskId).toBe('m5.sb');
    expect(cr.contributors).toMatchObject({ strategy: 'sequential', totalVariance: 0, contributions: [] });
  });

  it('says which modules are locked, so the screen can offer to lock the rest', async () => {
    app = await makeDraftApp();
    const cr = (await app.get(`${P}/control-room`)).body;
    expect(cr.modules.find((m: { moduleId: string }) => m.moduleId === 'm7').locked).toBe(false);
    expect(cr.modules.find((m: { moduleId: string }) => m.moduleId === 'm5').locked).toBe(true);
  });

  it('after a critical slip: late against the plan and against the client date, and why', async () => {
    app = makeSeededApp();
    await app.post(`${P}/events`, t3());
    const cr = (await app.get(`${P}/control-room`)).body;
    expect(cr.forecast).toEqual({ offset: 21, date: '2026-11-02' });
    expect(cr.variance).toBe(1);
    expect(cr.target).toEqual({ date: '2026-10-30', daysToSpare: -1 });
    expect(cr.contributors.totalVariance).toBe(1);
    expect(cr.contributors.contributions).toEqual([expect.objectContaining({ eventId: 't3', days: 1 })]);
    expect(cr.firstBreach).not.toBeNull();
    expect(cr.trend).toHaveLength(2);
  });

  it('keeps the two measures apart: a plan edit moves the plan, so variance is 0 but the client date is missed', async () => {
    app = await makeDraftApp();
    expect((await app.post(`${P}/plan-edits`, planEdit())).status).toBe(201);
    const cr = (await app.get(`${P}/control-room`)).body;
    expect(cr.original).toEqual({ offset: 20, date: '2026-10-30' });
    expect(cr.plan).toEqual({ offset: 21, date: '2026-11-02' });
    expect(cr.forecast).toEqual({ offset: 21, date: '2026-11-02' });
    expect(cr.variance).toBe(0);
    expect(cr.target.daysToSpare).toBe(-1);
  });

  it('carries the warnings the forecast raises', async () => {
    app = makeSeededApp();
    await app.post(`${P}/events`, { ...t3(), id: 'quiet', effects: [], occurredAt: '2026-10-14' });
    const rules = (await app.get(`${P}/control-room`)).body.advisories.map((a: { rule: string }) => a.rule);
    expect(rules).toContain('COMMON_FEATURE_WITHOUT_SHARED_TASK');
    expect(rules).toContain('UNCONFIRMED_COMPLETION');
  });

  it('has no client-date figure when no client date was set, and still has the rest', async () => {
    app = makeSeededApp();
    expect((await app.patch(P, { targetDate: null })).status).toBe(200);
    const cr = (await app.get(`${P}/control-room`)).body;
    expect(cr.target).toBeNull();
    expect(cr.variance).toBe(0);
    expect((await app.get(`${P}/retro`)).body.target).toBeNull();
  });
});

describe('GET /retro', () => {
  it('is in progress at the start, with both ways of sharing the delay', async () => {
    app = makeSeededApp();
    const r = (await app.get(`${P}/retro`)).body;
    expect(r).toMatchObject({ status: 'IN_PROGRESS', observations: [] });
    expect(r.planned.delivery.date).toBe('2026-10-30');
    expect(r.contributors.sequential.strategy).toBe('sequential');
    expect(r.contributors.counterfactual.strategy).toBe('counterfactual');
    expect(r.target).toEqual({ date: '2026-10-30', daysToSpare: 0 });
  });

  it('reports a late shared feature in plain language', async () => {
    app = makeSeededApp();
    await app.post(`${P}/events`, sharedExt({ couldHaveBeenEarlier: true }));
    const r = (await app.get(`${P}/retro`)).body;
    expect(r.scope).toEqual({ changes: 1, afterDevelopmentStarted: 1, effortDays: 2, scheduleDays: 2 });
    expect(r.outcome.variance).toBe(2);
    expect(r.target.daysToSpare).toBe(-2);
    expect(r.observations).toContain('1 common feature (Extinguisher) identified only after development had started');
    expect(r.couldHaveBeenEarlier).toEqual({ flagged: 1, of: 1 });
  });

  it('reports the planning change as planning, not delay', async () => {
    app = await makeDraftApp();
    await app.post(`${P}/plan-edits`, planEdit());
    const r = (await app.get(`${P}/retro`)).body;
    expect(r.planning).toEqual({ edits: 1, planMovedDays: 1 });
    expect(r.outcome.variance).toBe(0);
  });
});

describe('GET /current-tasks', () => {
  it('lists the 39 tasks of the plan with their state in the forecast', async () => {
    app = makeSeededApp();
    const tasks = (await app.get(`${P}/current-tasks`)).body;
    expect(tasks).toHaveLength(39);
    expect(tasks.find((t: { id: string }) => t.id === 'm5.dev')).toEqual({
      id: 'm5.dev',
      name: 'm5 development',
      moduleId: 'm5',
      teamId: 'dev',
      kind: 'TASK',
      estimate: 6,
      state: 'NOT_STARTED',
      // Storyboard and art take 7 working days, so development runs days 8 to 13: Wed 14 Oct to Wed 21 Oct.
      startDate: '2026-10-14',
      finishDate: '2026-10-21',
      remainingEffort: 6,
      totalFloat: 0,
      critical: true,
      assumed: false,
      added: false,
      moduleLocked: true,
    });
  });

  it('includes work added by an event, marked as added, so it can be picked in a form', async () => {
    app = makeSeededApp();
    await app.post(`${P}/events`, sharedExt());
    const tasks = (await app.get(`${P}/current-tasks`)).body;
    expect(tasks).toHaveLength(40);
    expect(tasks.find((t: { id: string }) => t.id === 'proj.ext')).toMatchObject({ name: 'Extinguisher system', featureId: 'extinguisher', added: true, critical: true });
  });

  it('includes work added to every module by the per-module version', async () => {
    app = makeSeededApp();
    await app.post(`${P}/events`, hs());
    const tasks = (await app.get(`${P}/current-tasks`)).body;
    expect(tasks.filter((t: { added: boolean }) => t.added)).toHaveLength(7);
  });

  it('says which tasks belong to a module that is not locked', async () => {
    app = await makeDraftApp();
    const tasks = (await app.get(`${P}/current-tasks`)).body as Array<{ id: string; moduleId: string; moduleLocked: boolean }>;
    expect(tasks.filter((t) => t.moduleId === 'm7').every((t) => !t.moduleLocked)).toBe(true);
    expect(tasks.filter((t) => t.moduleId !== 'm7').every((t) => t.moduleLocked)).toBe(true);
  });

  it('flags tasks the forecast merely assumes were done', async () => {
    app = makeSeededApp();
    await app.post(`${P}/events`, { ...t3(), id: 'quiet', effects: [] });
    const tasks = (await app.get(`${P}/current-tasks`)).body as Array<{ id: string; state: string; assumed: boolean }>;
    expect(tasks.find((t) => t.id === 'm5.art')).toMatchObject({ state: 'DONE', assumed: true });
    expect(tasks.find((t) => t.id === 'm5.dev')).toMatchObject({ state: 'IN_PROGRESS', assumed: true });
    expect(tasks.find((t) => t.id === 'proj.qa')).toMatchObject({ state: 'NOT_STARTED', assumed: false });
  });
});

describe('before the project has started', () => {
  it.each(['control-room', 'retro', 'current-tasks'])('refuses /%s with 409 NOT_STARTED', async (view) => {
    app = makeApp();
    await app.post('/projects', { id: 'p', name: 'P', startDate: '2026-10-05' });
    const res = await app.get(`/projects/p/${view}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('NOT_STARTED');
  });

  it.each(['control-room', 'retro', 'current-tasks'])('is 404 for an unknown project on /%s', async (view) => {
    app = makeApp();
    expect((await app.get(`/projects/nope/${view}`)).status).toBe(404);
  });
});
