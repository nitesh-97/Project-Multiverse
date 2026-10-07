import { EPS, rebaseOffset, snap } from './calendar';
import { recordEvent, recordPlanEdit } from './history';
import type { ProjectState } from './history';
import type { Event, PlanEdit } from './events';
import type { ForecastSnapshot, SnapshotKind } from './snapshot';
import type { CalendarSpec, ISODate, ModuleId, TaskId, WorkDays } from './types';

export interface ModuleChange {
  moduleId: ModuleId;
  finishBefore: ISODate;
  finishAfter: ISODate;
  /** Change in this module's variance from baseline at this step (negative = recovery). */
  delta: WorkDays;
  /** The module's total variance from its baseline after this step. */
  variance: WorkDays;
  /** DIRECT: the event touched this module's tasks. PROPAGATED: it moved only because something upstream moved. */
  origin: 'DIRECT' | 'PROPAGATED';
  /** For PROPAGATED: the changed modules upstream on the driving chain that explain the move. */
  fromModuleIds: ModuleId[];
  /** What the same step did to project delivery. */
  deliveryDelta: WorkDays;
  /** The module slipped but delivery did not: float absorbed it. */
  absorbed: boolean;
  /** The module's last task is on the critical path after this step. */
  onCriticalPath: boolean;
}

export interface TaskChange {
  taskId: TaskId;
  moduleId: ModuleId;
  change: 'ADDED' | 'REMOVED' | 'MOVED';
  finishBefore: ISODate | null;
  finishAfter: ISODate | null;
  /** Working days; 0 for added and removed tasks. */
  finishDelta: WorkDays;
}

/** Why the forecast changed between two consecutive snapshots (spec §28 step 9). */
export interface ChangeExplanation {
  revision: number;
  kind: SnapshotKind;
  eventId: string | null;
  /** The plan edit that caused this step (kind PLAN). */
  planEditId: string | null;
  asOf: ISODate | null;
  /** How far the plan itself moved at this step: non-zero only when a planning change refined the baseline. */
  baselineStepDays: WorkDays;
  /** Modules that use the feature the trigger is about: affected, though not necessarily changed. */
  linkedModuleIds: ModuleId[];
  delivery: { before: ISODate; after: ISODate };
  /** Variance from baseline before and after, and the difference: the schedule impact of the trigger. */
  varianceBefore: WorkDays;
  varianceAfter: WorkDays;
  stepDays: WorkDays;
  effortImpact: WorkDays;
  /** Some module slipped but delivery did not move. */
  absorbed: boolean;
  /** Delivery moved, or a task the event touched is on the critical path before or after. */
  onCriticalPath: boolean;
  criticalPath: { before: TaskId[]; after: TaskId[]; changed: boolean; entered: TaskId[]; left: TaskId[] };
  modules: ModuleChange[];
  tasks: TaskChange[];
}

/** The last task to finish in `moduleId`; ties go to the later one in dependency order. */
function lastTaskOf(snapshot: ForecastSnapshot, moduleId: ModuleId): TaskId | null {
  let best: TaskId | null = null;
  let finish = Number.NEGATIVE_INFINITY;
  for (const t of Object.values(snapshot.tasks)) {
    if (t.moduleId === moduleId && t.finish >= finish - EPS) {
      best = t.id;
      finish = Math.max(finish, t.finish);
    }
  }
  return best;
}

/** Modules met walking back along the driving chain from the module's last task, nearest first. */
function modulesOnChain(snapshot: ForecastSnapshot, moduleId: ModuleId): ModuleId[] {
  const seen: ModuleId[] = [];
  const guard = new Set<TaskId>();
  for (let id = lastTaskOf(snapshot, moduleId); id !== null && !guard.has(id); ) {
    guard.add(id);
    const task = snapshot.tasks[id];
    if (!task) break;
    if (task.moduleId !== moduleId && !seen.includes(task.moduleId)) seen.push(task.moduleId);
    id = task.drivingPredecessor;
  }
  return seen;
}

/**
 * Explains the step from `previous` to `next`. Pure over two snapshots, so it works on stored history.
 */
export function explainSnapshot(previous: ForecastSnapshot, next: ForecastSnapshot): ChangeExplanation {
  const stepDays = next.stepDays;

  const changes = new Map<ModuleId, { delta: number; after: ForecastSnapshot['modules'][string]; before: ForecastSnapshot['modules'][string] | undefined }>();
  for (const [id, after] of Object.entries(next.modules)) {
    const before = previous.modules[id];
    const delta = snap(after.variance - (before?.variance ?? 0));
    if (Math.abs(delta) > EPS) changes.set(id, { delta, after, before });
  }
  const direct = new Set(next.touchedModuleIds);

  const modules: ModuleChange[] = [];
  for (const [moduleId, { delta, after, before }] of changes) {
    const origin = direct.has(moduleId) ? 'DIRECT' : 'PROPAGATED';
    let fromModuleIds: ModuleId[] = [];
    if (origin === 'PROPAGATED') {
      // The cause is upstream on the new driving chain (delays) or the old one (recoveries, where the critical
      // path may have switched away from the module that actually got faster).
      const upstream = [...modulesOnChain(next, moduleId), ...modulesOnChain(previous, moduleId)].filter(
        (m, i, all) => all.indexOf(m) === i && changes.has(m),
      );
      const directOnes = upstream.filter((m) => direct.has(m));
      fromModuleIds = directOnes.length > 0 ? directOnes : upstream;
    }
    const last = lastTaskOf(next, moduleId);
    modules.push({
      moduleId,
      finishBefore: before?.forecastFinishDate ?? after.forecastFinishDate,
      finishAfter: after.forecastFinishDate,
      delta,
      variance: after.variance,
      origin,
      fromModuleIds,
      deliveryDelta: stepDays,
      absorbed: delta > EPS && Math.abs(stepDays) <= EPS,
      onCriticalPath: last !== null && (next.tasks[last]?.critical ?? false),
    });
  }
  modules.sort((a, b) => (a.origin === b.origin ? a.moduleId.localeCompare(b.moduleId) : a.origin === 'DIRECT' ? -1 : 1));

  // A holiday changes no offset, only the dates they fall on. To see what moved, the earlier position is
  // re-expressed in the calendar of the later snapshot (snapshots from before calendars were recorded are treated as equal).
  const earlierCalendar = (previous.calendar as CalendarSpec | undefined) ?? next.calendar;
  const tasks: TaskChange[] = [];
  for (const [id, after] of Object.entries(next.tasks)) {
    const before = previous.tasks[id];
    if (!before) {
      tasks.push({ taskId: id, moduleId: after.moduleId, change: 'ADDED', finishBefore: null, finishAfter: after.finishDate, finishDelta: 0 });
      continue;
    }
    const finishDelta = snap(after.finish - rebaseOffset(before.finish, earlierCalendar, next.calendar));
    const startDelta = snap(after.start - rebaseOffset(before.start, earlierCalendar, next.calendar));
    if (Math.abs(finishDelta) > EPS || Math.abs(startDelta) > EPS) {
      tasks.push({ taskId: id, moduleId: after.moduleId, change: 'MOVED', finishBefore: before.finishDate, finishAfter: after.finishDate, finishDelta });
    }
  }
  for (const [id, before] of Object.entries(previous.tasks)) {
    if (!next.tasks[id]) {
      tasks.push({ taskId: id, moduleId: before.moduleId, change: 'REMOVED', finishBefore: before.finishDate, finishAfter: null, finishDelta: 0 });
    }
  }

  const criticalBefore = [...previous.criticalPath];
  const criticalAfter = [...next.criticalPath];
  const entered = criticalAfter.filter((t) => !criticalBefore.includes(t));
  const left = criticalBefore.filter((t) => !criticalAfter.includes(t));

  return {
    revision: next.revision,
    kind: next.kind,
    eventId: next.eventId,
    planEditId: next.planEditId ?? null,
    asOf: next.asOf,
    baselineStepDays: next.baselineStepDays ?? 0,
    linkedModuleIds: [...(next.linkedModuleIds ?? [])],
    delivery: { before: previous.forecastDelivery.date, after: next.forecastDelivery.date },
    varianceBefore: previous.variance,
    varianceAfter: next.variance,
    stepDays,
    effortImpact: next.effortImpact,
    absorbed: Math.abs(stepDays) <= EPS && modules.some((m) => m.delta > EPS),
    onCriticalPath:
      Math.abs(stepDays) > EPS ||
      next.touchedTaskIds.some((t) => criticalBefore.includes(t) || criticalAfter.includes(t)),
    criticalPath: { before: criticalBefore, after: criticalAfter, changed: entered.length > 0 || left.length > 0, entered, left },
    modules,
    tasks,
  };
}

/**
 * What would happen if `event` were recorded now? The developer says "+2 days"; this answers with the schedule
 * impact, the critical-path status and the affected modules. Nothing is persisted: `state` is unchanged.
 */
export function previewEvent(state: ProjectState, event: Event): ChangeExplanation {
  const next = recordEvent(state, event);
  const previous = state.snapshots[state.snapshots.length - 1] as ForecastSnapshot;
  return explainSnapshot(previous, next.snapshots[next.snapshots.length - 1] as ForecastSnapshot);
}

/** What would this planning change do? Same answer shape as {@link previewEvent}; nothing is persisted. */
export function previewPlanEdit(state: ProjectState, edit: PlanEdit): ChangeExplanation {
  const next = recordPlanEdit(state, edit);
  const previous = state.snapshots[state.snapshots.length - 1] as ForecastSnapshot;
  return explainSnapshot(previous, next.snapshots[next.snapshots.length - 1] as ForecastSnapshot);
}
