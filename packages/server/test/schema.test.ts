import { afterEach, describe, expect, it } from 'vitest';
import { makeApp, makeSeededApp, t3 } from './helpers';
import type { TestApp } from './helpers';

let app: TestApp;
afterEach(async () => app.close());

/** Raw SQL, bypassing the API entirely: the database itself must refuse. */
const sql = (db: TestApp['db'], statement: string) => () => db.prepare(statement).run();

describe('locks enforced by the database, not only by the API', () => {
  it('a locked module cannot have tasks inserted, changed or deleted', () => {
    app = makeSeededApp();
    expect(sql(app.db, `UPDATE tasks SET estimate = 99 WHERE project_id = 'thriveni' AND id = 'm1.dev'`)).toThrow(/LOCKED/);
    expect(sql(app.db, `DELETE FROM tasks WHERE project_id = 'thriveni' AND id = 'm1.dev'`)).toThrow(/LOCKED/);
    expect(
      sql(app.db, `INSERT INTO tasks (project_id, id, module_id, team_id, kind, name, estimate) VALUES ('thriveni', 'sneaky', 'm1', 'dev', 'TASK', 'x', 1)`),
    ).toThrow(/LOCKED/);
    // moving a task into a locked module is refused too
    expect(sql(app.db, `UPDATE tasks SET module_id = 'm1' WHERE project_id = 'thriveni' AND id = 'shared.menu'`)).toThrow(/LOCKED/);
  });

  it('a dependency into a locked module cannot be added or removed', () => {
    app = makeSeededApp();
    expect(sql(app.db, `INSERT INTO dependencies (project_id, predecessor_id, successor_id) VALUES ('thriveni', 'shared.menu', 'm1.dev')`)).toThrow(/LOCKED/);
    expect(sql(app.db, `DELETE FROM dependencies WHERE project_id = 'thriveni' AND successor_id = 'm1.art'`)).toThrow(/LOCKED/);
  });

  it('a locked module cannot be renamed, unlocked or deleted', () => {
    app = makeSeededApp();
    expect(sql(app.db, `UPDATE modules SET name = 'x' WHERE project_id = 'thriveni' AND id = 'm1'`)).toThrow(/LOCKED/);
    expect(sql(app.db, `UPDATE modules SET locked_at = NULL WHERE project_id = 'thriveni' AND id = 'm1'`)).toThrow(/LOCKED/);
    expect(sql(app.db, `DELETE FROM modules WHERE project_id = 'thriveni' AND id = 'm1'`)).toThrow(/LOCKED/);
  });

  it('once the project has started, its calendar, teams, capacity and features are frozen', () => {
    app = makeSeededApp();
    expect(sql(app.db, `UPDATE projects SET start_date = '2026-11-02' WHERE id = 'thriveni'`)).toThrow(/LOCKED/);
    expect(sql(app.db, `UPDATE projects SET holidays = '["2026-10-08"]' WHERE id = 'thriveni'`)).toThrow(/LOCKED/);
    expect(sql(app.db, `UPDATE projects SET started_at = NULL WHERE id = 'thriveni'`)).toThrow(/LOCKED/);
    expect(sql(app.db, `INSERT INTO teams (project_id, id, name) VALUES ('thriveni', 'ops', 'Ops')`)).toThrow(/LOCKED/);
    expect(sql(app.db, `UPDATE team_capacity SET headcount = 1 WHERE project_id = 'thriveni' AND team_id = 'dev'`)).toThrow(/LOCKED/);
    expect(sql(app.db, `DELETE FROM features WHERE project_id = 'thriveni' AND id = 'extinguisher'`)).toThrow(/LOCKED/);
    // name and target date are only labels
    expect(sql(app.db, `UPDATE projects SET name = 'Renamed', target_date = '2026-11-02' WHERE id = 'thriveni'`)).not.toThrow();
  });

  it('events, voids and snapshots are append-only', async () => {
    app = makeSeededApp();
    expect((await app.post('/projects/thriveni/events', t3())).status).toBe(201);
    await app.post('/projects/thriveni/events/t3/void', { asOf: '2026-10-15' });

    for (const table of ['events', 'event_voids', 'forecast_snapshots']) {
      expect(sql(app.db, `DELETE FROM ${table}`), `delete from ${table}`).toThrow(/append-only/);
    }
    expect(sql(app.db, `UPDATE events SET title = 'rewritten'`)).toThrow(/append-only/);
    expect(sql(app.db, `UPDATE event_voids SET reason = 'rewritten'`)).toThrow(/append-only/);
    expect(sql(app.db, `UPDATE forecast_snapshots SET variance_days = 0`)).toThrow(/append-only/);
  });

  it('does not get in the way of an unlocked project', () => {
    app = makeApp();
    app.service.createProject({ id: 'draft', name: 'Draft', startDate: '2026-10-05', weekendDays: [0, 6], holidays: [] });
    app.service.store.insertTeam('draft', { id: 'dev', name: 'Dev' });
    app.service.store.insertModule('draft', { id: 'm', name: 'M', kind: 'DELIVERABLE' });
    app.service.store.insertTask('draft', { id: 't', moduleId: 'm', teamId: 'dev', kind: 'TASK', name: 'T', estimate: 1 });
    expect(sql(app.db, `UPDATE tasks SET estimate = 5 WHERE project_id = 'draft' AND id = 't'`)).not.toThrow();
    expect(sql(app.db, `DELETE FROM tasks WHERE project_id = 'draft' AND id = 't'`)).not.toThrow();
  });
});

describe('keys are scoped by project', () => {
  it('two projects can use the same task ids', async () => {
    app = makeApp();
    for (const id of ['a', 'b']) {
      app.service.createProject({ id, name: id, startDate: '2026-10-05', weekendDays: [0, 6], holidays: [] });
      app.service.store.insertTeam(id, { id: 'dev', name: 'Dev' });
      app.service.store.insertModule(id, { id: 'm', name: 'M', kind: 'DELIVERABLE' });
      app.service.store.insertTask(id, { id: 'same', moduleId: 'm', teamId: 'dev', kind: 'TASK', name: 'T', estimate: 1 });
    }
    expect(app.service.store.listTasks('a')).toHaveLength(1);
    expect(app.service.store.listTasks('b')).toHaveLength(1);
  });
});
