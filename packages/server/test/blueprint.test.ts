import { buildThriveni } from '@multiverse/engine';
import { afterEach, describe, expect, it } from 'vitest';
import { loadBlueprint } from '../src/seed';
import { makeApp, makeSeededApp, P } from './helpers';
import type { TestApp } from './helpers';

let app: TestApp;
afterEach(async () => app.close());

const newProject = (a: TestApp, id = 'thriveni') =>
  a.post('/projects', { id, name: 'Thriveni VR Training', startDate: '2026-10-05', targetDate: '2026-10-30' });

/** The Thriveni blueprint in the shape the bulk endpoint takes. */
const blueprint = () => {
  const plan = buildThriveni();
  return {
    deliveryTaskId: plan.deliveryTaskId,
    teams: plan.teams,
    capacity: plan.capacity,
    modules: plan.modules,
    tasks: plan.tasks,
    dependencies: plan.dependencies.map(({ predecessorId, successorId }) => ({ predecessorId, successorId })),
    features: plan.features,
  };
};

describe('creating a project', () => {
  it('creates a draft with the default Sat/Sun weekend', async () => {
    app = makeApp();
    const r = await newProject(app);
    expect(r.status).toBe(201);
    expect(r.body.project).toMatchObject({
      id: 'thriveni',
      startDate: '2026-10-05',
      targetDate: '2026-10-30',
      weekendDays: [0, 6],
      holidays: [],
      startedAt: null,
      planRevision: 0,
    });
    expect(r.body.started).toBe(false);
    expect(r.body.forecast).toBeNull();
  });

  it('generates an id when none is given', async () => {
    app = makeApp();
    const r = await app.post('/projects', { name: 'My Big Project!', startDate: '2026-10-05' });
    expect(r.body.project.id).toMatch(/^my-big-project-[0-9a-f]{6}$/);
  });

  it('refuses a duplicate id', async () => {
    app = makeApp();
    await newProject(app);
    const r = await newProject(app);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('ALREADY_EXISTS');
  });

  it('lists projects and 404s on an unknown one', async () => {
    app = makeApp();
    await newProject(app, 'a');
    await newProject(app, 'b');
    expect((await app.get('/projects')).body.map((p: { id: string }) => p.id)).toEqual(['a', 'b']);
    const r = await app.get('/projects/nope');
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: 'NOT_FOUND', message: 'Project "nope" does not exist' });
  });

  it('changes labels freely but not the calendar once started', async () => {
    app = makeSeededApp();
    expect((await app.patch(P, { name: 'Renamed', targetDate: '2026-11-02' })).body.project).toMatchObject({ name: 'Renamed', targetDate: '2026-11-02' });
    const r = await app.patch(P, { startDate: '2026-11-02' });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('LOCKED');
  });
});

describe('the bulk blueprint', () => {
  it('loads a whole plan and reports it as valid', async () => {
    app = makeApp();
    await newProject(app);
    const r = await app.put(`${P}/blueprint`, blueprint());
    expect(r.status).toBe(200);
    expect(r.body.validation).toEqual({ valid: true, issues: [] });
    const view = r.body.project;
    expect(view.teams).toHaveLength(5);
    expect(view.modules).toHaveLength(9);
    expect(view.tasks).toHaveLength(plan().tasks.length);
    expect(view.dependencies).toHaveLength(plan().dependencies.length);
    expect(view.features).toHaveLength(4);
    expect(view.project.deliveryTaskId).toBe('proj.delivery');
  });

  it('accepts an invalid draft but says exactly what is wrong', async () => {
    app = makeApp();
    await newProject(app);
    const bad = blueprint();
    bad.dependencies.push({ predecessorId: 'proj.delivery', successorId: 'm1.sb' }); // delivery with a successor, and a cycle
    const r = await app.put(`${P}/blueprint`, bad);
    expect(r.status).toBe(200);
    expect(r.body.validation.valid).toBe(false);
    expect(r.body.validation.issues.join(' ')).toMatch(/must not have successors/);
    expect((await app.get(`${P}/validate`)).body.valid).toBe(false);
  });

  it('replaces an earlier draft entirely', async () => {
    app = makeApp();
    await newProject(app);
    await app.put(`${P}/blueprint`, blueprint());
    const smaller = blueprint();
    smaller.tasks = smaller.tasks.filter((t) => t.moduleId === 'm1' || t.moduleId === 'project');
    smaller.dependencies = [];
    smaller.features = [];
    smaller.modules = smaller.modules.filter((m) => m.id === 'm1' || m.id === 'project');
    await app.put(`${P}/blueprint`, smaller);
    expect((await app.get(P)).body.modules).toHaveLength(2);
  });

  it('is refused once the project has started', async () => {
    app = makeSeededApp();
    const r = await app.put(`${P}/blueprint`, blueprint());
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('PROJECT_STARTED');
  });

  it('rejects unknown fields and malformed data with the path of each problem', async () => {
    app = makeApp();
    await newProject(app);
    const bad = { ...blueprint(), extra: true };
    bad.tasks = [{ ...bad.tasks[0]!, estimate: -1, startNoEarlierThan: '2026-02-30' } as never];
    const r = await app.put(`${P}/blueprint`, bad);
    expect(r.status).toBe(400);
    const paths = r.body.details.map((d: { path: string }) => d.path);
    expect(paths).toEqual(expect.arrayContaining(['tasks.0.estimate', 'tasks.0.startNoEarlierThan']));
  });
});

const plan = () => buildThriveni();

describe('granular editing of a draft', () => {
  const draft = async () => {
    app = makeApp();
    await newProject(app);
    await app.post(`${P}/teams`, { id: 'dev', name: 'Dev' });
    await app.post(`${P}/capacity`, { teamId: 'dev', from: '2026-10-05', headcount: 4 });
    await app.post(`${P}/modules`, { id: 'm1', name: 'Module 1', kind: 'DELIVERABLE', scope: { inScope: ['intro scene'] } });
    await app.post(`${P}/tasks`, { id: 'a', moduleId: 'm1', teamId: 'dev', name: 'A', estimate: 2 });
    await app.post(`${P}/tasks`, { id: 'b', moduleId: 'm1', teamId: 'dev', name: 'B', estimate: 3 });
    await app.post(`${P}/tasks`, { id: 'done', moduleId: 'm1', teamId: 'dev', kind: 'MILESTONE', name: 'Done' });
    await app.post(`${P}/dependencies`, { predecessorId: 'a', successorId: 'b' });
    await app.post(`${P}/dependencies`, { predecessorId: 'b', successorId: 'done' });
    await app.put(`${P}/delivery`, { taskId: 'done' });
  };

  it('builds a project piece by piece', async () => {
    await draft();
    const view = (await app.get(P)).body;
    expect(view.tasks.map((t: { id: string }) => t.id)).toEqual(['a', 'b', 'done']);
    expect(view.modules[0].scope).toEqual({ inScope: ['intro scene'] });
    expect(view.dependencies).toEqual([
      { predecessorId: 'a', successorId: 'b', type: 'FS' },
      { predecessorId: 'b', successorId: 'done', type: 'FS' },
    ]);
    expect((await app.get(`${P}/validate`)).body).toEqual({ valid: true, issues: [] });
  });

  it('edits and deletes pieces', async () => {
    await draft();
    const patched = await app.patch(`${P}/tasks/a`, { name: 'A renamed', estimate: 4, ownerId: 'sam', startNoEarlierThan: '2026-10-12' });
    expect(patched.body).toMatchObject({ id: 'a', name: 'A renamed', estimate: 4, ownerId: 'sam', startNoEarlierThan: '2026-10-12' });
    const cleared = await app.patch(`${P}/tasks/a`, { ownerId: null, startNoEarlierThan: null });
    expect(cleared.body.ownerId).toBeUndefined();
    expect(cleared.body.startNoEarlierThan).toBeUndefined();
    expect((await app.patch(`${P}/modules/m1`, { name: 'Renamed' })).body.name).toBe('Renamed');
    expect((await app.del(`${P}/dependencies/a/b`)).status).toBe(204);
    expect((await app.del(`${P}/tasks/a`)).status).toBe(204);
    expect((await app.get(P)).body.tasks.map((t: { id: string }) => t.id)).toEqual(['b', 'done']);
  });

  it('manages capacity, teams and features', async () => {
    await draft();
    expect((await app.post(`${P}/capacity`, { teamId: 'dev', from: '2026-10-14', headcount: 2 })).status).toBe(201);
    expect((await app.get(P)).body.capacity).toHaveLength(2);
    expect((await app.del(`${P}/capacity?teamId=dev&from=2026-10-14`)).status).toBe(204);
    expect((await app.get(P)).body.capacity).toHaveLength(1);

    await app.post(`${P}/features`, { id: 'ext', name: 'Extinguisher', moduleIds: ['m1'] });
    const f = await app.patch(`${P}/features/ext`, { name: 'Fire extinguisher', moduleIds: [], sharedTaskId: 'a' });
    expect(f.body).toEqual({ id: 'ext', name: 'Fire extinguisher', moduleIds: [], sharedTaskId: 'a' });
    expect((await app.del(`${P}/features/ext`)).status).toBe(204);

    expect((await app.patch(`${P}/teams/dev`, { name: 'Developers' })).body.name).toBe('Developers');
  });

  it('404s on things that do not exist', async () => {
    await draft();
    expect((await app.patch(`${P}/tasks/ghost`, { name: 'x' })).status).toBe(404);
    expect((await app.del(`${P}/tasks/ghost`)).status).toBe(404);
    expect((await app.del(`${P}/dependencies/a/ghost`)).status).toBe(404);
    expect((await app.patch(`${P}/modules/ghost`, { name: 'x' })).status).toBe(404);
    expect((await app.put(`${P}/delivery`, { taskId: 'ghost' })).status).toBe(404);
  });

  it('turns broken references into a clear error rather than a crash', async () => {
    await draft();
    const r = await app.post(`${P}/tasks`, { id: 'orphan', moduleId: 'no-such-module', teamId: 'dev', name: 'x', estimate: 1 });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('REFERENCE');
  });
});

describe('locking a module', () => {
  it('refuses to start a project whose blueprint is invalid, listing every problem', async () => {
    app = makeApp();
    await newProject(app);
    const bad = blueprint();
    bad.tasks[0] = { ...bad.tasks[0]!, estimate: 1 };
    bad.tasks = bad.tasks.map((t) => (t.id === 'proj.delivery' ? { ...t, estimate: 2 } : t)); // milestone with effort
    await app.put(`${P}/blueprint`, bad);
    const r = await app.post(`${P}/modules/m1/lock`);
    expect(r.status).toBe(422);
    expect(r.body.error).toBe('INVALID_PLAN');
    expect(r.body.details.join(' ')).toMatch(/must have estimate 0/);
    expect((await app.get(P)).body.started).toBe(false);
  });

  it('the first lock starts the project and writes revision 0, the original plan', async () => {
    app = makeApp();
    await newProject(app);
    await app.put(`${P}/blueprint`, blueprint());
    expect((await app.get(`${P}/forecast`)).status).toBe(409); // not started

    const r = await app.post(`${P}/modules/m1/lock`);
    expect(r.status).toBe(200);
    expect(r.body.started).toBe(true);
    expect(r.body.project.planRevision).toBe(1);
    expect(r.body.modules.find((m: { id: string }) => m.id === 'm1').lockedAt).toBe(r.body.project.startedAt);
    expect(r.body.forecast).toMatchObject({ revision: 0, kind: 'BASELINE', variance: 0 });
    expect(r.body.forecast.forecastDelivery).toEqual({ offset: 20, date: '2026-10-30' });

    const snapshots = (await app.get(`${P}/snapshots`)).body;
    expect(snapshots).toHaveLength(1);
  });

  it('later locks only freeze their module', async () => {
    app = makeApp();
    await newProject(app);
    await app.put(`${P}/blueprint`, blueprint());
    await app.post(`${P}/modules/m1/lock`);
    const r = await app.post(`${P}/modules/m2/lock`);
    expect(r.body.project.planRevision).toBe(1); // no new history: the baseline did not change
    expect(r.body.modules.filter((m: { lockedAt: string | null }) => m.lockedAt !== null).map((m: { id: string }) => m.id)).toEqual(['m1', 'm2']);
    expect((await app.post(`${P}/modules/m2/lock`)).body.error).toBe('ALREADY_LOCKED');
    expect((await app.post(`${P}/modules/ghost/lock`)).status).toBe(404);
  });
});

describe('after locking', () => {
  it('a locked module cannot be edited through the API: 409 LOCKED', async () => {
    app = makeSeededApp();
    for (const r of [
      await app.patch(`${P}/tasks/m1.dev`, { estimate: 99 }),
      await app.del(`${P}/tasks/m1.dev`),
      await app.post(`${P}/tasks`, { id: 'new', moduleId: 'm1', teamId: 'dev', name: 'New', estimate: 1 }),
      await app.post(`${P}/dependencies`, { predecessorId: 'shared.menu', successorId: 'm1.dev' }),
      await app.patch(`${P}/modules/m1`, { name: 'Renamed' }),
      await app.del(`${P}/modules/m1`),
    ]) {
      expect(r.status).toBe(409);
      expect(r.body.error).toBe('LOCKED');
    }
    expect((await app.get(P)).body.tasks.find((t: { id: string }) => t.id === 'm1.dev').estimate).toBe(5);
  });

  it('the project baseline structures are frozen', async () => {
    app = makeSeededApp();
    expect((await app.post(`${P}/teams`, { id: 'ops', name: 'Ops' })).status).toBe(409);
    expect((await app.post(`${P}/capacity`, { teamId: 'dev', from: '2026-10-14', headcount: 2 })).status).toBe(409);
    expect((await app.post(`${P}/features`, { id: 'x', name: 'X' })).status).toBe(409);
  });
});

describe('loading a blueprint from code', () => {
  it('loadBlueprint (used by the seed) produces the same project as the bulk endpoint', async () => {
    app = makeApp();
    await newProject(app);
    const validation = loadBlueprint(app.service, 'thriveni', buildThriveni());
    expect(validation.valid).toBe(true);
    // Everything round-trips. Capacity rows come back sorted by team (the engine groups them by team, so order is irrelevant).
    const byTeam = <T extends { capacity: Array<{ teamId: string }> }>(p: T): T => ({
      ...p,
      capacity: [...p.capacity].sort((a, b) => a.teamId.localeCompare(b.teamId)),
    });
    expect(byTeam(app.service.plan('thriveni'))).toEqual(byTeam(buildThriveni()));
  });
});
