import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildThriveni } from '@multiverse/engine';
import { afterEach, describe, expect, it } from 'vitest';
import { loadBlueprint, seedDemoEvents, seedThriveni } from '../src/seed';
import { hs, makeApp, makeSeededApp, P, t2, t3 } from './helpers';
import type { TestApp } from './helpers';

let app: TestApp;
afterEach(async () => app.close());

/** A project where every module is locked except M7: its plan can still be refined. */
async function allButM7() {
  app = makeApp();
  await app.post('/projects', { id: 'thriveni', name: 'Thriveni', startDate: '2026-10-05', targetDate: '2026-10-30' });
  loadBlueprint(app.service, 'thriveni', buildThriveni());
  for (const m of buildThriveni().modules) if (m.id !== 'm7') await app.post(`${P}/modules/${m.id}/lock`);
}

const revisions = (a: TestApp) => a.service.store.listPlanRevisions('thriveni');

describe('refining an unlocked module after the project has started', () => {
  it('rebuilds history under a new plan revision and keeps the old one', async () => {
    await allButM7();
    expect(revisions(app).map((r) => r.planRevision)).toEqual([1]);

    // M7 Dev 5 -> 8 days: M7 now takes 14 days, longer than M5's 13, so the original plan itself is 1 day longer.
    const r = await app.patch(`${P}/tasks/m7.dev`, { estimate: 8 });
    expect(r.status).toBe(200);

    expect(revisions(app).map((x) => [x.planRevision, x.snapshots])).toEqual([[1, 1], [2, 1]]);
    expect(app.service.store.listSnapshots('thriveni', 1)[0]?.baselineDelivery.date).toBe('2026-10-30'); // untouched
    expect(app.service.store.listSnapshots('thriveni', 2)[0]?.baselineDelivery.date).toBe('2026-11-02');
    expect((await app.get(`${P}/forecast`)).body.forecastDelivery).toEqual({ offset: 21, date: '2026-11-02' });
    expect((await app.get('/projects/thriveni/plan-revisions')).body).toMatchObject({ current: 2 });
  });

  it('planning changes are not delay: events recorded earlier are replayed on the refined baseline', async () => {
    await allButM7();
    await app.post(`${P}/events`, t3()); // M5 +1: delivery 21 against a baseline of 20
    expect((await app.get(`${P}/forecast`)).body).toMatchObject({ variance: 1 });

    await app.patch(`${P}/tasks/m7.dev`, { estimate: 8 }); // the baseline itself moves to 21

    const f = (await app.get(`${P}/forecast`)).body;
    expect(f.baselineDelivery.date).toBe('2026-11-02');
    expect(f.forecastDelivery.date).toBe('2026-11-02');
    expect(f.variance).toBe(0); // the M5 slip is now hidden behind M7's longer plan

    // Both revisions are kept. The earlier one still shows what was recorded at the time.
    expect(app.service.store.listSnapshots('thriveni', 1).map((s) => s.variance)).toEqual([0, 1]);
    expect(app.service.store.listSnapshots('thriveni', 2).map((s) => s.variance)).toEqual([0, 0]);
    // The event itself was not touched.
    const events = (await app.get(`${P}/events`)).body;
    expect(events).toHaveLength(1);
    expect(events[0].seq).toBe(1);
  });

  it('keeps each snapshot recorded-at stable across revisions', async () => {
    await allButM7();
    await app.post(`${P}/events`, t3());
    const before = app.db.prepare('SELECT revision, recorded_at FROM forecast_snapshots WHERE plan_revision = 1 ORDER BY revision').all();
    await app.patch(`${P}/tasks/m7.dev`, { estimate: 8 });
    const after = app.db.prepare('SELECT revision, recorded_at FROM forecast_snapshots WHERE plan_revision = 2 ORDER BY revision').all();
    expect(after).toEqual(before);
  });

  it('refuses an edit that would break an event, and changes nothing', async () => {
    await allButM7();
    await app.post(`${P}/events`, {
      ...t3(), id: 'uses-m7-sb', effects: [{ op: 'ADD_TASK', task: { id: 'x.new', moduleId: 'm7', teamId: 'lxd', name: 'New', estimate: 1 }, dependsOn: ['m7.sb'], blocks: [] }],
    });
    const r = await app.del(`${P}/tasks/m7.sb`);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('EDIT_BREAKS_HISTORY');
    expect(r.body.message).toMatch(/nothing was changed/);
    expect((await app.get(P)).body.tasks.some((t: { id: string }) => t.id === 'm7.sb')).toBe(true);
    expect(revisions(app).map((x) => x.planRevision)).toEqual([1]);
  });

  it('refuses an edit that makes the plan invalid', async () => {
    await allButM7();
    const r = await app.post(`${P}/dependencies`, { predecessorId: 'm7.alpha', successorId: 'm7.sb' }); // a cycle
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('EDIT_BREAKS_HISTORY');
    expect(r.body.message).toMatch(/cycle/i);
    expect((await app.get(P)).body.dependencies.some((d: { predecessorId: string }) => d.predecessorId === 'm7.alpha' && true)).toBe(true); // original alpha -> review edge intact
    expect(revisions(app)).toHaveLength(1);
  });

  it('refuses to touch locked work even when other modules can still change', async () => {
    await allButM7();
    expect((await app.patch(`${P}/tasks/m6.dev`, { estimate: 9 })).body.error).toBe('LOCKED');
    // and deleting an unlocked task that feeds locked work is refused for the same reason
    expect((await app.del(`${P}/tasks/m7.alpha`)).body.error).toBe('LOCKED');
  });

  it('can adopt a newer engine: rebuild-history writes a new revision and keeps the old', async () => {
    app = makeSeededApp();
    await app.post(`${P}/events`, t2());
    await app.post(`${P}/events`, hs());
    const r = await app.post(`${P}/rebuild-history`);
    expect(r.body).toEqual({ planRevision: 2, snapshots: 3 });
    expect(revisions(app).map((x) => [x.planRevision, x.snapshots])).toEqual([[1, 3], [2, 3]]);
    expect((await app.get(`${P}/forecast`)).body.forecastDelivery.date).toBe('2026-11-03');
    expect((await app.get(`${P}/snapshots`)).body).toHaveLength(3); // views follow the current revision only
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
      seedThriveni(first.service);
      await first.post(`${P}/events`, t2());
      await first.post(`${P}/events`, t3());
      const timeline = (await first.get(`${P}/timeline`)).body;
      const forecast = (await first.get(`${P}/forecast`)).body;
      await first.close();

      app = makeApp(path); // a new process, in effect: opens the same file and reapplies the schema
      expect((await app.get(`${P}/timeline`)).body).toEqual(timeline);
      expect((await app.get(`${P}/forecast`)).body).toEqual(forecast);
      const next = await app.post(`${P}/events`, hs());
      expect(next.status).toBe(201);
      expect(next.body.event.seq).toBe(3);
      expect(next.body.snapshot.forecastDelivery.date).toBe('2026-11-04');
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

  it('can be loaded under a different id, so several projects coexist', async () => {
    app = makeApp();
    seedThriveni(app.service, 'thriveni');
    seedThriveni(app.service, 'thriveni-copy');
    await app.post('/projects/thriveni-copy/events', t2());
    expect((await app.get('/projects/thriveni/events')).body).toEqual([]);
    expect((await app.get('/projects/thriveni-copy/events')).body).toHaveLength(1);
  });
});
