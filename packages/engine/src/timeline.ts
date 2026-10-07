import { EPS } from './calendar';
import { explainSnapshot } from './explain';
import type { ModuleChange } from './explain';
import type { ProjectState } from './history';
import type { DatedOffset, ForecastSnapshot, SnapshotKind } from './snapshot';
import type { ISODate, ModuleId, ModuleKind, TaskId, WorkDays } from './types';

export interface BranchStep {
  /** The snapshot this step comes from. */
  revision: number;
  kind: Exclude<SnapshotKind, 'BASELINE'>;
  /** The event or plan edit that caused the step (see `kind`); for a VOID, the event that was withdrawn. */
  eventId: string;
  asOf: ISODate;
  /** Change in the module's variance at this step (negative = recovery). */
  delta: WorkDays;
  /** The module's total variance from its baseline after this step. */
  variance: WorkDays;
  finishAfter: DatedOffset;
  origin: ModuleChange['origin'];
  fromModuleIds: ModuleId[];
  /** What the same snapshot did to project delivery. */
  deliveryDelta: WorkDays;
  /** The module slipped but delivery did not: float absorbed it. */
  absorbed: boolean;
  onCriticalPath: boolean;
}

/** One module's deviation from the original plan (DESIGN.md §3.6). Exists only for modules that have deviated. */
export interface Branch {
  moduleId: ModuleId;
  moduleName: string;
  /** The project delivery lane: this module holds the delivery milestone. */
  isDelivery: boolean;
  /** Status date of the first snapshot in which the module deviated. */
  forkAt: ISODate;
  baselineFinish: DatedOffset | null;
  currentFinish: DatedOffset;
  currentDelta: WorkDays;
  /** MERGED once the module is back on its original date; it re-opens if it deviates again. */
  status: 'OPEN' | 'MERGED';
  steps: BranchStep[];
}

/** Every event, plan edit and void, including those that moved nothing (so effort without schedule impact stays visible). */
export interface EventMarker {
  revision: number;
  kind: Exclude<SnapshotKind, 'BASELINE'>;
  /** The event or plan edit id (see `kind`); for a VOID, the event that was withdrawn. */
  eventId: string;
  asOf: ISODate;
  effortImpact: WorkDays;
  stepDays: WorkDays;
  /** How far the plan itself moved: non-zero only for plan edits. */
  baselineStepDays: WorkDays;
  absorbed: boolean;
  onCriticalPath: boolean;
  modulesMoved: number;
  noScheduleEffect: boolean;
}

export interface Timeline {
  /** The original line: the plan as it was when the project started (revision 0), which never changes. */
  original: {
    delivery: DatedOffset;
    modules: Array<{ moduleId: ModuleId; name: string; kind: ModuleKind; finish: DatedOffset }>;
    milestones: Array<{ taskId: TaskId; name: string; moduleId: ModuleId; baseline: DatedOffset }>;
  };
  /**
   * `planDelivery` is the plan as it stands now. It differs from `original.delivery` once planning changes have
   * refined the plan; `variance` is measured against it.
   */
  current: { delivery: DatedOffset; planDelivery: DatedOffset; variance: WorkDays; asOf: ISODate | null };
  /** One per deviating module, in the order they first deviated. */
  branches: Branch[];
  markers: EventMarker[];
}

/**
 * Builds the Multiverse timeline from stored snapshots: the original line plus one branch per module that has
 * deviated, each with a step for every snapshot that moved it. Nothing is persisted; it is derived every time.
 */
export function buildTimeline(state: ProjectState): Timeline {
  const { baseline, snapshots } = state;
  const first = snapshots[0] as ForecastSnapshot;
  const last = snapshots[snapshots.length - 1] as ForecastSnapshot;

  const moduleMeta = new Map(baseline.modules.map((m) => [m.id, m]));
  const deliveryModule = baseline.tasks.find((t) => t.id === baseline.deliveryTaskId)?.moduleId;

  const branches = new Map<ModuleId, Branch>();
  const markers: EventMarker[] = [];

  for (let k = 1; k < snapshots.length; k++) {
    const before = snapshots[k - 1] as ForecastSnapshot;
    const now = snapshots[k] as ForecastSnapshot;
    const explanation = explainSnapshot(before, now);
    const kind = now.kind as Exclude<SnapshotKind, 'BASELINE'>;
    const asOf = now.asOf as ISODate;
    const eventId = (now.eventId ?? now.planEditId) as string;

    for (const change of explanation.modules) {
      const module = now.modules[change.moduleId];
      if (!module) continue;
      let branch = branches.get(change.moduleId);
      if (!branch) {
        branch = {
          moduleId: change.moduleId,
          moduleName: moduleMeta.get(change.moduleId)?.name ?? change.moduleId,
          isDelivery: change.moduleId === deliveryModule,
          forkAt: asOf,
          baselineFinish:
            module.baselineFinish !== null && module.baselineFinishDate !== null
              ? { offset: module.baselineFinish, date: module.baselineFinishDate }
              : null,
          currentFinish: { offset: module.forecastFinish, date: module.forecastFinishDate },
          currentDelta: module.variance,
          status: 'OPEN',
          steps: [],
        };
        branches.set(change.moduleId, branch);
      }
      branch.steps.push({
        revision: now.revision,
        kind,
        eventId,
        asOf,
        delta: change.delta,
        variance: change.variance,
        finishAfter: { offset: module.forecastFinish, date: module.forecastFinishDate },
        origin: change.origin,
        fromModuleIds: change.fromModuleIds,
        deliveryDelta: change.deliveryDelta,
        absorbed: change.absorbed,
        onCriticalPath: change.onCriticalPath,
      });
    }

    markers.push({
      revision: now.revision,
      kind,
      eventId,
      asOf,
      effortImpact: now.effortImpact,
      stepDays: now.stepDays,
      baselineStepDays: now.baselineStepDays ?? 0,
      absorbed: explanation.absorbed,
      onCriticalPath: explanation.onCriticalPath,
      modulesMoved: explanation.modules.length,
      noScheduleEffect: explanation.modules.length === 0,
    });
  }

  // A branch describes where its module stands now, which may be later than its last step.
  for (const branch of branches.values()) {
    const module = last.modules[branch.moduleId];
    if (!module) continue;
    branch.currentFinish = { offset: module.forecastFinish, date: module.forecastFinishDate };
    branch.currentDelta = module.variance;
    branch.status = Math.abs(module.variance) <= EPS ? 'MERGED' : 'OPEN';
  }

  return {
    original: {
      delivery: first.baselineDelivery,
      modules: Object.entries(first.modules).map(([moduleId, m]) => ({
        moduleId,
        name: moduleMeta.get(moduleId)?.name ?? moduleId,
        kind: moduleMeta.get(moduleId)?.kind ?? 'DELIVERABLE',
        finish: { offset: m.forecastFinish, date: m.forecastFinishDate },
      })),
      milestones: Object.entries(first.milestones).map(([taskId, m]) => {
        const task = baseline.tasks.find((t) => t.id === taskId);
        return {
          taskId,
          name: task?.name ?? taskId,
          moduleId: task?.moduleId ?? '',
          baseline: m.forecast,
        };
      }),
    },
    current: { delivery: last.forecastDelivery, planDelivery: last.baselineDelivery, variance: last.variance, asOf: last.asOf },
    branches: [...branches.values()],
    markers,
  };
}

export interface DriftPoint {
  revision: number;
  kind: SnapshotKind;
  asOf: ISODate | null;
  eventId: string | null;
  forecastDelivery: DatedOffset;
  variance: WorkDays;
  stepDays: WorkDays;
}

/** The delivery forecast across every snapshot: how it drifted over time (spec §20). */
export function forecastDrift(state: ProjectState): DriftPoint[] {
  return state.snapshots.map((s) => ({
    revision: s.revision,
    kind: s.kind,
    asOf: s.asOf,
    eventId: s.eventId,
    forecastDelivery: s.forecastDelivery,
    variance: s.variance,
    stepDays: s.stepDays,
  }));
}

export interface MilestonePoint {
  revision: number;
  asOf: ISODate | null;
  eventId: string | null;
  baseline: DatedOffset | null;
  forecast: DatedOffset;
}

/** One milestone's forecast across history, from the first snapshot in which it exists. */
export function milestoneHistory(state: ProjectState, taskId: TaskId): MilestonePoint[] {
  const points: MilestonePoint[] = [];
  for (const s of state.snapshots) {
    const m = s.milestones[taskId];
    if (m) points.push({ revision: s.revision, asOf: s.asOf, eventId: s.eventId, baseline: m.baseline, forecast: m.forecast });
  }
  return points;
}

export interface Breach {
  revision: number;
  eventId: string | null;
  asOf: ISODate | null;
  variance: WorkDays;
  forecastDelivery: DatedOffset;
}

/** The first snapshot in which delivery is forecast later than the original date, or null if it never was. */
export function firstBreach(state: ProjectState): Breach | null {
  const s = state.snapshots.find((x) => x.variance > EPS);
  return s ? { revision: s.revision, eventId: s.eventId, asOf: s.asOf, variance: s.variance, forecastDelivery: s.forecastDelivery } : null;
}
