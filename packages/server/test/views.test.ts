import { buildHistory, buildThriveni } from '@multiverse/engine';
import type { LogEntry } from '@multiverse/engine';
import { afterEach, describe, expect, it } from 'vitest';
import { hs, makeApp, makeSeededApp, P, t2, t3 } from './helpers';
import type { TestApp } from './helpers';

let app: TestApp;
afterEach(async () => app.close());

/** Three events: absorbed delay, critical delay, late extinguisher. Delivery ends on Wed 4 Nov (+3). */
async function withHistory() {
  app = makeSeededApp();
  for (const e of [t2(), t3(), hs()]) await app.post(`${P}/events`, e);
}

describe('forecast', () => {
  it('is the baseline right after locking: Fri 30 Oct, M5 chain critical', async () => {
    app = makeSeededApp();
    const f = (await app.get(`${P}/forecast`)).body;
    expect(f).toMatchObject({ revision: 0, kind: 'BASELINE', variance: 0 });
    expect(f.forecastDelivery).toEqual({ offset: 20, date: '2026-10-30' });
    expect(f.criticalPath).toEqual(expect.arrayContaining(['m5.sb', 'm5.dev', 'proj.review', 'proj.qa', 'proj.delivery']));
    expect(f.drivingChain[f.drivingChain.length - 1]).toBe('proj.delivery');
    expect(f.tasks['m3.alpha']).toMatchObject({ totalFloat: 1, critical: false });
    expect(f.modules.m5).toMatchObject({ baselineFinish: 13, forecastFinish: 13 });
  });

  it('is the latest snapshot as events arrive', async () => {
    await withHistory();
    const f = (await app.get(`${P}/forecast`)).body;
    expect(f.revision).toBe(3);
    expect(f.forecastDelivery).toEqual({ offset: 23, date: '2026-11-04' });
    expect(f.variance).toBe(3);
    expect(f.baselineDelivery.date).toBe('2026-10-30');
  });
});

describe('snapshots', () => {
  it('lists summaries by default and full detail on request', async () => {
    await withHistory();
    const summaries = (await app.get(`${P}/snapshots`)).body;
    expect(summaries).toHaveLength(4);
    expect(summaries[0].tasks).toBeUndefined();
    expect(summaries.map((s: { eventId: string | null }) => s.eventId)).toEqual([null, 't2', 't3', 'hs']);

    const full = (await app.get(`${P}/snapshots?full=true`)).body;
    expect(Object.keys(full[3].tasks).length).toBeGreaterThan(30);
  });

  it('returns one snapshot with the reason it changed', async () => {
    await withHistory();
    const first = (await app.get(`${P}/snapshots/0`)).body;
    expect(first.explanation).toBeNull();

    const r = (await app.get(`${P}/snapshots/3`)).body;
    expect(r.snapshot.revision).toBe(3);
    expect(r.explanation).toMatchObject({ stepDays: 2, effortImpact: 14, eventId: 'hs', onCriticalPath: true });
    expect(r.explanation.delivery).toEqual({ before: '2026-11-02', after: '2026-11-04' });
  });

  it('404s on a missing revision and 400s on a bad one', async () => {
    await withHistory();
    expect((await app.get(`${P}/snapshots/99`)).status).toBe(404);
    expect((await app.get(`${P}/snapshots/abc`)).status).toBe(400);
    expect((await app.get(`${P}/snapshots/-1`)).status).toBe(400);
  });
});

describe('timeline: the Multiverse view', () => {
  it('is the original line alone before anything has happened', async () => {
    app = makeSeededApp();
    const tl = (await app.get(`${P}/timeline`)).body;
    expect(tl.original.delivery).toEqual({ offset: 20, date: '2026-10-30' });
    expect(tl.branches).toEqual([]);
    expect(tl.current.variance).toBe(0);
  });

  it('has one branch per module that deviated, in the order they first did', async () => {
    await withHistory();
    const tl = (await app.get(`${P}/timeline`)).body;
    expect(tl.branches.map((b: { moduleId: string }) => b.moduleId)).toEqual(['m2', 'm5', 'project', 'm1', 'm3', 'm4', 'm6', 'm7']);
    const project = tl.branches.find((b: { isDelivery: boolean }) => b.isDelivery);
    expect(project).toMatchObject({ moduleId: 'project', currentDelta: 3, status: 'OPEN' });
    expect(project.steps.map((s: { delta: number; origin: string }) => [s.delta, s.origin])).toEqual([[1, 'PROPAGATED'], [2, 'PROPAGATED']]);
    expect(tl.markers.map((m: { eventId: string; stepDays: number }) => [m.eventId, m.stepDays])).toEqual([['t2', 0], ['t3', 1], ['hs', 2]]);
  });
});

describe('history and milestones', () => {
  it('shows delivery drift and the first breach', async () => {
    await withHistory();
    const h = (await app.get(`${P}/history`)).body;
    expect(h.drift.map((d: { forecastDelivery: { date: string } }) => d.forecastDelivery.date)).toEqual(['2026-10-30', '2026-10-30', '2026-11-02', '2026-11-04']);
    expect(h.firstBreach).toMatchObject({ revision: 2, eventId: 't3', variance: 1 });
  });

  it('has no breach while the project is on time', async () => {
    app = makeSeededApp();
    await app.post(`${P}/events`, t2());
    expect((await app.get(`${P}/history`)).body.firstBreach).toBeNull();
  });

  it('shows how one milestone moved', async () => {
    await withHistory();
    const points = (await app.get(`${P}/milestones/proj.delivery/history`)).body;
    expect(points.map((p: { forecast: { date: string } }) => p.forecast.date)).toEqual(['2026-10-30', '2026-10-30', '2026-11-02', '2026-11-04']);
    expect(points.every((p: { baseline: { date: string } }) => p.baseline.date === '2026-10-30')).toBe(true);
    expect((await app.get(`${P}/milestones/no-such/history`)).status).toBe(404);
  });
});

describe('advisories', () => {
  it('flags the extinguisher: seven modules, no shared task', async () => {
    app = makeSeededApp();
    const a = (await app.get(`${P}/advisories`)).body;
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ featureId: 'extinguisher', severity: 'ADVISORY' });
    expect(a[0].message).toBe('Common feature detected: Extinguisher is used by 7 modules but has no shared implementation task.');
  });

  it('respects the threshold and rejects a bad one', async () => {
    app = makeSeededApp();
    expect((await app.get(`${P}/advisories?minModules=8`)).body).toEqual([]);
    expect((await app.get(`${P}/advisories?minModules=0`)).status).toBe(400);
    expect((await app.get(`${P}/advisories?minModules=many`)).status).toBe(400);
  });
});

describe('attribution', () => {
  it('sequential (default): each event gets the change it caused, and they add up', async () => {
    await withHistory();
    const a = (await app.get(`${P}/attribution`)).body;
    expect(a).toMatchObject({ strategy: 'sequential', totalVariance: 3, interaction: 0 });
    expect(a.contributions.map((c: { eventId: string; days: number; category: string }) => [c.eventId, c.days, c.category])).toEqual([
      ['t2', 0, 'Estimation / unexplained variance'],
      ['t3', 1, 'Dependency delays'],
      ['hs', 2, 'Late scope discovery'],
    ]);
    expect(a.byCategory.map((c: { category: string; days: number }) => [c.category, c.days])).toEqual([
      ['Late scope discovery', 2],
      ['Dependency delays', 1],
      ['Estimation / unexplained variance', 0],
    ]);
  });

  it('counterfactual: marginal contributions plus an explicit interaction', async () => {
    app = makeSeededApp();
    await app.post(`${P}/events`, t3()); // M5 +1
    await app.post(`${P}/events`, { ...t3(), id: 't4', type: 'TASK_DELAY', effects: [{ op: 'ADJUST_ESTIMATE', taskId: 'm3.dev', delta: 3 }] }); // M3 +3
    const seq = (await app.get(`${P}/attribution?strategy=sequential`)).body;
    const cf = (await app.get(`${P}/attribution?strategy=counterfactual`)).body;
    expect(seq.contributions.map((c: { days: number }) => c.days)).toEqual([1, 1]);
    expect(cf.contributions.map((c: { days: number }) => c.days)).toEqual([0, 1]);
    expect(cf.interaction).toBe(1);
    expect(cf.totalVariance).toBe(2);
  });

  it('ignores voided events and rejects an unknown strategy', async () => {
    await withHistory();
    await app.post(`${P}/events/t3/void`, { asOf: '2026-10-15' });
    const a = (await app.get(`${P}/attribution`)).body;
    expect(a.contributions.map((c: { eventId: string }) => c.eventId)).toEqual(['t2', 'hs']);
    expect(a.totalVariance).toBe(2);

    const bad = await app.get(`${P}/attribution?strategy=vibes`);
    expect(bad.status).toBe(400);
    expect(bad.body.message).toMatch(/sequential, counterfactual/);
  });
});

describe('the API and the engine agree exactly', () => {
  it('stored history equals a fresh engine replay of the same log', async () => {
    await withHistory();
    await app.post(`${P}/events/t3/void`, { asOf: '2026-10-15' });
    await app.post(`${P}/events`, { ...t2(), id: 'late', occurredAt: '2026-10-16', effects: [{ op: 'RECORD_PROGRESS', taskId: 'm5.dev', finishedOn: '2026-10-16' }], type: 'TASK_COMPLETION' });

    const events = (await app.get(`${P}/events`)).body as Array<Record<string, unknown>>;
    const voids = app.service.store.listVoids('thriveni');
    const log: LogEntry[] = [
      ...events.map((e) => ({ seq: e.seq as number, entry: { kind: 'EVENT', event: stripRow(e) } as LogEntry })),
      ...voids.map((v) => ({ seq: v.seq, entry: { kind: 'VOID', id: v.id, eventId: v.eventId, asOf: v.asOf, ...(v.reason ? { reason: v.reason } : {}) } as LogEntry })),
    ]
      .sort((a, b) => a.seq - b.seq)
      .map((x) => x.entry);

    const engine = buildHistory(buildThriveni(), log);
    const stored = (await app.get(`${P}/snapshots?full=true`)).body;
    expect(stored).toEqual(JSON.parse(JSON.stringify(engine.snapshots)));
  });
});

/** Drops the fields the server adds to a stored event. */
function stripRow(e: Record<string, unknown>): never {
  const { seq: _s, recordedAt: _r, status: _st, voidedBy: _v, ...event } = e;
  return event as never;
}

describe('before the project has started', () => {
  it('every history view says so, rather than returning something misleading', async () => {
    app = makeApp();
    await app.post('/projects', { id: 'thriveni', name: 'x', startDate: '2026-10-05' });
    for (const path of ['forecast', 'snapshots', 'timeline', 'history', 'advisories', 'attribution', 'snapshots/0', 'milestones/x/history']) {
      const r = await app.get(`${P}/${path}`);
      expect(r.status, path).toBe(409);
      expect(r.body.error, path).toBe('NOT_STARTED');
    }
  });

  it('and 404 for a project that does not exist', async () => {
    app = makeApp();
    for (const path of ['forecast', 'timeline', 'events', 'plan', 'validate']) {
      expect((await app.get(`/projects/ghost/${path}`)).status, path).toBe(404);
    }
  });
});
