import { LEGACY_PHASES } from '@multiverse/engine';
import type {
  CapacityPoint,
  Dependency,
  Event,
  Feature,
  ForecastSnapshot,
  ISODate,
  LogEntry,
  Module,
  ModuleKind,
  PhaseModel,
  Plan,
  PlanEdit,
  Task,
  Team,
  VoidEntry,
} from '@multiverse/engine';
import type { Db } from './db/database';

type Row = Record<string, unknown>;
type Param = string | number | null;

export interface ProjectRecord {
  id: string;
  /** The project's own phases. A project made before phases were its own has the legacy list. */
  phases: PhaseModel;
  name: string;
  startDate: ISODate;
  targetDate: ISODate | null;
  weekendDays: number[];
  holidays: ISODate[];
  deliveryTaskId: string | null;
  planRevision: number;
  startedAt: string | null;
  createdAt: string;
}

export interface ModuleRecord extends Module {
  scope: unknown;
  lockedAt: string | null;
}

/** An event as stored: the engine's Event plus where it sits in the log and whether it has been withdrawn. */
export interface EventRecord extends Event {
  seq: number;
  recordedAt: string;
  status: 'ACTIVE' | 'VOIDED';
  voidedBy: string | null;
}

export interface VoidRecord extends VoidEntry {
  seq: number;
  recordedAt: string;
}

/** A plan edit as stored: where it sits in the log, and when it was recorded. */
export interface PlanEditRecord extends PlanEdit {
  seq: number;
  recordedAt: string;
}

const nul = <T>(v: T | undefined | null): T | null => (v === undefined ? null : v);
const str = (v: unknown): string => v as string;
const optStr = (v: unknown): string | undefined => (v === null || v === undefined ? undefined : (v as string));
const optNum = (v: unknown): number | undefined => (v === null || v === undefined ? undefined : (v as number));

/** All SQL lives here. Methods take plain values and return plain values; transactions are the caller's job. */
export class Store {
  constructor(private readonly db: Db) {}

  private all(sql: string, ...params: Param[]): Row[] {
    return this.db.prepare(sql).all(...params) as Row[];
  }
  private get(sql: string, ...params: Param[]): Row | undefined {
    return this.db.prepare(sql).get(...params) as Row | undefined;
  }
  private run(sql: string, ...params: Param[]): void {
    this.db.prepare(sql).run(...params);
  }

  // ---------------------------------------------------------------------------------------------- projects

  insertProject(p: ProjectRecord): void {
    this.run(
      `INSERT INTO projects (id, name, start_date, target_date, weekend_days, holidays, delivery_task_id, plan_revision, started_at, created_at, phases)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      p.id, p.name, p.startDate, p.targetDate, JSON.stringify(p.weekendDays), JSON.stringify(p.holidays),
      p.deliveryTaskId, p.planRevision, p.startedAt, p.createdAt, JSON.stringify(p.phases),
    );
  }

  private toProject(r: Row): ProjectRecord {
    return {
      id: str(r.id),
      name: str(r.name),
      startDate: str(r.start_date),
      targetDate: optStr(r.target_date) ?? null,
      weekendDays: JSON.parse(str(r.weekend_days)) as number[],
      holidays: JSON.parse(str(r.holidays)) as string[],
      deliveryTaskId: optStr(r.delivery_task_id) ?? null,
      planRevision: r.plan_revision as number,
      startedAt: optStr(r.started_at) ?? null,
      createdAt: str(r.created_at),
      phases: r.phases === null || r.phases === undefined ? LEGACY_PHASES : (JSON.parse(str(r.phases)) as PhaseModel),
    };
  }

  getProject(id: string): ProjectRecord | undefined {
    const r = this.get('SELECT * FROM projects WHERE id = ?', id);
    return r ? this.toProject(r) : undefined;
  }

  listProjects(): ProjectRecord[] {
    return this.all('SELECT * FROM projects ORDER BY created_at, id').map((r) => this.toProject(r));
  }

  updateProject(
    id: string,
    patch: Partial<Pick<ProjectRecord, 'name' | 'startDate' | 'targetDate' | 'weekendDays' | 'holidays' | 'deliveryTaskId' | 'phases'>>,
  ): void {
    const sets: string[] = [];
    const values: Param[] = [];
    const set = (column: string, value: Param) => {
      sets.push(`${column} = ?`);
      values.push(value);
    };
    if (patch.name !== undefined) set('name', patch.name);
    if (patch.startDate !== undefined) set('start_date', patch.startDate);
    if (patch.targetDate !== undefined) set('target_date', patch.targetDate);
    if (patch.weekendDays !== undefined) set('weekend_days', JSON.stringify(patch.weekendDays));
    if (patch.holidays !== undefined) set('holidays', JSON.stringify(patch.holidays));
    if (patch.deliveryTaskId !== undefined) set('delivery_task_id', patch.deliveryTaskId);
    if (patch.phases !== undefined) set('phases', JSON.stringify(patch.phases));
    if (sets.length === 0) return;
    this.run(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`, ...values, id);
  }

  markStarted(id: string, at: string): void {
    this.run('UPDATE projects SET started_at = ? WHERE id = ?', at, id);
  }

  setPlanRevision(id: string, revision: number): void {
    this.run('UPDATE projects SET plan_revision = ? WHERE id = ?', revision, id);
  }

  // ---------------------------------------------------------------------------------------------- milestone flags

  /** The tasks flagged as project milestones, in the order they were flagged. */
  listMilestoneFlags(pid: string): string[] {
    return this.all('SELECT task_id FROM milestone_flags WHERE project_id = ? ORDER BY flagged_at, rowid', pid).map((r) => str(r.task_id));
  }

  /** Idempotent: flagging a flagged task changes nothing. */
  addMilestoneFlag(pid: string, taskId: string, at: string, by: string | null): void {
    this.run('INSERT OR IGNORE INTO milestone_flags (project_id, task_id, flagged_at, flagged_by) VALUES (?, ?, ?, ?)', pid, taskId, at, by);
  }

  removeMilestoneFlag(pid: string, taskId: string): void {
    this.run('DELETE FROM milestone_flags WHERE project_id = ? AND task_id = ?', pid, taskId);
  }

  // ---------------------------------------------------------------------------------------------- blueprint

  listTeams(pid: string): Team[] {
    return this.all('SELECT id, name FROM teams WHERE project_id = ? ORDER BY rowid', pid).map((r) => ({ id: str(r.id), name: str(r.name) }));
  }
  insertTeam(pid: string, t: Team): void {
    this.run('INSERT INTO teams (project_id, id, name) VALUES (?, ?, ?)', pid, t.id, t.name);
  }
  updateTeam(pid: string, id: string, name: string): number {
    return Number(this.db.prepare('UPDATE teams SET name = ? WHERE project_id = ? AND id = ?').run(name, pid, id).changes);
  }
  deleteTeam(pid: string, id: string): number {
    return Number(this.db.prepare('DELETE FROM teams WHERE project_id = ? AND id = ?').run(pid, id).changes);
  }

  listCapacity(pid: string): CapacityPoint[] {
    return this.all('SELECT team_id, from_date, headcount FROM team_capacity WHERE project_id = ? ORDER BY team_id, from_date', pid).map((r) => ({
      teamId: str(r.team_id),
      from: str(r.from_date),
      headcount: r.headcount as number,
    }));
  }
  upsertCapacity(pid: string, c: CapacityPoint): void {
    this.run(
      `INSERT INTO team_capacity (project_id, team_id, from_date, headcount) VALUES (?, ?, ?, ?)
       ON CONFLICT (project_id, team_id, from_date) DO UPDATE SET headcount = excluded.headcount`,
      pid, c.teamId, c.from, c.headcount,
    );
  }
  deleteCapacity(pid: string, teamId: string, from: string): number {
    return Number(this.db.prepare('DELETE FROM team_capacity WHERE project_id = ? AND team_id = ? AND from_date = ?').run(pid, teamId, from).changes);
  }

  listModules(pid: string): ModuleRecord[] {
    return this.all('SELECT * FROM modules WHERE project_id = ? ORDER BY rowid', pid).map((r) => ({
      id: str(r.id),
      name: str(r.name),
      kind: str(r.kind) as ModuleKind,
      scope: JSON.parse(str(r.scope_json)) as unknown,
      lockedAt: optStr(r.locked_at) ?? null,
    }));
  }
  getModule(pid: string, id: string): ModuleRecord | undefined {
    return this.listModules(pid).find((m) => m.id === id);
  }
  insertModule(pid: string, m: Module & { scope?: unknown }): void {
    this.run('INSERT INTO modules (project_id, id, name, kind, scope_json) VALUES (?, ?, ?, ?, ?)', pid, m.id, m.name, m.kind, JSON.stringify(m.scope ?? {}));
  }
  updateModule(pid: string, id: string, patch: { name?: string; scope?: unknown }): number {
    const sets: string[] = [];
    const values: Param[] = [];
    if (patch.name !== undefined) {
      sets.push('name = ?');
      values.push(patch.name);
    }
    if (patch.scope !== undefined) {
      sets.push('scope_json = ?');
      values.push(JSON.stringify(patch.scope));
    }
    if (sets.length === 0) return this.getModule(pid, id) ? 1 : 0;
    return Number(this.db.prepare(`UPDATE modules SET ${sets.join(', ')} WHERE project_id = ? AND id = ?`).run(...values, pid, id).changes);
  }
  deleteModule(pid: string, id: string): number {
    return Number(this.db.prepare('DELETE FROM modules WHERE project_id = ? AND id = ?').run(pid, id).changes);
  }
  lockModule(pid: string, id: string, at: string): void {
    this.run('UPDATE modules SET locked_at = ? WHERE project_id = ? AND id = ?', at, pid, id);
  }

  listTasks(pid: string): Task[] {
    return this.all('SELECT * FROM tasks WHERE project_id = ? ORDER BY rowid', pid).map((r) => {
      const task: Task = {
        id: str(r.id),
        moduleId: str(r.module_id),
        teamId: str(r.team_id),
        kind: str(r.kind) as Task['kind'],
        name: str(r.name),
        estimate: r.estimate as number,
      };
      const snE = optStr(r.start_no_earlier_than);
      const owner = optStr(r.owner_id);
      const feature = optStr(r.feature_id);
      if (snE !== undefined) task.startNoEarlierThan = snE;
      if (owner !== undefined) task.ownerId = owner;
      if (feature !== undefined) task.featureId = feature;
      return task;
    });
  }
  getTask(pid: string, id: string): Task | undefined {
    return this.listTasks(pid).find((t) => t.id === id);
  }
  insertTask(pid: string, t: Omit<Task, 'progress'>): void {
    this.run(
      `INSERT INTO tasks (project_id, id, module_id, team_id, owner_id, kind, name, estimate, start_no_earlier_than, feature_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      pid, t.id, t.moduleId, t.teamId, nul(t.ownerId), t.kind, t.name, t.estimate, nul(t.startNoEarlierThan), nul(t.featureId),
    );
  }
  /** `null` clears an optional field; `undefined` leaves it alone. */
  updateTask(
    pid: string,
    id: string,
    patch: Partial<Pick<Task, 'moduleId' | 'teamId' | 'kind' | 'name' | 'estimate'>> & {
      ownerId?: string | null;
      startNoEarlierThan?: string | null;
      featureId?: string | null;
    },
  ): number {
    const columns: Array<[string, Param | undefined]> = [
      ['module_id', patch.moduleId],
      ['team_id', patch.teamId],
      ['kind', patch.kind],
      ['name', patch.name],
      ['estimate', patch.estimate],
      ['owner_id', patch.ownerId],
      ['start_no_earlier_than', patch.startNoEarlierThan],
      ['feature_id', patch.featureId],
    ];
    const present = columns.filter(([, v]) => v !== undefined) as Array<[string, Param]>;
    if (present.length === 0) return this.getTask(pid, id) ? 1 : 0;
    const sql = `UPDATE tasks SET ${present.map(([c]) => `${c} = ?`).join(', ')} WHERE project_id = ? AND id = ?`;
    return Number(this.db.prepare(sql).run(...present.map(([, v]) => v), pid, id).changes);
  }
  deleteTask(pid: string, id: string): number {
    return Number(this.db.prepare('DELETE FROM tasks WHERE project_id = ? AND id = ?').run(pid, id).changes);
  }

  listDependencies(pid: string): Dependency[] {
    return this.all('SELECT predecessor_id, successor_id FROM dependencies WHERE project_id = ? ORDER BY rowid', pid).map((r) => ({
      predecessorId: str(r.predecessor_id),
      successorId: str(r.successor_id),
      type: 'FS' as const,
    }));
  }
  insertDependency(pid: string, predecessorId: string, successorId: string): void {
    this.run("INSERT INTO dependencies (project_id, predecessor_id, successor_id, type) VALUES (?, ?, ?, 'FS')", pid, predecessorId, successorId);
  }
  deleteDependency(pid: string, predecessorId: string, successorId: string): number {
    return Number(
      this.db.prepare('DELETE FROM dependencies WHERE project_id = ? AND predecessor_id = ? AND successor_id = ?').run(pid, predecessorId, successorId).changes,
    );
  }

  listFeatures(pid: string): Feature[] {
    const links = this.all('SELECT feature_id, module_id FROM module_features WHERE project_id = ? ORDER BY rowid', pid);
    return this.all('SELECT * FROM features WHERE project_id = ? ORDER BY rowid', pid).map((r) => {
      const feature: Feature = {
        id: str(r.id),
        name: str(r.name),
        moduleIds: links.filter((l) => l.feature_id === r.id).map((l) => str(l.module_id)),
      };
      const shared = optStr(r.shared_task_id);
      if (shared !== undefined) feature.sharedTaskId = shared;
      return feature;
    });
  }
  insertFeature(pid: string, f: Feature): void {
    this.run('INSERT INTO features (project_id, id, name, shared_task_id) VALUES (?, ?, ?, ?)', pid, f.id, f.name, nul(f.sharedTaskId));
    this.setFeatureModules(pid, f.id, f.moduleIds);
  }
  updateFeature(pid: string, id: string, patch: { name?: string; sharedTaskId?: string | null; moduleIds?: string[] }): number {
    const sets: string[] = [];
    const values: Param[] = [];
    if (patch.name !== undefined) {
      sets.push('name = ?');
      values.push(patch.name);
    }
    if (patch.sharedTaskId !== undefined) {
      sets.push('shared_task_id = ?');
      values.push(patch.sharedTaskId);
    }
    let changes = 0;
    if (sets.length > 0) {
      changes = Number(this.db.prepare(`UPDATE features SET ${sets.join(', ')} WHERE project_id = ? AND id = ?`).run(...values, pid, id).changes);
    } else {
      changes = this.get('SELECT 1 AS x FROM features WHERE project_id = ? AND id = ?', pid, id) ? 1 : 0;
    }
    if (changes > 0 && patch.moduleIds !== undefined) this.setFeatureModules(pid, id, patch.moduleIds);
    return changes;
  }
  private setFeatureModules(pid: string, featureId: string, moduleIds: string[]): void {
    this.run('DELETE FROM module_features WHERE project_id = ? AND feature_id = ?', pid, featureId);
    for (const m of new Set(moduleIds)) {
      this.run('INSERT INTO module_features (project_id, module_id, feature_id) VALUES (?, ?, ?)', pid, m, featureId);
    }
  }
  deleteFeature(pid: string, id: string): number {
    return Number(this.db.prepare('DELETE FROM features WHERE project_id = ? AND id = ?').run(pid, id).changes);
  }

  /** Removes the whole blueprint. Only possible before the project starts (triggers refuse afterwards). */
  clearBlueprint(pid: string): void {
    for (const table of ['dependencies', 'module_features', 'features', 'tasks', 'modules', 'team_capacity', 'teams']) {
      this.run(`DELETE FROM ${table} WHERE project_id = ?`, pid);
    }
  }

  /** The baseline plan as the engine sees it. A project with no delivery milestone yet gets '' (and will fail validation). */
  loadPlan(project: ProjectRecord): Plan {
    const pid = project.id;
    const plan: Plan = {
      calendar: { startDate: project.startDate, weekendDays: project.weekendDays, holidays: project.holidays },
      teams: this.listTeams(pid),
      capacity: this.listCapacity(pid),
      modules: this.listModules(pid).map(({ id, name, kind }) => ({ id, name, kind })),
      tasks: this.listTasks(pid),
      dependencies: this.listDependencies(pid),
      deliveryTaskId: project.deliveryTaskId ?? '',
      phases: project.phases,
    };
    const features = this.listFeatures(pid);
    if (features.length > 0) plan.features = features;
    return plan;
  }

  // ---------------------------------------------------------------------------------------------- log

  /** The next position in the project's log, shared by events, plan edits and voids. */
  nextSeq(pid: string): number {
    const r = this.get(
      `SELECT MAX(seq) AS m FROM (
         SELECT seq FROM events WHERE project_id = ?
         UNION ALL SELECT seq FROM plan_edits WHERE project_id = ?
         UNION ALL SELECT seq FROM event_voids WHERE project_id = ?)`,
      pid, pid, pid,
    );
    return ((r?.m as number | null) ?? 0) + 1;
  }

  idInUse(pid: string, id: string): boolean {
    return (
      this.get('SELECT 1 AS x FROM events WHERE project_id = ? AND id = ?', pid, id) !== undefined ||
      this.get('SELECT 1 AS x FROM plan_edits WHERE project_id = ? AND id = ?', pid, id) !== undefined ||
      this.get('SELECT 1 AS x FROM event_voids WHERE project_id = ? AND id = ?', pid, id) !== undefined
    );
  }

  insertPlanEdit(pid: string, seq: number, recordedAt: string, e: PlanEdit): void {
    this.run(
      'INSERT INTO plan_edits (project_id, id, seq, title, reason, created_by, as_of, recorded_at, effects_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      pid, e.id, seq, e.title, nul(e.reason), e.createdBy, e.asOf, recordedAt, JSON.stringify(e.effects),
    );
  }

  listPlanEdits(pid: string): PlanEditRecord[] {
    return this.all('SELECT * FROM plan_edits WHERE project_id = ? ORDER BY seq', pid).map((r) => {
      const edit: PlanEditRecord = {
        id: str(r.id),
        title: str(r.title),
        createdBy: str(r.created_by),
        asOf: str(r.as_of),
        effects: JSON.parse(str(r.effects_json)) as PlanEdit['effects'],
        seq: r.seq as number,
        recordedAt: str(r.recorded_at),
      };
      const reason = optStr(r.reason);
      if (reason !== undefined) edit.reason = reason;
      return edit;
    });
  }

  insertEvent(pid: string, seq: number, recordedAt: string, e: Event): void {
    this.run(
      `INSERT INTO events (project_id, id, seq, type, category, title, description, phase, module_id, task_id, created_by,
         source_team_id, affected_team_id, affected_person_id, occurred_at, recorded_at, as_of, parent_event_id,
         linked_requirement_id, linked_feature_id, could_have_been_earlier, est_effort, est_schedule, actual_effort,
         actual_schedule, effects_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      pid, e.id, seq, e.type, e.category, e.title, e.description, e.phase, nul(e.moduleId), nul(e.taskId), e.createdBy,
      nul(e.sourceTeamId), nul(e.affectedTeamId), nul(e.affectedOwnerId), e.occurredAt, recordedAt, e.asOf, nul(e.parentEventId),
      nul(e.linkedRequirementId), nul(e.linkedFeatureId),
      e.couldHaveBeenEarlier === undefined ? null : e.couldHaveBeenEarlier ? 1 : 0,
      nul(e.estimatedEffortImpact), nul(e.estimatedScheduleImpact), nul(e.actualEffortImpact), nul(e.actualScheduleImpact),
      JSON.stringify(e.effects),
    );
  }

  insertVoid(pid: string, seq: number, recordedAt: string, v: VoidEntry): void {
    this.run(
      'INSERT INTO event_voids (project_id, id, seq, event_id, as_of, reason, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      pid, v.id, seq, v.eventId, v.asOf, nul(v.reason), recordedAt,
    );
  }

  private toEvent(r: Row): Event {
    const e: Event = {
      id: str(r.id),
      type: str(r.type) as Event['type'],
      category: str(r.category),
      title: str(r.title),
      description: str(r.description),
      phase: str(r.phase) as Event['phase'],
      createdBy: str(r.created_by),
      occurredAt: str(r.occurred_at),
      asOf: str(r.as_of),
      effects: JSON.parse(str(r.effects_json)) as Event['effects'],
    };
    const optional: Array<[keyof Event, unknown]> = [
      ['moduleId', optStr(r.module_id)],
      ['taskId', optStr(r.task_id)],
      ['sourceTeamId', optStr(r.source_team_id)],
      ['affectedTeamId', optStr(r.affected_team_id)],
      ['affectedOwnerId', optStr(r.affected_person_id)],
      ['parentEventId', optStr(r.parent_event_id)],
      ['linkedRequirementId', optStr(r.linked_requirement_id)],
      ['linkedFeatureId', optStr(r.linked_feature_id)],
      ['couldHaveBeenEarlier', r.could_have_been_earlier === null || r.could_have_been_earlier === undefined ? undefined : r.could_have_been_earlier === 1],
      ['estimatedEffortImpact', optNum(r.est_effort)],
      ['estimatedScheduleImpact', optNum(r.est_schedule)],
      ['actualEffortImpact', optNum(r.actual_effort)],
      ['actualScheduleImpact', optNum(r.actual_schedule)],
    ];
    for (const [key, value] of optional) {
      if (value !== undefined) (e as unknown as Record<string, unknown>)[key] = value;
    }
    return e;
  }

  /** The log in recorded order: what the engine replays. */
  loadLog(pid: string): LogEntry[] {
    const entries: Array<{ seq: number; entry: LogEntry }> = [];
    for (const r of this.all('SELECT * FROM events WHERE project_id = ?', pid)) {
      entries.push({ seq: r.seq as number, entry: { kind: 'EVENT', event: this.toEvent(r) } });
    }
    for (const p of this.listPlanEdits(pid)) {
      const { seq: _seq, recordedAt: _at, ...edit } = p;
      entries.push({ seq: p.seq, entry: { kind: 'PLAN', edit } });
    }
    for (const v of this.listVoids(pid)) {
      const { seq: _seq, recordedAt: _at, ...entry } = v;
      entries.push({ seq: v.seq, entry });
    }
    return entries.sort((a, b) => a.seq - b.seq).map((x) => x.entry);
  }

  listVoids(pid: string): VoidRecord[] {
    return this.all('SELECT * FROM event_voids WHERE project_id = ? ORDER BY seq', pid).map((r) => {
      const v: VoidRecord = { kind: 'VOID', id: str(r.id), eventId: str(r.event_id), asOf: str(r.as_of), seq: r.seq as number, recordedAt: str(r.recorded_at) };
      const reason = optStr(r.reason);
      if (reason !== undefined) v.reason = reason;
      return v;
    });
  }

  listEvents(pid: string): EventRecord[] {
    const voidedBy = new Map(this.listVoids(pid).map((v) => [v.eventId, v.id]));
    return this.all('SELECT * FROM events WHERE project_id = ? ORDER BY seq', pid).map((r) => {
      const event = this.toEvent(r);
      const by = voidedBy.get(event.id) ?? null;
      return { ...event, seq: r.seq as number, recordedAt: str(r.recorded_at), status: by === null ? 'ACTIVE' : 'VOIDED', voidedBy: by };
    });
  }

  // ---------------------------------------------------------------------------------------------- snapshots

  insertSnapshot(pid: string, planRevision: number, s: ForecastSnapshot, recordedAt: string): void {
    this.run(
      `INSERT INTO forecast_snapshots (project_id, plan_revision, revision, kind, event_id, void_id, as_of, recorded_at,
         baseline_delivery, forecast_delivery, variance_days, step_days, effort_impact, engine_version, snapshot_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      pid, planRevision, s.revision, s.kind, s.eventId, s.voidId, s.asOf, recordedAt,
      s.baselineDelivery.date, s.forecastDelivery.date, s.variance, s.stepDays, s.effortImpact, s.engineVersion, JSON.stringify(s),
    );
  }

  listSnapshots(pid: string, planRevision: number): ForecastSnapshot[] {
    return this.all('SELECT snapshot_json FROM forecast_snapshots WHERE project_id = ? AND plan_revision = ? ORDER BY revision', pid, planRevision).map(
      (r) => JSON.parse(str(r.snapshot_json)) as ForecastSnapshot,
    );
  }

  /** How many plan revisions the project's history has been built under. */
  listPlanRevisions(pid: string): Array<{ planRevision: number; snapshots: number; engineVersion: string; recordedAt: string }> {
    return this.all(
      `SELECT plan_revision, COUNT(*) AS n, MIN(engine_version) AS v, MIN(recorded_at) AS at
       FROM forecast_snapshots WHERE project_id = ? GROUP BY plan_revision ORDER BY plan_revision`,
      pid,
    ).map((r) => ({ planRevision: r.plan_revision as number, snapshots: r.n as number, engineVersion: str(r.v), recordedAt: str(r.at) }));
  }
}
