import { buildThriveni } from '@multiverse/engine';
import type { MilestoneDot } from '@multiverse/engine';
import { afterEach, describe, expect, it } from 'vitest';
import { loadBlueprint } from '../src/seed';
import { makeApp, makeSeededApp, P, sharedExt, t2, t3 } from './helpers';
import type { TestApp } from './helpers';

let app: TestApp;
afterEach(async () => app.close());

const dots = async (): Promise<MilestoneDot[]> => (await app.get(`${P}/timeline`)).body.milestones;
const dot = async (id: string): Promise<MilestoneDot | undefined> => (await dots()).find((d) => d.id === id);

describe('the project view’s dots', () => {
  it('come with the timeline: a start and a finish for each of the nine modules', async () => {
    app = makeSeededApp();
    const res = await app.get(`${P}/timeline`);
    expect(res.status).toBe(200);
    expect(res.body.milestones).toHaveLength(18);
    expect(res.body.flaggedTaskIds).toEqual([]);
    // The original line and its branches are still there, unchanged.
    expect(res.body.original.delivery).toEqual({ offset: 20, date: '2026-10-30' });
    expect(res.body.branches).toEqual([]);
  });

  it('move as the project moves', async () => {
    app = makeSeededApp();
    await app.post(`${P}/events`, t3());
    expect(await dot('finish:m5')).toMatchObject({ variance: 1, plan: { offset: 13 }, forecast: { offset: 14, date: '2026-10-22' } });
    expect(await dot('finish:project')).toMatchObject({ variance: 1, forecast: { date: '2026-11-02' } });
    expect(await dot('finish:m1')).toMatchObject({ variance: 0 });
  });
});

describe('flagging a task as a milestone', () => {
  it('adds a dot for it, and remembers', async () => {
    app = makeSeededApp();
    const res = await app.put(`${P}/milestone-flags/proj.review`, {});
    expect(res.status).toBe(200);
    expect(res.body).toEqual(['proj.review']);
    expect(await dot('task:proj.review')).toMatchObject({ kind: 'MILESTONE', name: 'Client review', flagged: true, original: { offset: 14, date: '2026-10-22' } });
    expect((await app.get(`${P}/milestone-flags`)).body).toEqual(['proj.review']);
    expect((await app.get(`${P}/timeline`)).body.flaggedTaskIds).toEqual(['proj.review']);
  });

  it('does nothing the second time', async () => {
    app = makeSeededApp();
    await app.put(`${P}/milestone-flags/proj.review`, {});
    expect((await app.put(`${P}/milestone-flags/proj.review`, {})).body).toEqual(['proj.review']);
    expect((await dots()).filter((d) => d.id === 'task:proj.review')).toHaveLength(1);
  });

  it('can be taken off, and taking off one that is not there is fine', async () => {
    app = makeSeededApp();
    await app.put(`${P}/milestone-flags/proj.review`, {});
    await app.put(`${P}/milestone-flags/proj.qa`, {});
    expect((await app.del(`${P}/milestone-flags/proj.review`)).body).toEqual(['proj.qa']);
    expect(await dot('task:proj.review')).toBeUndefined();
    expect((await app.del(`${P}/milestone-flags/never-flagged`)).status).toBe(200);
  });

  it('lists them in the order they were flagged', async () => {
    app = makeSeededApp();
    for (const id of ['proj.qa', 'm5.dev', 'proj.review']) await app.put(`${P}/milestone-flags/${id}`, {});
    expect((await app.get(`${P}/milestone-flags`)).body).toEqual(['proj.qa', 'm5.dev', 'proj.review']);
  });

  it('is refused for a task that does not exist', async () => {
    app = makeSeededApp();
    const res = await app.put(`${P}/milestone-flags/nope`, {});
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NOT_FOUND');
    expect((await app.get(`${P}/milestone-flags`)).body).toEqual([]);
  });

  it('is allowed for work added after the project started, which exists only in the log', async () => {
    app = makeSeededApp();
    expect((await app.put(`${P}/milestone-flags/proj.ext`, {})).status).toBe(404); // not there yet
    await app.post(`${P}/events`, sharedExt());
    expect((await app.put(`${P}/milestone-flags/proj.ext`, {})).status).toBe(200);
    expect(await dot('task:proj.ext')).toMatchObject({ name: 'Extinguisher system', original: null, plan: null, flagged: true });
  });

  it('is a view setting, so the project starting or events being recorded do not freeze it', async () => {
    app = makeSeededApp();
    await app.post(`${P}/events`, t2());
    expect((await app.put(`${P}/milestone-flags/proj.qa`, {})).status).toBe(200);
    expect((await app.del(`${P}/milestone-flags/proj.qa`)).status).toBe(200);
  });

  it('can be done before the project starts, and is kept when it does', async () => {
    app = makeApp();
    await app.post('/projects', { id: 'p', name: 'P', startDate: '2026-10-05', targetDate: '2026-10-30' });
    expect((await app.put('/projects/p/milestone-flags/proj.qa', {})).status).toBe(404); // no blueprint yet
    loadBlueprint(app.service, 'p', buildThriveni());
    expect((await app.put('/projects/p/milestone-flags/proj.qa', {})).status).toBe(200);
    for (const m of buildThriveni().modules) app.service.lockModule('p', m.id);
    const flagged = ((await app.get('/projects/p/timeline')).body.milestones as MilestoneDot[]).find((d) => d.id === 'task:proj.qa');
    expect(flagged).toMatchObject({ flagged: true, name: 'QA' });
  });

  it('belongs to one project', async () => {
    app = makeSeededApp();
    await app.post('/projects', { id: 'other', name: 'Other', startDate: '2026-10-05' });
    loadBlueprint(app.service, 'other', buildThriveni());
    for (const m of buildThriveni().modules) app.service.lockModule('other', m.id);

    await app.put(`${P}/milestone-flags/proj.review`, {});
    expect((await app.get('/projects/other/milestone-flags')).body).toEqual([]);
    expect((await app.get('/projects/other/timeline')).body.milestones).toHaveLength(18);
    expect((await app.get(`${P}/timeline`)).body.milestones).toHaveLength(19);
  });

  it('is 404 for a project that does not exist', async () => {
    app = makeApp();
    expect((await app.put('/projects/nope/milestone-flags/x', {})).status).toBe(404);
    expect((await app.get('/projects/nope/milestone-flags')).status).toBe(404);
  });
});

describe('a module on its own', () => {
  it('has a dot for each task at the start', async () => {
    app = makeSeededApp();
    const res = await app.get(`${P}/modules/m5/timeline`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ moduleId: 'm5', name: 'Module 5', kind: 'DELIVERABLE', branches: [], markers: [] });
    expect(res.body.dots.map((d: { taskId: string }) => d.taskId)).toEqual(['m5.sb', 'm5.art', 'm5.dev', 'm5.alpha']);
  });

  it('has a branch for each task that moved, and says why', async () => {
    app = makeSeededApp();
    await app.post(`${P}/events`, t3());
    const view = (await app.get(`${P}/modules/m5/timeline`)).body;
    expect(view.branches.map((b: { taskId: string }) => b.taskId)).toEqual(['m5.dev', 'm5.alpha']);
    expect(view.branches[0].steps[0]).toMatchObject({ eventId: 't3', delta: 1, origin: 'DIRECT' });
    expect(view.branches[1].steps[0]).toMatchObject({ origin: 'PROPAGATED', fromTaskIds: ['m5.dev'] });
    expect(view.markers.map((m: { eventId: string }) => m.eventId)).toEqual(['t3']);
  });

  it('leaves another module alone', async () => {
    app = makeSeededApp();
    await app.post(`${P}/events`, t3());
    expect((await app.get(`${P}/modules/m1/timeline`)).body.branches).toEqual([]);
  });

  it('is 404 for a module that does not exist', async () => {
    app = makeSeededApp();
    const res = await app.get(`${P}/modules/nope/timeline`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NOT_FOUND');
  });

  it('needs the project to have started', async () => {
    app = makeApp();
    await app.post('/projects', { id: 'p', name: 'P', startDate: '2026-10-05' });
    const res = await app.get('/projects/p/modules/m1/timeline');
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('NOT_STARTED');
  });
});
