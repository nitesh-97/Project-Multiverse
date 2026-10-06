import { EPS, WorkCalendar, snap } from './calendar';
import { CapacityModel } from './capacity';
import { PlanError } from './errors';
import { topologicalOrder } from './graph';
import { validatePlan } from './plan';
import type { ISODate, ModuleId, Plan, Task, TaskId } from './types';
import { must } from './util';

export type TaskState = 'DONE' | 'IN_PROGRESS' | 'NOT_STARTED';

export interface ScheduledTask {
  id: TaskId;
  moduleId: ModuleId;
  state: TaskState;
  /** Working-day offsets, see WorkCalendar. */
  start: number;
  finish: number;
  /** Elapsed working days between start and finish (differs from the estimate when capacity differs from plan). */
  duration: number;
  startDate: ISODate;
  finishDate: ISODate;
  /** The offset from which the remaining effort is burned: the status date for in-progress work, `start` otherwise. */
  burnStart: number;
  /** Effort left to do at `burnStart`, in work-days at planned capacity. 0 for finished work and milestones. */
  remainingEffort: number;
  /** How far this task can slip before the delivery date moves. <= 0 means critical. */
  totalFloat: number;
  /** How far this task can slip before any successor's start moves. */
  freeFloat: number;
  critical: boolean;
  /** The predecessor whose finish set this task's start; null if the status date or a constraint did. */
  drivingPredecessor: TaskId | null;
}

export interface ModuleSchedule {
  id: ModuleId;
  /** Finish of the module's last task. */
  finish: number;
  finishDate: ISODate;
}

export interface Schedule {
  asOf: ISODate | null;
  /** The status date as an offset (end of the asOf day); 0 when no asOf was given. */
  statusOffset: number;
  /** Tasks keyed by id, in topological order. */
  tasks: Record<TaskId, ScheduledTask>;
  order: TaskId[];
  delivery: { taskId: TaskId; finish: number; date: ISODate };
  /** Every task with zero (or negative) total float, in topological order. */
  criticalPath: TaskId[];
  /** From the first task that sets the pace to delivery, following driving predecessors. */
  drivingChain: TaskId[];
  modules: Record<ModuleId, ModuleSchedule>;
}

/**
 * Computes the forecast for `plan` as of the end of working day `asOf`.
 *
 * Without `asOf` the plan is scheduled from the project start, which gives the baseline.
 * With `asOf`, finished and started tasks use their actuals and everything else is planned
 * from the status date onwards. Pure: no clock, no I/O, plan is not modified.
 *
 * The backward pass reuses each task's forward-resolved elapsed duration. That is exact when
 * capacity is constant and a close approximation when a slip would move a task into a different
 * capacity window (DESIGN.md §3.3).
 */
export function schedule(plan: Plan, asOf?: ISODate): Schedule {
  validatePlan(plan);

  const cal = new WorkCalendar(plan.calendar);
  const capacity = new CapacityModel(plan.capacity, cal);
  const statusOffset = asOf === undefined ? 0 : cal.endOffsetClamped(asOf);

  const taskById = new Map(plan.tasks.map((t) => [t.id, t]));
  const preds = new Map<TaskId, TaskId[]>(plan.tasks.map((t) => [t.id, []]));
  const succs = new Map<TaskId, TaskId[]>(plan.tasks.map((t) => [t.id, []]));
  for (const d of plan.dependencies) {
    must(preds, d.successorId).push(d.predecessorId);
    must(succs, d.predecessorId).push(d.successorId);
  }
  const order = topologicalOrder(
    plan.tasks.map((t) => t.id),
    plan.dependencies.map((d) => [d.predecessorId, d.successorId] as const),
  );

  interface Placed {
    task: Task;
    state: TaskState;
    start: number;
    finish: number;
    burnStart: number;
    remainingEffort: number;
    driver: TaskId | null;
  }
  const placed = new Map<TaskId, Placed>();

  // Forward pass.
  for (const id of order) {
    const task = must(taskById, id);
    const progress = task.progress;

    const finishedAt =
      progress?.finishedAt ?? (progress?.finishedOn !== undefined ? cal.endOffset(progress.finishedOn) : undefined);
    const startedAt =
      progress?.startedAt ?? (progress?.startedOn !== undefined ? cal.startOffset(progress.startedOn) : undefined);

    if (
      asOf === undefined &&
      (finishedAt !== undefined || (startedAt !== undefined && task.kind === 'TASK'))
    ) {
      throw new PlanError(`Task ${id} has progress recorded but no asOf date was given`);
    }

    if (finishedAt !== undefined && progress) {
      // Compared as dates: the start of one day and the end of the previous day are the same offset.
      if (
        progress.startedOn !== undefined &&
        progress.finishedOn !== undefined &&
        progress.startedOn > progress.finishedOn
      ) {
        throw new PlanError(`Task ${id} finished before it started`);
      }
      const start =
        task.kind === 'MILESTONE'
          ? finishedAt
          : (startedAt ?? (progress.finishedOn !== undefined ? cal.startOffset(progress.finishedOn) : finishedAt));
      if (start > finishedAt + EPS) throw new PlanError(`Task ${id} finished before it started`);
      if (finishedAt > statusOffset + EPS) {
        throw new PlanError(`Task ${id} is recorded as finished after the status date ${asOf}`);
      }
      placed.set(id, {
        task,
        state: 'DONE',
        start: snap(start),
        finish: snap(finishedAt),
        burnStart: snap(finishedAt),
        remainingEffort: 0,
        driver: null,
      });
      continue;
    }

    if (startedAt !== undefined && progress && task.kind === 'TASK') {
      if (startedAt > statusOffset + EPS) {
        throw new PlanError(`Task ${id} is recorded as started after the status date ${asOf}`);
      }
      const remaining = progress.remaining ?? task.estimate;
      placed.set(id, {
        task,
        state: 'IN_PROGRESS',
        start: snap(startedAt),
        finish: capacity.timeToComplete(task.teamId, statusOffset, remaining),
        burnStart: statusOffset,
        remainingEffort: remaining,
        driver: null,
      });
      continue;
    }

    const floor = Math.max(
      statusOffset,
      task.startNoEarlierThan !== undefined ? cal.startOffsetClamped(task.startNoEarlierThan) : 0,
    );
    let predFinish = Number.NEGATIVE_INFINITY;
    let predDriver: TaskId | null = null;
    for (const pid of must(preds, id)) {
      const f = must(placed, pid).finish;
      if (f > predFinish + EPS) {
        predFinish = f;
        predDriver = pid;
      }
    }
    const start = snap(Math.max(floor, predFinish));
    const driver = predDriver !== null && predFinish >= floor - EPS ? predDriver : null;
    const isMilestone = task.kind === 'MILESTONE';
    placed.set(id, {
      task,
      state: 'NOT_STARTED',
      start,
      finish: isMilestone ? start : capacity.timeToComplete(task.teamId, start, task.estimate),
      burnStart: start,
      remainingEffort: isMilestone ? 0 : task.estimate,
      driver,
    });
  }

  const delivery = must(placed, plan.deliveryTaskId);
  const projectEnd = delivery.finish;

  // Backward pass: late finish of each task given the delivery date.
  const lateFinish = new Map<TaskId, number>();
  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i] as TaskId;
    const next = must(succs, id);
    let lf = projectEnd;
    if (next.length > 0) {
      lf = Number.POSITIVE_INFINITY;
      for (const s of next) {
        const sp = must(placed, s);
        lf = Math.min(lf, must(lateFinish, s) - (sp.finish - sp.start));
      }
    }
    lateFinish.set(id, snap(lf));
  }

  const tasks: Record<TaskId, ScheduledTask> = {};
  const modules: Record<ModuleId, ModuleSchedule> = {};
  const criticalPath: TaskId[] = [];

  for (const id of order) {
    const p = must(placed, id);
    const next = must(succs, id);
    const duration = snap(p.finish - p.start);
    const totalFloat = snap(must(lateFinish, id) - p.finish);
    let freeFloat = next.length === 0 ? projectEnd - p.finish : Number.POSITIVE_INFINITY;
    for (const s of next) freeFloat = Math.min(freeFloat, must(placed, s).start - p.finish);
    freeFloat = snap(freeFloat);
    const critical = totalFloat <= EPS;
    if (critical) criticalPath.push(id);

    const finishDate = cal.dateAtOffset(p.finish);
    tasks[id] = {
      id,
      moduleId: p.task.moduleId,
      state: p.state,
      start: p.start,
      finish: p.finish,
      duration,
      startDate: duration > EPS ? cal.startDateAtOffset(p.start) : finishDate,
      finishDate,
      burnStart: p.burnStart,
      remainingEffort: p.remainingEffort,
      totalFloat,
      freeFloat,
      critical,
      drivingPredecessor: p.driver,
    };

    const m = modules[p.task.moduleId];
    if (!m || p.finish > m.finish) {
      modules[p.task.moduleId] = { id: p.task.moduleId, finish: p.finish, finishDate };
    }
  }

  const drivingChain: TaskId[] = [];
  for (let id: TaskId | null = plan.deliveryTaskId; id !== null; id = must(placed, id).driver) {
    drivingChain.push(id);
  }
  drivingChain.reverse();

  return {
    asOf: asOf ?? null,
    statusOffset,
    tasks,
    order,
    delivery: { taskId: plan.deliveryTaskId, finish: projectEnd, date: cal.dateAtOffset(projectEnd) },
    criticalPath,
    drivingChain,
    modules,
  };
}
