import { randomUUID } from 'node:crypto';
import {
  EffectError,
  PlanError,
  attributeDelay,
  buildHistory,
  buildTimeline,
  counterfactualStrategy,
  explainSnapshot,
  findAdvisories,
  firstBreach,
  forecastDrift,
  milestoneHistory,
  previewEvent as enginePreview,
  recordEvent as engineRecord,
  sequentialStrategy,
  startProject,
  voidEvent as engineVoid,
} from '@multiverse/engine';
import type {
  Advisory,
  Attribution,
  ChangeExplanation,
  Event,
  ForecastSnapshot,
  ProjectState,
  VoidEntry,
} from '@multiverse/engine';
import { transaction } from './db/database';
import type { Db } from './db/database';
import { ApiError, badRequest, conflict, notFound } from './errors';
import { asEffects } from './schemas';
import type { EventInput } from './schemas';
import { Store } from './store';
import type { EventRecord, ModuleRecord, ProjectRecord } from './store';
import type { Plan } from '@multiverse/engine';

export interface ServiceOptions {
  /** ISO timestamp for "now". Injected so tests are deterministic. */
  now?: () => string;
}

export interface RecordedEvent {
  event: EventRecord;
  snapshot: ForecastSnapshot;
  explanation: ChangeExplanation;
}

export interface BlueprintValidation {
  valid: boolean;
  issues: string[];
}

/** A snapshot without the per-task detail: enough to chart a forecast. */
export interface SnapshotSummary {
  revision: number;
  kind: ForecastSnapshot['kind'];
  eventId: string | null;
  voidId: string | null;
  asOf: string | null;
  baselineDelivery: ForecastSnapshot['baselineDelivery'];
  forecastDelivery: ForecastSnapshot['forecastDelivery'];
  variance: number;
  stepDays: number;
  effortImpact: number;
  engineVersion: string;
}

const STRATEGIES = { sequential: sequentialStrategy, counterfactual: counterfactualStrategy } as const;
export type StrategyName = keyof typeof STRATEGIES;
export const strategyNames = Object.keys(STRATEGIES) as StrategyName[];

const last = <T>(items: readonly T[]): T => items[items.length - 1] as T;

export function summarize(s: ForecastSnapshot): SnapshotSummary {
  return {
    revision: s.revision,
    kind: s.kind,
    eventId: s.eventId,
    voidId: s.voidId,
    asOf: s.asOf,
    baselineDelivery: s.baselineDelivery,
    forecastDelivery: s.forecastDelivery,
    variance: s.variance,
    stepDays: s.stepDays,
    effortImpact: s.effortImpact,
    engineVersion: s.engineVersion,
  };
}

/** The domain operations. Each public method is one atomic unit of work. */
export class ProjectService {
  readonly store: Store;
  private readonly now: () => string;

  constructor(
    private readonly db: Db,
    options: ServiceOptions = {},
  ) {
    this.store = new Store(db);
    this.now = options.now ?? (() => new Date().toISOString());
  }

  private newId(prefix: string): string {
    return `${prefix}-${randomUUID().slice(0, 8)}`;
  }

  // ---------------------------------------------------------------------------------------------- projects

  requireProject(id: string): ProjectRecord {
    const p = this.store.getProject(id);
    if (!p) throw notFound('Project', id);
    return p;
  }

  private requireStarted(id: string): ProjectRecord {
    const p = this.requireProject(id);
    if (p.startedAt === null) {
      throw conflict('NOT_STARTED', 'The project has not started. Lock at least one module first (POST /projects/:id/modules/:moduleId/lock).');
    }
    return p;
  }

  createProject(input: {
    id?: string | undefined;
    name: string;
    startDate: string;
    targetDate?: string | undefined;
    weekendDays: number[];
    holidays: string[];
  }): ProjectRecord {
    return transaction(this.db, () => {
      const id = input.id ?? `${input.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'project'}-${randomUUID().slice(0, 6)}`;
      this.store.insertProject({
        id,
        name: input.name,
        startDate: input.startDate,
        targetDate: input.targetDate ?? null,
        weekendDays: input.weekendDays,
        holidays: input.holidays,
        deliveryTaskId: null,
        planRevision: 0,
        startedAt: null,
        createdAt: this.now(),
      });
      return this.requireProject(id);
    });
  }

  listProjects(): ProjectRecord[] {
    return this.store.listProjects();
  }

  /** The whole project as stored, plus the current forecast if it has started. */
  projectView(id: string) {
    const project = this.requireProject(id);
    const stored = project.startedAt !== null ? this.store.listSnapshots(id, project.planRevision) : [];
    const latest = stored.length > 0 ? last(stored) : null;
    return {
      project,
      started: project.startedAt !== null,
      teams: this.store.listTeams(id),
      capacity: this.store.listCapacity(id),
      modules: this.store.listModules(id),
      tasks: this.store.listTasks(id),
      dependencies: this.store.listDependencies(id),
      features: this.store.listFeatures(id),
      forecast: latest ? summarize(latest) : null,
    };
  }

  /** Would the blueprint as it stands be accepted for locking? Reports every problem at once. */
  validate(id: string): BlueprintValidation {
    const project = this.requireProject(id);
    try {
      startProject(this.store.loadPlan(project));
      return { valid: true, issues: [] };
    } catch (e) {
      if (e instanceof PlanError) return { valid: false, issues: e.issues };
      throw e;
    }
  }

  // ---------------------------------------------------------------------------------------------- blueprint

  /**
   * Runs a blueprint edit atomically. If the project has already started, the edit is a planning change to a
   * module that is not locked yet: history is rebuilt under a new plan revision, and the edit is refused if an
   * existing event could no longer be applied.
   */
  edit<T>(projectId: string, mutate: (store: Store, project: ProjectRecord) => T, options: { replan?: boolean } = {}): T {
    return transaction(this.db, () => {
      const project = this.requireProject(projectId);
      const result = mutate(this.store, project);
      if ((options.replan ?? true) && project.startedAt !== null) {
        try {
          this.rematerialize(projectId);
        } catch (e) {
          if (e instanceof PlanError || e instanceof EffectError) {
            throw conflict('EDIT_BREAKS_HISTORY', `This change would invalidate the project's history, so nothing was changed. ${e.message}`);
          }
          throw e;
        }
      }
      return result;
    });
  }

  /** Replaces the whole draft blueprint. Only before the project has started. */
  replaceBlueprint(
    projectId: string,
    bp: {
      deliveryTaskId: string;
      teams: Array<{ id: string; name: string }>;
      capacity: Array<{ teamId: string; from: string; headcount: number }>;
      modules: Array<{ id: string; name: string; kind: 'DELIVERABLE' | 'SHARED' | 'PROJECT'; scope?: Record<string, unknown> | undefined }>;
      tasks: Array<Parameters<Store['insertTask']>[1]>;
      dependencies: Array<{ predecessorId: string; successorId: string }>;
      features: Array<{ id: string; name: string; moduleIds: string[]; sharedTaskId?: string | undefined }>;
    },
  ): BlueprintValidation {
    return transaction(this.db, () => {
      const project = this.requireProject(projectId);
      if (project.startedAt !== null) {
        throw conflict('PROJECT_STARTED', 'The project has started, so its blueprint can no longer be replaced. Edit unlocked modules individually, or record events.');
      }
      const s = this.store;
      s.clearBlueprint(projectId);
      for (const t of bp.teams) s.insertTeam(projectId, t);
      for (const c of bp.capacity) s.upsertCapacity(projectId, c);
      for (const m of bp.modules) s.insertModule(projectId, m);
      for (const t of bp.tasks) s.insertTask(projectId, t);
      for (const d of bp.dependencies) s.insertDependency(projectId, d.predecessorId, d.successorId);
      for (const f of bp.features) s.insertFeature(projectId, { id: f.id, name: f.name, moduleIds: f.moduleIds, ...(f.sharedTaskId !== undefined ? { sharedTaskId: f.sharedTaskId } : {}) });
      s.updateProject(projectId, { deliveryTaskId: bp.deliveryTaskId });
      return this.validate(projectId);
    });
  }

  /**
   * Starts execution of a module: from now on its scope is read-only and changes are events. The first lock starts
   * the project and writes revision 0, the original plan.
   */
  lockModule(projectId: string, moduleId: string): ModuleRecord {
    return transaction(this.db, () => {
      const project = this.requireProject(projectId);
      const module = this.store.getModule(projectId, moduleId);
      if (!module) throw notFound('Module', moduleId);
      if (module.lockedAt !== null) throw conflict('ALREADY_LOCKED', `Module "${moduleId}" is already locked`);

      const firstLock = project.startedAt === null;
      if (firstLock) startProject(this.store.loadPlan(project)); // PlanError -> 422 listing every problem

      const at = this.now();
      this.store.lockModule(projectId, moduleId, at);
      if (firstLock) {
        this.store.markStarted(projectId, at);
        this.rematerialize(projectId);
      }
      return this.store.getModule(projectId, moduleId) as ModuleRecord;
    });
  }

  // ---------------------------------------------------------------------------------------------- history

  /** Rebuilds the engine's view of the project from the baseline rows and the log. */
  private replay(projectId: string): ProjectState {
    const project = this.requireProject(projectId);
    try {
      return buildHistory(this.store.loadPlan(project), this.store.loadLog(projectId));
    } catch (e) {
      if (e instanceof PlanError || e instanceof EffectError) {
        throw new ApiError(500, 'HISTORY_UNREPLAYABLE', `The stored history can no longer be replayed: ${e.message}`);
      }
      throw e;
    }
  }

  /** Replay for the current forecast, with the stored snapshots (what was recorded at the time) as history. */
  private stored(projectId: string): { project: ProjectRecord; state: ProjectState } {
    const project = this.requireStarted(projectId);
    const state = this.replay(projectId);
    const snapshots = this.store.listSnapshots(projectId, project.planRevision);
    if (snapshots.length !== state.snapshots.length) {
      throw new ApiError(500, 'HISTORY_OUT_OF_SYNC', `Stored history has ${snapshots.length} snapshots but the log implies ${state.snapshots.length}`);
    }
    return { project, state: { ...state, snapshots } };
  }

  /**
   * Writes the whole history under a new plan revision, using the engine as it is now. Nothing is updated or
   * deleted: earlier revisions stay. Used when a planning edit changes the baseline, and to adopt a newer engine.
   */
  private rematerialize(projectId: string): number {
    const project = this.requireProject(projectId);
    const state = buildHistory(this.store.loadPlan(project), this.store.loadLog(projectId));
    const events = new Map(this.store.listEvents(projectId).map((e) => [e.id, e.recordedAt]));
    const voids = new Map(this.store.listVoids(projectId).map((v) => [v.id, v.recordedAt]));
    const planRevision = project.planRevision + 1;
    for (const s of state.snapshots) {
      const recordedAt =
        (s.kind === 'BASELINE' ? project.startedAt : s.kind === 'VOID' ? voids.get(s.voidId ?? '') : events.get(s.eventId ?? '')) ?? this.now();
      this.store.insertSnapshot(projectId, planRevision, s, recordedAt);
    }
    this.store.setPlanRevision(projectId, planRevision);
    return planRevision;
  }

  /** Builds history under a new plan revision with the current engine. The old revision is kept. */
  rebuildHistory(projectId: string): { planRevision: number; snapshots: number } {
    return transaction(this.db, () => {
      this.requireStarted(projectId);
      const planRevision = this.rematerialize(projectId);
      return { planRevision, snapshots: this.store.listSnapshots(projectId, planRevision).length };
    });
  }

  planRevisions(projectId: string) {
    const project = this.requireProject(projectId);
    return { current: project.planRevision, revisions: this.store.listPlanRevisions(projectId) };
  }

  // ---------------------------------------------------------------------------------------------- events

  /** Fills defaults, generates an id, and checks that everything the event names exists. */
  private buildEvent(projectId: string, input: EventInput, state: ProjectState): Event {
    const issues: string[] = [];
    const known = (items: ReadonlyArray<{ id: string }>, id: string | undefined, what: string) => {
      if (id !== undefined && !items.some((x) => x.id === id)) issues.push(`unknown ${what} "${id}"`);
    };
    known(state.plan.modules, input.moduleId, 'module');
    known(state.plan.tasks, input.taskId, 'task');
    known(state.plan.teams, input.sourceTeamId, 'team');
    known(state.plan.teams, input.affectedTeamId, 'team');
    known(state.plan.features ?? [], input.linkedFeatureId, 'feature');
    if (input.parentEventId !== undefined && !this.store.listEvents(projectId).some((e) => e.id === input.parentEventId)) {
      issues.push(`unknown parent event "${input.parentEventId}"`);
    }
    if (issues.length > 0) throw new ApiError(422, 'EVENT_REJECTED', `The event refers to things that do not exist: ${issues.join('; ')}`, issues);

    const id = input.id ?? this.newId('evt');
    if (this.store.idInUse(projectId, id)) throw conflict('ALREADY_EXISTS', `An event or void with id "${id}" already exists`);

    const event: Event = {
      id,
      type: input.type,
      category: input.category,
      title: input.title,
      description: input.description,
      phase: input.phase,
      createdBy: input.createdBy,
      occurredAt: input.occurredAt,
      asOf: input.asOf ?? input.occurredAt,
      effects: asEffects(input.effects),
    };
    const optional = {
      moduleId: input.moduleId,
      taskId: input.taskId,
      sourceTeamId: input.sourceTeamId,
      affectedTeamId: input.affectedTeamId,
      affectedOwnerId: input.affectedOwnerId,
      couldHaveBeenEarlier: input.couldHaveBeenEarlier,
      estimatedEffortImpact: input.estimatedEffortImpact,
      estimatedScheduleImpact: input.estimatedScheduleImpact,
      parentEventId: input.parentEventId,
      linkedRequirementId: input.linkedRequirementId,
      linkedFeatureId: input.linkedFeatureId,
    };
    for (const [key, value] of Object.entries(optional)) {
      if (value !== undefined) (event as unknown as Record<string, unknown>)[key] = value;
    }
    return event;
  }

  /** What would this event do? Nothing is written. */
  previewEvent(projectId: string, input: EventInput): { event: Event; explanation: ChangeExplanation } {
    this.requireStarted(projectId);
    const state = this.replay(projectId);
    const event = this.buildEvent(projectId, input, state);
    return { event, explanation: enginePreview(state, event) };
  }

  recordEvent(projectId: string, input: EventInput): RecordedEvent {
    return transaction(this.db, () => {
      const project = this.requireStarted(projectId);
      const state = this.replay(projectId);
      const event = this.buildEvent(projectId, input, state);
      const next = engineRecord(state, event); // EffectError -> 422 naming the event and effect

      const snapshot = last(next.snapshots);
      const seq = this.store.nextSeq(projectId);
      const recordedAt = this.now();
      this.store.insertEvent(projectId, seq, recordedAt, event);
      this.store.insertSnapshot(projectId, project.planRevision, snapshot, recordedAt);

      return {
        event: { ...event, seq, recordedAt, status: 'ACTIVE', voidedBy: null },
        snapshot,
        explanation: explainSnapshot(last(state.snapshots), snapshot),
      };
    });
  }

  voidEvent(projectId: string, eventId: string, input: { id?: string | undefined; asOf: string; reason?: string | undefined }): RecordedEvent {
    return transaction(this.db, () => {
      const project = this.requireStarted(projectId);
      const target = this.store.listEvents(projectId).find((e) => e.id === eventId);
      if (!target) throw notFound('Event', eventId);
      if (target.status === 'VOIDED') throw conflict('ALREADY_VOIDED', `Event "${eventId}" has already been voided`);

      const id = input.id ?? this.newId('void');
      if (this.store.idInUse(projectId, id)) throw conflict('ALREADY_EXISTS', `An event or void with id "${id}" already exists`);

      const state = this.replay(projectId);
      const entry: VoidEntry = { kind: 'VOID', id, eventId, asOf: input.asOf, ...(input.reason !== undefined ? { reason: input.reason } : {}) };
      let next: ProjectState;
      try {
        next = engineVoid(state, entry);
      } catch (e) {
        if (e instanceof EffectError && e.message.startsWith('Cannot void')) throw conflict('CANNOT_VOID', e.message);
        throw e;
      }

      const snapshot = last(next.snapshots);
      const seq = this.store.nextSeq(projectId);
      const recordedAt = this.now();
      this.store.insertVoid(projectId, seq, recordedAt, entry);
      this.store.insertSnapshot(projectId, project.planRevision, snapshot, recordedAt);

      return {
        event: { ...target, status: 'VOIDED', voidedBy: id },
        snapshot,
        explanation: explainSnapshot(last(state.snapshots), snapshot),
      };
    });
  }

  listEvents(projectId: string, filter: { type?: string; phase?: string; moduleId?: string; teamId?: string; status?: string } = {}): EventRecord[] {
    this.requireProject(projectId);
    return this.store.listEvents(projectId).filter(
      (e) =>
        (filter.type === undefined || e.type === filter.type) &&
        (filter.phase === undefined || e.phase === filter.phase) &&
        (filter.moduleId === undefined || e.moduleId === filter.moduleId) &&
        (filter.teamId === undefined || e.sourceTeamId === filter.teamId || e.affectedTeamId === filter.teamId) &&
        (filter.status === undefined || e.status === filter.status.toUpperCase()),
    );
  }

  /** One event, with the forecast change it caused. */
  eventDetail(projectId: string, eventId: string) {
    this.requireProject(projectId);
    const event = this.store.listEvents(projectId).find((e) => e.id === eventId);
    if (!event) throw notFound('Event', eventId);
    const { state } = this.stored(projectId);
    const at = state.snapshots.findIndex((s) => s.kind === 'EVENT' && s.eventId === eventId);
    const snapshot = at > 0 ? (state.snapshots[at] as ForecastSnapshot) : null;
    return {
      event,
      snapshot,
      explanation: snapshot ? explainSnapshot(state.snapshots[at - 1] as ForecastSnapshot, snapshot) : null,
    };
  }

  // ---------------------------------------------------------------------------------------------- views

  forecast(projectId: string): ForecastSnapshot {
    const { state } = this.stored(projectId);
    return last(state.snapshots);
  }

  snapshots(projectId: string, full: boolean): Array<ForecastSnapshot | SnapshotSummary> {
    const { state } = this.stored(projectId);
    return full ? [...state.snapshots] : state.snapshots.map(summarize);
  }

  snapshot(projectId: string, revision: number): { snapshot: ForecastSnapshot; explanation: ChangeExplanation | null } {
    const { state } = this.stored(projectId);
    const snapshot = state.snapshots[revision];
    if (!snapshot) throw notFound('Snapshot', String(revision));
    return { snapshot, explanation: revision > 0 ? explainSnapshot(state.snapshots[revision - 1] as ForecastSnapshot, snapshot) : null };
  }

  timeline(projectId: string) {
    return buildTimeline(this.stored(projectId).state);
  }

  history(projectId: string) {
    const { state } = this.stored(projectId);
    return { drift: forecastDrift(state), firstBreach: firstBreach(state) };
  }

  milestone(projectId: string, taskId: string) {
    const { state } = this.stored(projectId);
    const points = milestoneHistory(state, taskId);
    if (points.length === 0) throw notFound('Milestone', taskId);
    return points;
  }

  advisories(projectId: string, commonFeatureMinModules?: number): Advisory[] {
    this.requireStarted(projectId);
    const state = this.replay(projectId);
    return findAdvisories(state.plan, commonFeatureMinModules === undefined ? {} : { commonFeatureMinModules });
  }

  attribution(projectId: string, strategy: string): Attribution {
    this.requireStarted(projectId);
    if (!(strategy in STRATEGIES)) throw badRequest(`Unknown strategy "${strategy}". Use one of: ${strategyNames.join(', ')}`);
    return attributeDelay(this.replay(projectId), { strategy: STRATEGIES[strategy as StrategyName] });
  }

  /** The baseline plan as the engine sees it, for callers that want to run their own what-ifs. */
  plan(projectId: string): Plan {
    return this.store.loadPlan(this.requireProject(projectId));
  }
}
