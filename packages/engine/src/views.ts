import { EPS, rebaseOffset } from './calendar';
import { explainSnapshot } from './explain';
import type { ProjectState } from './history';
import type { DatedOffset, ForecastSnapshot } from './snapshot';
import { buildTimeline } from './timeline';
import type { EventMarker } from './timeline';
import type { ISODate, ModuleId, ModuleKind, Task, TaskId, WorkDays } from './types';
import { tidy } from './util';

/**
 * The two levels of the Multiverse timeline. The project view is the whole project as milestone dots; the module view
 * is one module, the same idea one level down, with each of its tasks as a dot. Both are derived from the stored
 * snapshots, so nothing here is persisted and nothing can drift from the history.
 */

type Reached = 'DONE' | 'IN_PROGRESS' | 'NOT_STARTED';

export type DotKind =
  /** When work on a module starts. Opens the module's own view. */
  | 'MODULE_START'
  /** When a module is finished: its last task, which is its own milestone if it has one (an alpha, a delivery). */
  | 'MODULE_FINISH'
  /** A checkpoint inside a module that is not its end: a milestone task, or a task the project manager flagged. */
  | 'MILESTONE';

export interface MilestoneDot {
  /** `start:m5`, `finish:m5` or `task:proj.review`: stable across forecasts. */
  id: string;
  kind: DotKind;
  name: string;
  moduleId: ModuleId;
  /** The task the dot is the finish of; null for a module start. */
  taskId: TaskId | null;
  /** Where it was in the original plan (revision 0). Null for something added after the project started. */
  original: DatedOffset | null;
  /** Where the plan now has it, after planning changes. */
  plan: DatedOffset | null;
  forecast: DatedOffset;
  /** Forecast against the plan, in working days of the current calendar. Positive is late. */
  variance: WorkDays;
  /** Whether the project has got there: a module has started, or a task is finished. */
  reached: boolean;
  /** The project manager flagged this task as a milestone. */
  flagged: boolean;
  critical: boolean;
}

export interface TaskDot {
  taskId: TaskId;
  name: string;
  teamId: string;
  kind: 'TASK' | 'MILESTONE';
  estimate: WorkDays;
  /** Finish in the original plan. Null for work added after the project started. */
  original: DatedOffset | null;
  plan: DatedOffset | null;
  /** When the forecast has it starting and finishing. */
  start: DatedOffset;
  forecast: DatedOffset;
  variance: WorkDays;
  state: Reached;
  critical: boolean;
  /** Added after the project started, by an event or a planning change. */
  added: boolean;
}

export interface TaskBranchStep {
  revision: number;
  kind: Exclude<ForecastSnapshot['kind'], 'BASELINE' | 'PLAN'>;
  eventId: string;
  asOf: ISODate;
  change: 'MOVED' | 'ADDED';
  /** How far the task’s finish moved at this step (negative = recovery). 0 for added work. */
  delta: WorkDays;
  finishAfter: DatedOffset;
  /** DIRECT: the event touched the task. PROPAGATED: it moved only because work before it moved. */
  origin: 'DIRECT' | 'PROPAGATED';
  fromTaskIds: TaskId[];
  onCriticalPath: boolean;
}

/** One task’s deviation from the original plan: the module view’s version of a branch. */
export interface TaskBranch {
  taskId: TaskId;
  name: string;
  forkAt: ISODate;
  baselineFinish: DatedOffset | null;
  currentFinish: DatedOffset;
  currentDelta: WorkDays;
  /** MERGED once the task is back on its planned date; it re-opens if it deviates again. */
  status: 'OPEN' | 'MERGED';
  steps: TaskBranchStep[];
}

export interface ModuleView {
  moduleId: ModuleId;
  name: string;
  kind: ModuleKind;
  original: { start: DatedOffset | null; finish: DatedOffset | null };
  current: { start: DatedOffset; finish: DatedOffset; planFinish: DatedOffset | null; variance: WorkDays; asOf: ISODate | null };
  /** Every task of the module, in the order they are planned to finish. */
  dots: TaskDot[];
  /** One for each task that has moved from its plan, in the order they first moved. */
  branches: TaskBranch[];
  /** The recorded changes that touched this module, whether or not they moved anything in it. */
  markers: EventMarker[];
}

export interface MilestoneOptions {
  /** Tasks the project manager flagged as project milestones. Unknown ids are ignored. */
  flaggedTaskIds?: readonly TaskId[];
}

const KIND_ORDER: Record<DotKind, number> = { MODULE_START: 0, MILESTONE: 1, MODULE_FINISH: 2 };

const dated = (offset: number, date: ISODate): DatedOffset => ({ offset, date });

/** Plan and forecast offsets are counted in different calendars once a holiday has been added; compare in today’s. */
function rebaser(state: ProjectState): (offset: number) => number {
  const from = state.baseline.calendar;
  const to = state.plan.calendar;
  return (offset) => rebaseOffset(offset, from, to);
}

function last<T>(items: readonly T[]): T {
  return items[items.length - 1] as T;
}

/**
 * The project view’s dots: when each module starts, when each finishes, and any other checkpoint (a milestone task
 * or a task someone flagged). Positions are given as originally planned, as the plan now stands, and as forecast.
 */
export function buildMilestones(state: ProjectState, options: MilestoneOptions = {}): MilestoneDot[] {
  const first = state.snapshots[0] as ForecastSnapshot;
  const latest = last(state.snapshots);
  const flagged = new Set(options.flaggedTaskIds ?? []);
  const rebase = rebaser(state);
  const taskIndex = new Map(state.schedule.order.map((id, i) => [id, i]));
  const dots: MilestoneDot[] = [];

  const reachedOf = (tasks: readonly Task[], what: 'start' | 'finish'): boolean => {
    const states = tasks.map((t) => state.schedule.tasks[t.id]?.state);
    return what === 'start' ? states.some((s) => s !== undefined && s !== 'NOT_STARTED') : states.length > 0 && states.every((s) => s === 'DONE');
  };

  for (const module of state.plan.modules) {
    const tasks = state.plan.tasks.filter((t) => t.moduleId === module.id);
    if (tasks.length === 0) continue;

    // Start: the earliest any of its tasks starts.
    const startOf = (pick: (id: TaskId) => { start: number; startDate: ISODate } | undefined, ids: readonly TaskId[]): DatedOffset | null => {
      let best: { start: number; startDate: ISODate } | undefined;
      for (const id of ids) {
        const t = pick(id);
        if (t && (best === undefined || t.start < best.start)) best = t;
      }
      return best ? dated(best.start, best.startDate) : null;
    };
    const ids = tasks.map((t) => t.id);
    const forecastStart = startOf((id) => state.schedule.tasks[id], ids) as DatedOffset;
    const planStart = startOf((id) => state.baselineSchedule.tasks[id], ids);
    const originalStart = startOf((id) => first.tasks[id], ids);
    dots.push({
      id: `start:${module.id}`,
      kind: 'MODULE_START',
      name: `${module.name} starts`,
      moduleId: module.id,
      taskId: null,
      original: originalStart,
      plan: planStart,
      forecast: forecastStart,
      variance: planStart ? tidy(forecastStart.offset - rebase(planStart.offset)) : 0,
      reached: reachedOf(tasks, 'start'),
      flagged: false,
      critical: tasks.some((t) => state.schedule.tasks[t.id]?.critical === true && state.schedule.tasks[t.id]?.start === forecastStart.offset),
    });

    // Finish: the last task to finish. If it is a milestone, the module’s finish is called by its name.
    const forecastFinishOf = (id: TaskId): number => state.schedule.tasks[id]?.finish ?? Number.NEGATIVE_INFINITY;
    const lastTask = [...tasks].sort(
      (a, b) =>
        forecastFinishOf(b.id) - forecastFinishOf(a.id) ||
        Number(b.kind === 'MILESTONE') - Number(a.kind === 'MILESTONE') ||
        (taskIndex.get(b.id) ?? 0) - (taskIndex.get(a.id) ?? 0),
    )[0] as Task;
    const moduleForecast = latest.modules[module.id];
    const moduleOriginal = first.modules[module.id];
    if (moduleForecast) {
      dots.push({
        id: `finish:${module.id}`,
        kind: 'MODULE_FINISH',
        name: lastTask.kind === 'MILESTONE' || flagged.has(lastTask.id) ? lastTask.name : `${module.name} done`,
        moduleId: module.id,
        taskId: lastTask.id,
        original: moduleOriginal ? dated(moduleOriginal.forecastFinish, moduleOriginal.forecastFinishDate) : null,
        plan: moduleForecast.baselineFinish !== null && moduleForecast.baselineFinishDate !== null ? dated(moduleForecast.baselineFinish, moduleForecast.baselineFinishDate) : null,
        forecast: dated(moduleForecast.forecastFinish, moduleForecast.forecastFinishDate),
        variance: moduleForecast.variance,
        reached: reachedOf(tasks, 'finish'),
        flagged: flagged.has(lastTask.id),
        critical: state.schedule.tasks[lastTask.id]?.critical === true,
      });
    }

    // Any other checkpoint in the module.
    for (const task of tasks) {
      if (task.id === lastTask.id) continue;
      if (task.kind !== 'MILESTONE' && !flagged.has(task.id)) continue;
      const now = state.schedule.tasks[task.id];
      if (!now) continue;
      const plan = state.baselineSchedule.tasks[task.id];
      const original = first.tasks[task.id];
      dots.push({
        id: `task:${task.id}`,
        kind: 'MILESTONE',
        name: task.name,
        moduleId: module.id,
        taskId: task.id,
        original: original ? dated(original.finish, original.finishDate) : null,
        plan: plan ? dated(plan.finish, plan.finishDate) : null,
        forecast: dated(now.finish, now.finishDate),
        variance: plan ? tidy(now.finish - rebase(plan.finish)) : 0,
        reached: now.state === 'DONE',
        flagged: flagged.has(task.id),
        critical: now.critical,
      });
    }
  }

  const sortKey = (d: MilestoneDot): number => (d.original ?? d.forecast).offset;
  return dots.sort((a, b) => sortKey(a) - sortKey(b) || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.name.localeCompare(b.name));
}

/**
 * One module on its own: each task’s finish as a dot, and a branch for every task that has moved away from its
 * plan. The same rules as the project view, one level down. Throws if the module does not exist.
 */
export function buildModuleView(state: ProjectState, moduleId: ModuleId): ModuleView {
  const module = state.plan.modules.find((m) => m.id === moduleId);
  if (!module) throw new Error(`No module "${moduleId}"`);
  const first = state.snapshots[0] as ForecastSnapshot;
  const latest = last(state.snapshots);
  const rebase = rebaser(state);
  const tasks = state.plan.tasks.filter((t) => t.moduleId === moduleId);
  const original = new Set(Object.keys(first.tasks));

  const dots: TaskDot[] = tasks.flatMap((task): TaskDot[] => {
    const now = state.schedule.tasks[task.id];
    if (!now) return [];
    const plan = state.baselineSchedule.tasks[task.id];
    const was = first.tasks[task.id];
    return [
      {
        taskId: task.id,
        name: task.name,
        teamId: task.teamId,
        kind: task.kind,
        estimate: task.estimate,
        original: was ? dated(was.finish, was.finishDate) : null,
        plan: plan ? dated(plan.finish, plan.finishDate) : null,
        start: dated(now.start, now.startDate),
        forecast: dated(now.finish, now.finishDate),
        variance: plan ? tidy(now.finish - rebase(plan.finish)) : 0,
        state: now.state,
        critical: now.critical,
        added: !original.has(task.id),
      },
    ];
  });
  // Tasks that finish together are listed in the order the work happens (development, then the alpha it leads to).
  const orderOf = new Map(state.schedule.order.map((id, i) => [id, i]));
  dots.sort(
    (a, b) =>
      (a.original ?? a.forecast).offset - (b.original ?? b.forecast).offset ||
      a.forecast.offset - b.forecast.offset ||
      (orderOf.get(a.taskId) ?? 0) - (orderOf.get(b.taskId) ?? 0),
  );

  // Branches: walk the history and note every step that moved one of this module’s tasks. Planning changes move
  // the plan and the forecast together, so they are not deviations and make no steps.
  const branches = new Map<TaskId, TaskBranch>();
  const touchedRevisions = new Set<number>();
  for (let k = 1; k < state.snapshots.length; k++) {
    const before = state.snapshots[k - 1] as ForecastSnapshot;
    const now = state.snapshots[k] as ForecastSnapshot;
    const explanation = explainSnapshot(before, now);
    const mine = explanation.tasks.filter((t) => t.moduleId === moduleId);
    if (now.touchedModuleIds.includes(moduleId) || mine.length > 0) touchedRevisions.add(now.revision);
    if (now.kind === 'PLAN' || now.kind === 'BASELINE') continue;

    const kind = now.kind;
    const eventId = (now.eventId ?? now.planEditId) as string;
    const asOf = now.asOf as ISODate;
    const touched = new Set(now.touchedTaskIds);
    const moved = new Set(explanation.tasks.filter((t) => t.change !== 'REMOVED').map((t) => t.taskId));

    for (const change of mine) {
      if (change.change === 'REMOVED') continue;
      const after = now.tasks[change.taskId];
      if (!after) continue;
      if (change.change === 'MOVED' && Math.abs(change.finishDelta) <= EPS) continue;

      // PROPAGATED: it moved because something before it on the driving chain moved; name the nearest such task.
      const direct = touched.has(change.taskId);
      const fromTaskIds: TaskId[] = [];
      if (!direct) {
        const seen = new Set<TaskId>();
        for (let id = after.drivingPredecessor; id !== null && !seen.has(id); ) {
          seen.add(id);
          if (moved.has(id) || touched.has(id)) {
            fromTaskIds.push(id);
            break;
          }
          id = now.tasks[id]?.drivingPredecessor ?? null;
        }
      }

      let branch = branches.get(change.taskId);
      if (!branch) {
        const plan = state.baselineSchedule.tasks[change.taskId];
        branch = {
          taskId: change.taskId,
          name: tasks.find((t) => t.id === change.taskId)?.name ?? change.taskId,
          forkAt: asOf,
          baselineFinish: plan ? dated(plan.finish, plan.finishDate) : null,
          currentFinish: dated(after.finish, after.finishDate),
          currentDelta: 0,
          status: 'OPEN',
          steps: [],
        };
        branches.set(change.taskId, branch);
      }
      branch.steps.push({
        revision: now.revision,
        kind,
        eventId,
        asOf,
        change: change.change === 'ADDED' ? 'ADDED' : 'MOVED',
        delta: change.change === 'ADDED' ? 0 : change.finishDelta,
        finishAfter: dated(after.finish, after.finishDate),
        origin: direct ? 'DIRECT' : 'PROPAGATED',
        fromTaskIds,
        onCriticalPath: after.critical,
      });
    }
  }

  // A branch describes where its task stands now, which may be later than its last step.
  for (const branch of [...branches.values()]) {
    const dot = dots.find((d) => d.taskId === branch.taskId);
    if (!dot) {
      branches.delete(branch.taskId); // the task was taken out of the plan since
      continue;
    }
    branch.currentFinish = dot.forecast;
    branch.currentDelta = dot.variance;
    branch.status = Math.abs(dot.variance) <= EPS && !dot.added ? 'MERGED' : 'OPEN';
  }

  const forecastStart = dots.length > 0 ? dots.reduce((a, d) => (d.start.offset < a.offset ? d.start : a), (dots[0] as TaskDot).start) : dated(0, latest.forecastDelivery.date);
  const moduleForecast = latest.modules[moduleId];
  const moduleOriginal = first.modules[moduleId];
  const originalDots = dots.filter((d) => d.original !== null);
  const originalStart = (() => {
    let best: { start: number; startDate: ISODate } | undefined;
    for (const d of originalDots) {
      const t = first.tasks[d.taskId];
      if (t && (best === undefined || t.start < best.start)) best = t;
    }
    return best ? dated(best.start, best.startDate) : null;
  })();

  const markers = buildTimeline(state).markers.filter((m) => touchedRevisions.has(m.revision));

  return {
    moduleId,
    name: module.name,
    kind: module.kind,
    original: { start: originalStart, finish: moduleOriginal ? dated(moduleOriginal.forecastFinish, moduleOriginal.forecastFinishDate) : null },
    current: {
      start: forecastStart,
      finish: moduleForecast ? dated(moduleForecast.forecastFinish, moduleForecast.forecastFinishDate) : forecastStart,
      planFinish: moduleForecast && moduleForecast.baselineFinish !== null && moduleForecast.baselineFinishDate !== null ? dated(moduleForecast.baselineFinish, moduleForecast.baselineFinishDate) : null,
      variance: moduleForecast?.variance ?? 0,
      asOf: state.asOf,
    },
    dots,
    branches: [...branches.values()],
    markers,
  };
}
