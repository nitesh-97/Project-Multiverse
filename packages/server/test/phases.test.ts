import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DEFAULT_PHASES, LEGACY_PHASES, buildThriveni } from '@multiverse/engine';
import type { PhaseModel } from '@multiverse/engine';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/database';
import { ProjectService } from '../src/service';
import { loadBlueprint } from '../src/seed';
import { makeApp, makeSeededApp } from './helpers';
import type { TestApp } from './helpers';

let app: TestApp;
afterEach(async () => app.close());

const BUILDING: PhaseModel = {
  phases: [
    { id: 'BRIEF', name: 'Brief' },
    { id: 'DRAWINGS', name: 'Drawings' },
    { id: 'CONSTRUCTION', name: 'Construction' },
    { id: 'INSPECTION', name: 'Inspection' },
    { id: 'HANDOVER', name: 'Handover' },
  ],
  buildStarts: 'CONSTRUCTION',
  afterBuild: 'INSPECTION',
};

const create = (a: TestApp, extra: Record<string, unknown> = {}, id = 'p') => a.post('/projects', { id, name: 'P', startDate: '2026-10-05', ...extra });

/** A started project whose plan is Thriveni's, with the phases it was created with. */
async function started(extra: Record<string, unknown> = {}) {
  app = makeApp();
  expect((await create(app, extra)).status).toBe(201);
  expect(loadBlueprint(app.service, 'p', buildThriveni()).valid).toBe(true);
  for (const m of buildThriveni().modules) app.service.lockModule('p', m.id);
}

const event = (over: Record<string, unknown> = {}) => ({
  id: 'e1',
  type: 'SCOPE_CHANGE',
  title: 'Something',
  phase: 'CONSTRUCTION',
  createdBy: 'tester',
  occurredAt: '2026-10-14',
  effects: [{ op: 'ADJUST_ESTIMATE', taskId: 'm5.dev', delta: 1 }],
  ...over,
});

describe('a project has its own phases', () => {
  it('gets a generic starting set when it does not say', async () => {
    app = makeApp();
    const res = await create(app);
    expect(res.body.project.phases).toEqual(DEFAULT_PHASES);
  });

  it('keeps the ones it is created with', async () => {
    app = makeApp();
    const res = await create(app, { phases: BUILDING });
    expect(res.status).toBe(201);
    expect(res.body.project.phases).toEqual(BUILDING);
    expect((await app.get('/projects/p')).body.project.phases).toEqual(BUILDING);
    expect(((await app.get('/projects')).body as Array<{ phases: PhaseModel }>)[0]?.phases).toEqual(BUILDING);
  });

  it('is Thriveni’s own list for the seeded Thriveni project', async () => {
    app = makeSeededApp();
    expect((await app.get('/projects/thriveni')).body.project.phases).toEqual(LEGACY_PHASES);
  });

  it('puts them in the plan the engine sees', async () => {
    app = makeApp();
    await create(app, { phases: BUILDING });
    expect(app.service.plan('p').phases).toEqual(BUILDING);
  });
});

describe('checking the phases a person gives', () => {
  it.each([
    ['too few', { phases: [{ id: 'A', name: 'A' }], buildStarts: 'A', afterBuild: 'A' }, 'A project needs at least two phases'],
    ['a missing "building starts"', { ...BUILDING, buildStarts: 'NOPE' }, 'is not one of the phases'],
    ['a missing "after building"', { ...BUILDING, afterBuild: 'NOPE' }, 'is not one of the phases'],
    ['the wrong order', { ...BUILDING, buildStarts: 'INSPECTION', afterBuild: 'CONSTRUCTION' }, 'must come after'],
    ['a duplicate id', { ...BUILDING, phases: [...BUILDING.phases, { id: 'BRIEF', name: 'Again' }] }, 'Duplicate phase ids: BRIEF'],
    ['an id with a space', { ...BUILDING, phases: [{ id: 'has space', name: 'X' }, ...BUILDING.phases] }, 'must not be empty or contain spaces'],
  ])('refuses %s, and says why', async (_label, phases, message) => {
    app = makeApp();
    const res = await create(app, { phases });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain(message);
  });

  it('refuses a misspelled field in a phase', async () => {
    app = makeApp();
    expect((await create(app, { phases: { ...BUILDING, buildStart: 'BRIEF' } })).status).toBe(400);
  });
});

describe('changing them', () => {
  it('is allowed while the project is still being planned', async () => {
    app = makeApp();
    await create(app);
    const res = await app.patch('/projects/p', { phases: BUILDING });
    expect(res.status).toBe(200);
    expect(res.body.project.phases).toEqual(BUILDING);
  });

  it('is refused once the project has started, because events already refer to them', async () => {
    await started({ phases: BUILDING });
    const res = await app.patch('/projects/p', { phases: DEFAULT_PHASES });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('LOCKED');
    expect((await app.get('/projects/p')).body.project.phases).toEqual(BUILDING);
  });
});

describe('an event must be about one of the project’s phases', () => {
  it('is accepted for one of its own', async () => {
    await started({ phases: BUILDING });
    expect((await app.post('/projects/p/events', event({ phase: 'CONSTRUCTION' }))).status).toBe(201);
  });

  it('is refused for a phase from another kind of project, listing the ones there are', async () => {
    await started({ phases: BUILDING });
    const res = await app.post('/projects/p/events', event({ phase: 'DEVELOPMENT' }));
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('EVENT_REJECTED');
    expect(res.body.message).toContain('BRIEF, DRAWINGS, CONSTRUCTION, INSPECTION, HANDOVER');
    expect((await app.get('/projects/p/events')).body).toEqual([]); // and nothing was written
  });

  it('is judged by the generic set for a project that did not choose', async () => {
    await started();
    expect((await app.post('/projects/p/events', event({ phase: 'BUILD' }))).status).toBe(201);
    expect((await app.post('/projects/p/events', event({ id: 'e2', phase: 'DEVELOPMENT' }))).status).toBe(422);
  });

  it('is judged by the legacy list for Thriveni, as before', async () => {
    app = makeSeededApp();
    expect((await app.post('/projects/thriveni/events', event({ phase: 'DEVELOPMENT' }))).status).toBe(201);
  });
});

describe('what counts as late follows them in the retrospective', () => {
  it('uses the project’s "building starts" and "first phase after building"', async () => {
    await started({ phases: BUILDING });
    await app.post('/projects/p/events', event({ id: 'early', type: 'FEEDBACK', phase: 'DRAWINGS', effects: [] }));
    await app.post('/projects/p/events', event({ id: 'late', type: 'FEEDBACK', phase: 'INSPECTION', effects: [] }));
    await app.post('/projects/p/events', event({ id: 'scope', type: 'SCOPE_CHANGE', phase: 'CONSTRUCTION' }));
    const retro = (await app.get('/projects/p/retro')).body;
    expect(retro.feedback.byPhase.map((p: { phase: string }) => p.phase)).toEqual(['DRAWINGS', 'INSPECTION']);
    expect(retro.feedback.afterDevelopment).toEqual({ count: 1, percent: 50 });
    expect(retro.scope).toMatchObject({ changes: 1, afterDevelopmentStarted: 1 });
    const categories = (await app.get('/projects/p/attribution')).body.byCategory.map((c: { category: string }) => c.category);
    expect(categories).toContain('Late scope discovery');
  });
});

describe('a database made before phases were the project’s own', () => {
  it('gains the column without losing anything, and its projects keep the legacy phases', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mv-old-'));
    const file = join(dir, 'old.sqlite');
    try {
      // What the previous version had: a projects table with no phases column, and a project in it.
      const old = new DatabaseSync(file);
      old.exec(`CREATE TABLE projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, start_date TEXT NOT NULL, target_date TEXT,
        weekend_days TEXT NOT NULL DEFAULT '[0,6]', holidays TEXT NOT NULL DEFAULT '[]',
        delivery_task_id TEXT, plan_revision INTEGER NOT NULL DEFAULT 0, started_at TEXT, created_at TEXT NOT NULL)`);
      old.prepare(`INSERT INTO projects (id, name, start_date, target_date, created_at) VALUES ('old', 'Old project', '2026-10-05', '2026-10-30', '2026-09-01T09:00:00.000Z')`).run();
      old.close();

      const db = openDatabase(file);
      try {
        const svc = new ProjectService(db);
        const project = svc.requireProject('old');
        expect(project).toMatchObject({ id: 'old', name: 'Old project', targetDate: '2026-10-30', startedAt: null });
        expect(project.phases).toEqual(LEGACY_PHASES);
        // And it can be used: a new project beside it gets the generic set.
        expect(svc.createProject({ id: 'new', name: 'New', startDate: '2026-10-05', weekendDays: [0, 6], holidays: [] }).phases).toEqual(DEFAULT_PHASES);
        // Opening it again changes nothing.
        db.close();
        const again = openDatabase(file);
        expect(new ProjectService(again).requireProject('old').phases).toEqual(LEGACY_PHASES);
        again.close();
      } finally {
        try {
          db.close();
        } catch {
          // already closed above
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
