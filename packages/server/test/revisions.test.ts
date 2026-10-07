import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { seedDemoEvents, seedThriveni } from '../src/seed';
import { hs, makeApp, makeSeededApp, P, planEdit, t2, t3 } from './helpers';
import type { TestApp } from './helpers';

let app: TestApp;
afterEach(async () => app.close());

const revisions = (a: TestApp) => a.service.store.listPlanRevisions('thriveni');

describe('rebuilding history with the current engine', () => {
  it('writes a new revision and keeps the old one', async () => {
    app = makeSeededApp();
    await app.post(`${P}/events`, t2());
    await app.post(`${P}/events`, hs());
    const r = await app.post(`${P}/rebuild-history`);
    expect(r.body).toEqual({ planRevision: 2, snapshots: 3 });
    expect(revisions(app).map((x) => [x.planRevision, x.snapshots])).toEqual([[1, 3], [2, 3]]);
    expect((await app.get(`${P}/forecast`)).body.forecastDelivery.date).toBe('2026-11-03');
    expect((await app.get(`${P}/snapshots`)).body).toHaveLength(3); // views follow the current revision only
  });

  it('includes plan edits, with their recorded times', async () => {
    app = makeApp();
    seedThriveni(app.service, 'thriveni', { leaveUnlocked: ['m7'] });
    await app.post(`${P}/plan-edits`, planEdit());
    const before = app.db.prepare('SELECT revision, kind, recorded_at FROM forecast_snapshots WHERE plan_revision = 1 ORDER BY revision').all();
    await app.post(`${P}/rebuild-history`);
    const after = app.db.prepare('SELECT revision, kind, recorded_at FROM forecast_snapshots WHERE plan_revision = 2 ORDER BY revision').all();
    expect(after).toEqual(before);
    expect(after.map((r) => r.kind)).toEqual(['BASELINE', 'PLAN']);
  });

  it('only for a project that has started', async () => {
    app = makeApp();
    await app.post('/projects', { id: 'thriveni', name: 'x', startDate: '2026-10-05' });
    expect((await app.post(`${P}/rebuild-history`)).body.error).toBe('NOT_STARTED');
  });
});

describe('persistence', () => {
  it('survives a restart: same history, and the log carries on', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'multiverse-'));
    const path = join(dir, 'multiverse.sqlite');
    try {
      const first = makeApp(path);
      seedThriveni(first.service, 'thriveni', { leaveUnlocked: ['m7'] });
      await first.post(`${P}/plan-edits`, planEdit()); // planning comes first: by 14 Oct M7's work is under way
      await first.post(`${P}/events`, t2());
      await first.post(`${P}/events`, t3());
      const timeline = (await first.get(`${P}/timeline`)).body;
      const forecast = (await first.get(`${P}/forecast`)).body;
      await first.close();

      app = makeApp(path); // a new process, in effect: opens the same file and reapplies the schema
      expect((await app.get(`${P}/timeline`)).body).toEqual(timeline);
      expect((await app.get(`${P}/forecast`)).body).toEqual(forecast);
      const next = await app.post(`${P}/events`, { ...t2(), id: 'more', effects: [{ op: 'ADJUST_ESTIMATE', taskId: 'm1.dev', delta: 1 }] });
      expect(next.status).toBe(201);
      expect(next.body.event.seq).toBe(4); // plan edit, event, event, then this one
    } finally {
      await app?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the seed', () => {
  it('creates the Thriveni project started and locked, ready for events', async () => {
    app = makeApp();
    seedThriveni(app.service);
    const view = (await app.get(P)).body;
    expect(view.started).toBe(true);
    expect(view.modules.every((m: { lockedAt: string | null }) => m.lockedAt !== null)).toBe(true);
    expect(view.forecast.forecastDelivery).toEqual({ offset: 20, date: '2026-10-30' });
    expect(view.project).toMatchObject({ name: 'Thriveni VR Training', targetDate: '2026-10-30' });
    expect(view.forecast.target).toEqual({ date: '2026-10-30', daysToSpare: 0 });
  });

  it('can add demo events that end on Wed 4 Nov (+3 working days)', async () => {
    app = makeApp();
    seedThriveni(app.service);
    seedDemoEvents(app.service);
    const f = (await app.get(`${P}/forecast`)).body;
    expect(f.forecastDelivery).toEqual({ offset: 23, date: '2026-11-04' });
    expect(f.variance).toBe(3);
    expect((await app.get(`${P}/events`)).body.map((e: { id: string }) => e.id)).toEqual(['demo-m2-dev-slip', 'demo-m5-blocked', 'demo-extinguisher']);
    expect((await app.get(`${P}/attribution`)).body.byCategory[0]).toMatchObject({ category: 'Late scope discovery', days: 2 });
  });

  it('can leave modules unlocked: their plan is then edited by recorded plan edits, not by changing rows', async () => {
    app = makeApp();
    seedThriveni(app.service, 'thriveni', { leaveUnlocked: ['m7'] });
    const view = (await app.get(P)).body;
    expect(view.started).toBe(true);
    expect(view.modules.filter((m: { lockedAt: string | null }) => m.lockedAt === null).map((m: { id: string }) => m.id)).toEqual(['m7']);
    const direct = await app.patch(`${P}/tasks/m7.dev`, { estimate: 8 });
    expect(direct.status).toBe(409);
    expect(direct.body.message).toMatch(/record a plan edit/);
    expect((await app.post(`${P}/plan-edits`, planEdit())).status).toBe(201);
  });

  it('rejects leaving unknown modules unlocked, or every module', async () => {
    app = makeApp();
    expect(() => seedThriveni(app.service, 'a', { leaveUnlocked: ['m99'] })).toThrow(/Unknown module/);
    const all = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'shared', 'project'];
    expect(() => seedThriveni(app.service, 'b', { leaveUnlocked: all })).toThrow(/At least one module must be locked/);
  });

  it('can be loaded under a different id, so several projects coexist', async () => {
    app = makeApp();
    seedThriveni(app.service, 'thriveni');
    seedThriveni(app.service, 'thriveni-copy');
    await app.post('/projects/thriveni-copy/events', t2());
    expect((await app.get('/projects/thriveni/events')).body).toEqual([]);
    expect((await app.get('/projects/thriveni-copy/events')).body).toHaveLength(1);
  });
});
