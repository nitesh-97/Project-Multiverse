import { randomUUID } from 'node:crypto';
import {
  DEFAULT_PHASES,
  EffectError,
  PlanError,
  attributeDelay,
  buildControlRoom,
  buildHistory,
  buildMilestones,
  buildModuleView,
  buildRetro,
  buildTimeline,
  counterfactualStrategy,
  explainSnapshot,
  findAdvisories,
  firstBreach,
  forecastDrift,
  milestoneHistory,
  previewEvent as enginePreview,
  previewPlanEdit as enginePreviewPlan,
  recordEvent as engineRecord,
  recordPlanEdit as engineRecordPlan,
  sequentialStrategy,
  slackToTarget,
  startProject,
  voidEvent as engineVoid,
} from '@multiverse/engine';
import type {
  Attribution,
  ChangeExplanation,
  ControlRoomView,
  CurrentTask,
  Effect,
  Event,
  ForecastSnapshot,
  ModuleView,
  PhaseModel,
  Plan,
  PlanEdit,
  ProjectAdvisory,
  ProjectState,
  ProjectTimelineView,
  RetroView,
  TargetStatus,
  VoidEntry,
} from '@multiverse/engine';
import { transaction } from './db/database';
import type { Db } from './db/database';
import { ApiError, badRequest, conflict, notFound } from './errors';
import { asEffects } from './schemas';
import type { EventInput, PlanEditInput } from './schemas';
import { Store } from './store';
import type { EventRecord, ModuleRecord, PlanEditRecord, ProjectRecord } from './store';

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

/**
 * The modules whose own work an entry changes directly, which is where its tasks live. With `includeBlocks`, also the
 * modules of tasks that new work is made to wait for: a planning change may not delay work that has started.
 */
function modulesTouched(effects: readonly Effect[], plan: Plan, includeBlocks: boolean): Set<string> {
  const moduleOf = new Map(plan.tasks.map((t) => [t.id, t.moduleId]));
  const touched = new Set<string>();
  const add = (taskId: string): void => {
    const m = moduleOf.get(taskId);
    if (m !== undefined) touched.add(m);
  };
  for (const e of effects) {
    switch (e.op) {
      case 'ADD_TASK':
        moduleOf.set(e.task.id, e.task.moduleId);
        touched.add(e.task.moduleId);
        if (includeBlocks) e.blocks.forEach(add);
        break;
      case 'ADJUST_ESTIMATE':
      case 'REMOVE_TASK':
      case 'BLOCK_UNTIL':
      case 'RECORD_PROGRESS':
      case 'TRANSFER_OWNER':
        add(e.taskId);
        break;
      case 'ADD_DEPENDENCY':
      case 'REMOVE_DEPENDENCY':
        add(e.successorId);
        break;
      default:
        break; // SET_CAPACITY and ADD_HOLIDAY belong to no module
    }
  }
  return touched;
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
    phases?: PhaseModel | undefined;
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
        phases: input.phases ?? DEFAULT_PHASES,
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
      forecast: latest ? { ...summarize(latest), target: this.targetOf(project, latest) } : null,
    };
  }

  /**
   * How the forecast compares with the date promised to the client, in working days: positive is days to spare,
   * negative is late. Separate from variance, which compares the forecast with the plan.
   */
  private targetOf(project: ProjectRecord, snapshot: ForecastSnapshot): TargetStatus | null {
    if (project.targetDate === null) return null;
    return {
      date: project.targetDate,
      daysToSpare: slackToTarget(snapshot.calendar ?? { startDate: project.startDate, weekendDays: project.weekendDays, holidays: project.holidays }, snapshot.forecastDelivery.offset, project.targetDate),
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
   * Runs a blueprint edit atomically. Before the project starts these are plain edits. Afterwards the database
   * refuses to change the plan rows (409 LOCKED): later changes are recorded as plan edits or events, so that history
   * shows them. Nothing is rebuilt.
   */
  edit<T>(projectId: string, mutate: (store: Store, project: ProjectRecord) => T): T {
    return transaction(this.db, () => mutate(this.store, this.requireProject(projectId)));
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
   * deleted: earlier revisions stay. Used when the project starts (revision 1) and to adopt a newer engine.
   * Planning changes do not use it: they are plan edits in the log.
   */
  private rematerialize(projectId: string): number {
    const project = this.requireProject(projectId);
    const state = buildHistory(this.store.loadPlan(project), this.store.loadLog(projectId));
    const events = new Map(this.store.listEvents(projectId).map((e) => [e.id, e.recordedAt]));
    const plans = new Map(this.store.listPlanEdits(projectId).map((p) => [p.id, p.recordedAt]));
    const voids = new Map(this.store.listVoids(projectId).map((v) => [v.id, v.recordedAt]));
    const planRevision = project.planRevision + 1;
    for (const s of state.snapshots) {
      const recordedAt =
        (s.kind === 'BASELINE'
          ? project.startedAt
          : s.kind === 'VOID'
            ? voids.get(s.voidId ?? '')
            : s.kind === 'PLAN'
              ? plans.get(s.planEditId ?? '')
              : events.get(s.eventId ?? '')) ?? this.now();
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

    // An event changes work that is under way. A module that has not started is still being planned: that is a plan
    // edit, which is recorded too but moves the plan instead of counting as a delay.
    const lockedAt = new Map(this.store.listModules(projectId).map((m) => [m.id, m.lockedAt]));
    const notStarted = [...modulesTouched(asEffects(input.effects), state.plan, false)].filter((m) => lockedAt.get(m) === null);
    if (notStarted.length > 0) {
      throw new ApiError(
        422,
        'EVENT_REJECTED',
        `Module ${notStarted.join(', ')} ${notStarted.length === 1 ? 'is' : 'are'} not locked, so ${notStarted.length === 1 ? 'its' : 'their'} plan can still be edited. Record this as a plan edit (POST /projects/${projectId}/plan-edits), which is also kept in history, or lock the module first if its work has started.`,
        notStarted.map((m) => `module ${m} is not locked`),
      );
    }

    const id = input.id ?? this.newId('evt');
    if (this.store.idInUse(projectId, id)) throw conflict('ALREADY_EXISTS', `An event, plan edit or void with id "${id}" already exists`);

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

  // ---------------------------------------------------------------------------------------------- plan edits

  /** Fills defaults and checks the edit only touches modules that have not started. */
  private buildPlanEdit(projectId: string, input: PlanEditInput, state: ProjectState): PlanEdit {
    const lockedAt = new Map(this.store.listModules(projectId).map((m) => [m.id, m.lockedAt]));
    const started = [...modulesTouched(input.effects as Effect[], state.baseline, true)].filter((m) => typeof lockedAt.get(m) === 'string');
    if (started.length > 0) {
      throw new ApiError(
        422,
        'EVENT_REJECTED',
        `Module ${started.join(', ')} ${started.length === 1 ? 'is' : 'are'} locked: its work has started, so changes to it are events, not planning. Record this as an event (POST /projects/${projectId}/events).`,
        started.map((m) => `module ${m} is locked`),
      );
    }
    const id = input.id ?? this.newId('plan');
    if (this.store.idInUse(projectId, id)) throw conflict('ALREADY_EXISTS', `An event, plan edit or void with id "${id}" already exists`);
    return {
      id,
      title: input.title,
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
      createdBy: input.createdBy,
      asOf: input.asOf,
      effects: input.effects as PlanEdit['effects'],
    };
  }

  /** What would this planning change do? Nothing is written. */
  previewPlanEdit(projectId: string, input: PlanEditInput): { planEdit: PlanEdit; explanation: ChangeExplanation } {
    this.requireStarted(projectId);
    const state = this.replay(projectId);
    const planEdit = this.buildPlanEdit(projectId, input, state);
    return { planEdit, explanation: enginePreviewPlan(state, planEdit) };
  }

  /**
   * Records a planning change to modules that have not started. It is part of the log, so history shows what changed,
   * when and why. It moves the plan as well as the forecast: planning is not delay.
   */
  recordPlanEdit(projectId: string, input: PlanEditInput): { planEdit: PlanEditRecord; snapshot: ForecastSnapshot; explanation: ChangeExplanation } {
    return transaction(this.db, () => {
      const project = this.requireStarted(projectId);
      const state = this.replay(projectId);
      const planEdit = this.buildPlanEdit(projectId, input, state);
      const next = engineRecordPlan(state, planEdit); // EffectError -> 422 naming the edit and effect

      const snapshot = last(next.snapshots);
      const seq = this.store.nextSeq(projectId);
      const recordedAt = this.now();
      this.store.insertPlanEdit(projectId, seq, recordedAt, planEdit);
      this.store.insertSnapshot(projectId, project.planRevision, snapshot, recordedAt);

      return { planEdit: { ...planEdit, seq, recordedAt }, snapshot, explanation: explainSnapshot(last(state.snapshots), snapshot) };
    });
  }

  listPlanEdits(projectId: string): PlanEditRecord[] {
    this.requireProject(projectId);
    return this.store.listPlanEdits(projectId);
  }

  // ---------------------------------------------------------------------------------------------- events

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

  /** The current forecast, with how it compares with the date promised to the client. */
  forecast(projectId: string): ForecastSnapshot & { target: TargetStatus | null } {
    const { project, state } = this.stored(projectId);
    const latest = last(state.snapshots);
    return { ...latest, target: this.targetOf(project, latest) };
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

  /** The project view: the Multiverse timeline plus the milestone dots on it. */
  timeline(projectId: string): ProjectTimelineView {
    const { state } = this.stored(projectId);
    const flaggedTaskIds = this.store.listMilestoneFlags(projectId);
    return { ...buildTimeline(state), milestones: buildMilestones(state, { flaggedTaskIds }), flaggedTaskIds };
  }

  /** One module on its own: each task as a dot, and a branch for each task that deviated. */
  moduleTimeline(projectId: string, moduleId: string): ModuleView {
    const { state } = this.stored(projectId);
    if (!state.plan.modules.some((m) => m.id === moduleId)) throw notFound('Module', moduleId);
    return buildModuleView(state, moduleId);
  }

  milestoneFlags(projectId: string): string[] {
    this.requireProject(projectId);
    return this.store.listMilestoneFlags(projectId);
  }

  /**
   * Flags a task as a project milestone, or takes the flag off. It only changes which dots the project view shows, so it
   * is allowed at any time, before or after the project starts. The task must exist in the plan as it stands.
   */
  setMilestoneFlag(projectId: string, taskId: string, flagged: boolean, by?: string): string[] {
    return transaction(this.db, () => {
      const project = this.requireProject(projectId);
      if (flagged) {
        const known = project.startedAt !== null ? this.replay(projectId).plan.tasks.map((t) => t.id) : this.store.listTasks(projectId).map((t) => t.id);
        if (!known.includes(taskId)) throw notFound('Task', taskId);
        this.store.addMilestoneFlag(projectId, taskId, this.now(), by ?? null);
      } else {
        this.store.removeMilestoneFlag(projectId, taskId);
      }
      return this.store.listMilestoneFlags(projectId);
    });
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

  /**
   * Things worth a person's attention: common features nobody has planned a shared implementation for, tasks the
   * forecast assumes are finished that nobody has confirmed, and modules whose work is forecast under way but which
   * have not been locked.
   */
  advisories(projectId: string, commonFeatureMinModules?: number): ProjectAdvisory[] {
    this.requireStarted(projectId);
    return this.advisoriesOf(projectId, this.replay(projectId), commonFeatureMinModules);
  }

  private advisoriesOf(projectId: string, state: ProjectState, commonFeatureMinModules?: number): ProjectAdvisory[] {
    const advisories: ProjectAdvisory[] = findAdvisories(state.plan, commonFeatureMinModules === undefined ? {} : { commonFeatureMinModules });

    for (const module of this.store.listModules(projectId)) {
      if (module.lockedAt !== null) continue;
      const underWay = state.plan.tasks.filter((t) => t.moduleId === module.id && state.schedule.tasks[t.id]?.state !== 'NOT_STARTED');
      if (underWay.length === 0) continue;
      advisories.push({
        rule: 'MODULE_STARTED_NOT_LOCKED',
        severity: 'WARNING',
        moduleId: module.id,
        message: `Module ${module.id} is not locked, but the forecast has ${underWay.length} of its tasks under way or finished (${underWay.slice(0, 3).map((t) => t.id).join(', ')}${underWay.length > 3 ? ', ...' : ''}).`,
        recommendation: 'Lock the module so changes to it are recorded as events; plan edits are refused for work that has started.',
      });
    }
    return advisories;
  }

  attribution(projectId: string, strategy: string): Attribution {
    this.requireStarted(projectId);
    if (!(strategy in STRATEGIES)) throw badRequest(`Unknown strategy "${strategy}". Use one of: ${strategyNames.join(', ')}, both`);
    return attributeDelay(this.replay(projectId), { strategy: STRATEGIES[strategy as StrategyName] });
  }

  /** Both ways of dividing the delay, side by side: what the retrospective shows. */
  attributionBoth(projectId: string): Record<StrategyName, Attribution> {
    this.requireStarted(projectId);
    const state = this.replay(projectId);
    return {
      sequential: attributeDelay(state, { strategy: STRATEGIES.sequential }),
      counterfactual: attributeDelay(state, { strategy: STRATEGIES.counterfactual }),
    };
  }

  /**
   * The management view: where the project stands against the plan and against the client's date, what is setting
   * the pace, what is likely to be next, and what needs a person's attention.
   */
  controlRoom(projectId: string): ControlRoomView {
    const { project, state } = this.stored(projectId);
    const room = buildControlRoom(state);
    const lockedAt = new Map(this.store.listModules(projectId).map((m) => [m.id, m.lockedAt]));
    return {
      ...room,
      modules: room.modules.map((m) => ({ ...m, locked: lockedAt.get(m.moduleId) != null })),
      target: this.targetOf(project, last(state.snapshots)),
      contributors: attributeDelay(state, { strategy: STRATEGIES.sequential }),
      advisories: this.advisoriesOf(projectId, state),
    };
  }

  /** The retrospective: planned against actual, the delay shared out both ways, and what the project learned. */
  retro(projectId: string): RetroView {
    const { project, state } = this.stored(projectId);
    return { ...buildRetro(state), target: this.targetOf(project, last(state.snapshots)) };
  }

  /**
   * The plan as it stands now, task by task, with where each one is in the forecast. Unlike the stored blueprint it
   * includes work added by events and plan edits, which is what a person picking a task needs to see.
   */
  currentTasks(projectId: string): CurrentTask[] {
    const { state } = this.stored(projectId);
    const original = new Set(state.origin.tasks.map((t) => t.id));
    const moduleLocked = new Map(this.store.listModules(projectId).map((m) => [m.id, m.lockedAt != null]));
    return state.plan.tasks.flatMap((t) => {
      const s = state.schedule.tasks[t.id];
      if (!s) return [];
      return [
        {
          id: t.id,
          name: t.name,
          moduleId: t.moduleId,
          teamId: t.teamId,
          kind: t.kind,
          estimate: t.estimate,
          ...(t.featureId !== undefined ? { featureId: t.featureId } : {}),
          ...(t.ownerId !== undefined ? { ownerId: t.ownerId } : {}),
          state: s.state,
          startDate: s.startDate,
          finishDate: s.finishDate,
          remainingEffort: s.remainingEffort,
          totalFloat: s.totalFloat,
          critical: s.critical,
          assumed: t.progress?.assumed === true,
          added: !original.has(t.id),
          moduleLocked: moduleLocked.get(t.moduleId) === true,
        },
      ];
    });
  }

  /** The baseline plan as the engine sees it, for callers that want to run their own what-ifs. */
  plan(projectId: string): Plan {
    return this.store.loadPlan(this.requireProject(projectId));
  }
}
