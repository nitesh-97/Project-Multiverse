/**
 * SQLite schema (DESIGN.md §4). Applied idempotently on every start.
 *
 * What is enforced here, in the database, not only in code:
 *  - a task of a locked module cannot be inserted, changed or deleted: new work after lock must be an event
 *  - a dependency whose successor is in a locked module cannot be added or removed
 *  - a locked module cannot be changed or deleted
 *  - once a project has started, its plan rows, calendar, teams, capacity and features are frozen: later changes are
 *    recorded as plan edits or events, never as edits to the rows
 *  - events, voids, plan edits and forecast snapshots are append-only
 *
 * Every trigger message starts with "LOCKED:" so the API can turn it into a 409.
 */

const LOCKED_MODULE = `EXISTS (SELECT 1 FROM modules m WHERE m.project_id = %ROW%.project_id AND m.id = %ROW%.module_id AND m.locked_at IS NOT NULL)`;

const FROZEN_BASELINE = 'LOCKED: the project has started, so its baseline can no longer change; record changes as events';
const FROZEN_PLAN =
  'LOCKED: the project has started, so its plan cannot be edited directly; record a plan edit (for modules that have not started) or an event (for modules that have)';

/** Triggers that make a table read-only once its project has started. */
function frozenAfterStart(table: string, message: string): string {
  return (['INSERT', 'UPDATE', 'DELETE'] as const)
    .map((op) => {
      const row = op === 'INSERT' ? 'NEW' : 'OLD';
      return `
CREATE TRIGGER IF NOT EXISTS ${table}_frozen_${op.toLowerCase()} BEFORE ${op} ON ${table}
WHEN EXISTS (SELECT 1 FROM projects p WHERE p.id = ${row}.project_id AND p.started_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, '${message}'); END;`;
    })
    .join('\n');
}

/** Triggers that make a table append-only. */
function appendOnly(table: string): string {
  return (['UPDATE', 'DELETE'] as const)
    .map(
      (op) => `
CREATE TRIGGER IF NOT EXISTS ${table}_append_only_${op.toLowerCase()} BEFORE ${op} ON ${table}
BEGIN SELECT RAISE(ABORT, 'LOCKED: ${table} is append-only; corrections are new rows'); END;`,
    )
    .join('\n');
}

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  start_date       TEXT NOT NULL,
  target_date      TEXT,
  weekend_days     TEXT NOT NULL DEFAULT '[0,6]',
  holidays         TEXT NOT NULL DEFAULT '[]',
  delivery_task_id TEXT,
  plan_revision    INTEGER NOT NULL DEFAULT 0,
  started_at       TEXT,
  created_at       TEXT NOT NULL,
  -- The project's own phases (JSON). NULL on projects made before phases were the project's own: the legacy list.
  phases           TEXT
);

CREATE TABLE IF NOT EXISTS teams (
  project_id TEXT NOT NULL REFERENCES projects(id),
  id         TEXT NOT NULL,
  name       TEXT NOT NULL,
  PRIMARY KEY (project_id, id)
);

-- The earliest row per team is its planned headcount.
CREATE TABLE IF NOT EXISTS team_capacity (
  project_id TEXT NOT NULL,
  team_id    TEXT NOT NULL,
  from_date  TEXT NOT NULL,
  headcount  REAL NOT NULL CHECK (headcount >= 0),
  PRIMARY KEY (project_id, team_id, from_date),
  FOREIGN KEY (project_id, team_id) REFERENCES teams(project_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS modules (
  project_id TEXT NOT NULL REFERENCES projects(id),
  id         TEXT NOT NULL,
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('DELIVERABLE', 'SHARED', 'PROJECT')),
  scope_json TEXT NOT NULL DEFAULT '{}',
  locked_at  TEXT,
  PRIMARY KEY (project_id, id)
);

CREATE TABLE IF NOT EXISTS tasks (
  project_id            TEXT NOT NULL,
  id                    TEXT NOT NULL,
  module_id             TEXT NOT NULL,
  team_id               TEXT NOT NULL,
  owner_id              TEXT,
  kind                  TEXT NOT NULL CHECK (kind IN ('TASK', 'MILESTONE')),
  name                  TEXT NOT NULL,
  estimate              REAL NOT NULL CHECK (estimate >= 0),
  start_no_earlier_than TEXT,
  feature_id            TEXT,
  PRIMARY KEY (project_id, id),
  FOREIGN KEY (project_id, module_id) REFERENCES modules(project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, team_id)   REFERENCES teams(project_id, id)
);

CREATE TABLE IF NOT EXISTS dependencies (
  project_id     TEXT NOT NULL,
  predecessor_id TEXT NOT NULL,
  successor_id   TEXT NOT NULL,
  type           TEXT NOT NULL DEFAULT 'FS' CHECK (type = 'FS'),
  PRIMARY KEY (project_id, predecessor_id, successor_id),
  FOREIGN KEY (project_id, predecessor_id) REFERENCES tasks(project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, successor_id)   REFERENCES tasks(project_id, id) ON DELETE CASCADE
);

-- shared_task_id has no foreign key: it may name a task that only exists once an event has added it.
CREATE TABLE IF NOT EXISTS features (
  project_id     TEXT NOT NULL REFERENCES projects(id),
  id             TEXT NOT NULL,
  name           TEXT NOT NULL,
  shared_task_id TEXT,
  PRIMARY KEY (project_id, id)
);

-- Tasks the project manager flagged as project milestones: which dots the project view shows. A view setting, not part
-- of the plan, so it can change at any time and is not frozen when the project starts. The id can be a task that
-- only exists in the log (work added by an event), so it is not a foreign key.
CREATE TABLE IF NOT EXISTS milestone_flags (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id    TEXT NOT NULL,
  flagged_at TEXT NOT NULL,
  flagged_by TEXT,
  PRIMARY KEY (project_id, task_id)
);

CREATE TABLE IF NOT EXISTS module_features (
  project_id TEXT NOT NULL,
  module_id  TEXT NOT NULL,
  feature_id TEXT NOT NULL,
  PRIMARY KEY (project_id, module_id, feature_id),
  FOREIGN KEY (project_id, module_id)  REFERENCES modules(project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, feature_id) REFERENCES features(project_id, id) ON DELETE CASCADE
);

-- Events and voids share one sequence per project: the order of the log.
CREATE TABLE IF NOT EXISTS events (
  project_id            TEXT NOT NULL REFERENCES projects(id),
  id                    TEXT NOT NULL,
  seq                   INTEGER NOT NULL,
  type                  TEXT NOT NULL,
  category              TEXT NOT NULL,
  title                 TEXT NOT NULL,
  description           TEXT NOT NULL,
  phase                 TEXT NOT NULL,
  module_id             TEXT,
  task_id               TEXT,
  created_by            TEXT NOT NULL,
  source_team_id        TEXT,
  affected_team_id      TEXT,
  affected_person_id    TEXT,
  occurred_at           TEXT NOT NULL,
  recorded_at           TEXT NOT NULL,
  as_of                 TEXT NOT NULL,
  parent_event_id       TEXT,
  linked_requirement_id TEXT,
  linked_feature_id     TEXT,
  could_have_been_earlier INTEGER,
  est_effort            REAL,
  est_schedule          REAL,
  actual_effort         REAL,
  actual_schedule       REAL,
  effects_json          TEXT NOT NULL,
  PRIMARY KEY (project_id, id),
  UNIQUE (project_id, seq)
);

-- Planning changes to modules that had not started, made after the project started. Part of the same log.
CREATE TABLE IF NOT EXISTS plan_edits (
  project_id   TEXT NOT NULL REFERENCES projects(id),
  id           TEXT NOT NULL,
  seq          INTEGER NOT NULL,
  title        TEXT NOT NULL,
  reason       TEXT,
  created_by   TEXT NOT NULL,
  as_of        TEXT NOT NULL,
  recorded_at  TEXT NOT NULL,
  effects_json TEXT NOT NULL,
  PRIMARY KEY (project_id, id),
  UNIQUE (project_id, seq)
);

CREATE TABLE IF NOT EXISTS event_voids (
  project_id  TEXT NOT NULL REFERENCES projects(id),
  id          TEXT NOT NULL,
  seq         INTEGER NOT NULL,
  event_id    TEXT NOT NULL,
  as_of       TEXT NOT NULL,
  reason      TEXT,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (project_id, id),
  UNIQUE (project_id, seq),
  FOREIGN KEY (project_id, event_id) REFERENCES events(project_id, id)
);

-- One row per snapshot per plan revision. A planning edit after the project started rebuilds history under a
-- new plan_revision; earlier revisions are kept, never updated or deleted.
CREATE TABLE IF NOT EXISTS forecast_snapshots (
  project_id        TEXT NOT NULL REFERENCES projects(id),
  plan_revision     INTEGER NOT NULL,
  revision          INTEGER NOT NULL,
  kind              TEXT NOT NULL,
  event_id          TEXT,
  void_id           TEXT,
  as_of             TEXT,
  recorded_at       TEXT NOT NULL,
  baseline_delivery TEXT NOT NULL,
  forecast_delivery TEXT NOT NULL,
  variance_days     REAL NOT NULL,
  step_days         REAL NOT NULL,
  effort_impact     REAL NOT NULL,
  engine_version    TEXT NOT NULL,
  snapshot_json     TEXT NOT NULL,
  PRIMARY KEY (project_id, plan_revision, revision)
);

-- A module that has been locked is read-only.
CREATE TRIGGER IF NOT EXISTS modules_locked_update BEFORE UPDATE ON modules
WHEN OLD.locked_at IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'LOCKED: this module is locked; record changes as events'); END;

CREATE TRIGGER IF NOT EXISTS modules_locked_delete BEFORE DELETE ON modules
WHEN OLD.locked_at IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'LOCKED: this module is locked and cannot be deleted'); END;

CREATE TRIGGER IF NOT EXISTS tasks_locked_insert BEFORE INSERT ON tasks
WHEN ${LOCKED_MODULE.replaceAll('%ROW%', 'NEW')}
BEGIN SELECT RAISE(ABORT, 'LOCKED: the module is locked; record new work as an event'); END;

CREATE TRIGGER IF NOT EXISTS tasks_locked_update BEFORE UPDATE ON tasks
WHEN ${LOCKED_MODULE.replaceAll('%ROW%', 'OLD')} OR ${LOCKED_MODULE.replaceAll('%ROW%', 'NEW')}
BEGIN SELECT RAISE(ABORT, 'LOCKED: the module is locked; record changes as events'); END;

CREATE TRIGGER IF NOT EXISTS tasks_locked_delete BEFORE DELETE ON tasks
WHEN ${LOCKED_MODULE.replaceAll('%ROW%', 'OLD')}
BEGIN SELECT RAISE(ABORT, 'LOCKED: the module is locked; its tasks cannot be deleted'); END;

CREATE TRIGGER IF NOT EXISTS dependencies_locked_insert BEFORE INSERT ON dependencies
WHEN EXISTS (
  SELECT 1 FROM tasks t JOIN modules m ON m.project_id = t.project_id AND m.id = t.module_id
  WHERE t.project_id = NEW.project_id AND t.id = NEW.successor_id AND m.locked_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'LOCKED: the successor task is in a locked module; record dependency changes as events'); END;

CREATE TRIGGER IF NOT EXISTS dependencies_locked_delete BEFORE DELETE ON dependencies
WHEN EXISTS (
  SELECT 1 FROM tasks t JOIN modules m ON m.project_id = t.project_id AND m.id = t.module_id
  WHERE t.project_id = OLD.project_id AND t.id = OLD.successor_id AND m.locked_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'LOCKED: the successor task is in a locked module; record dependency changes as events'); END;

CREATE TRIGGER IF NOT EXISTS projects_baseline_frozen BEFORE UPDATE OF start_date, weekend_days, holidays, delivery_task_id ON projects
WHEN OLD.started_at IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'LOCKED: the project has started, so its calendar and delivery milestone can no longer change'); END;

CREATE TRIGGER IF NOT EXISTS projects_phases_frozen BEFORE UPDATE OF phases ON projects
WHEN OLD.started_at IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'LOCKED: the project has started, so its phases can no longer change; events already refer to them'); END;

CREATE TRIGGER IF NOT EXISTS projects_started_once BEFORE UPDATE OF started_at ON projects
WHEN OLD.started_at IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'LOCKED: the project has already started'); END;

-- Once the project has started, the plan rows are the plan as it was at the start. Every later change is a recorded
-- plan edit or event, so history shows it; the rows themselves never change. (Locking a module sets locked_at,
-- which is the one column that may still change.)
${frozenAfterStart('tasks', FROZEN_PLAN)}
${frozenAfterStart('dependencies', FROZEN_PLAN)}
${frozenAfterStart('teams', FROZEN_BASELINE)}
${frozenAfterStart('team_capacity', FROZEN_BASELINE)}
${frozenAfterStart('features', FROZEN_BASELINE)}
${frozenAfterStart('module_features', FROZEN_BASELINE)}

CREATE TRIGGER IF NOT EXISTS modules_frozen_insert BEFORE INSERT ON modules
WHEN EXISTS (SELECT 1 FROM projects p WHERE p.id = NEW.project_id AND p.started_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, '${FROZEN_PLAN}'); END;

CREATE TRIGGER IF NOT EXISTS modules_frozen_delete BEFORE DELETE ON modules
WHEN EXISTS (SELECT 1 FROM projects p WHERE p.id = OLD.project_id AND p.started_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, '${FROZEN_PLAN}'); END;

CREATE TRIGGER IF NOT EXISTS modules_frozen_update BEFORE UPDATE OF name, kind, scope_json ON modules
WHEN EXISTS (SELECT 1 FROM projects p WHERE p.id = OLD.project_id AND p.started_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, '${FROZEN_PLAN}'); END;

${appendOnly('events')}
${appendOnly('event_voids')}
${appendOnly('plan_edits')}
${appendOnly('forecast_snapshots')}
`;
