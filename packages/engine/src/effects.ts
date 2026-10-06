import { isISODate, snap } from './calendar';
import { EffectError, PlanError } from './errors';
import type { Effect } from './events';
import { validatePlan } from './plan';
import type { ModuleId, Plan, Task, TaskId, TaskProgress, TeamId, WorkDays } from './types';

export interface EffectResult {
  /** A new plan; the input is never modified. */
  plan: Plan;
  /** Effort added (+) or removed (-) by the effects, in work-days. Capacity, blockers and dependencies are 0. */
  effortImpact: WorkDays;
  touchedTaskIds: TaskId[];
  touchedModuleIds: ModuleId[];
  touchedTeamIds: TeamId[];
}

export function hasStarted(task: Task): boolean {
  const p = task.progress;
  return (
    p !== undefined &&
    (p.startedOn !== undefined || p.startedAt !== undefined || p.finishedOn !== undefined || p.finishedAt !== undefined)
  );
}

export function isFinished(task: Task): boolean {
  const p = task.progress;
  return p !== undefined && (p.finishedOn !== undefined || p.finishedAt !== undefined);
}

/**
 * Applies `effects` in order to a copy of `plan`. Throws EffectError, naming the failing effect, if any of them
 * cannot be applied or if the result is not a valid plan.
 */
export function applyEffects(plan: Plan, effects: readonly Effect[]): EffectResult {
  const next = structuredClone(plan);
  const touchedTasks = new Set<TaskId>();
  const touchedModules = new Set<ModuleId>();
  const touchedTeams = new Set<TeamId>();
  let effort = 0;

  effects.forEach((effect, i) => {
    const fail = (message: string): never => {
      throw new EffectError(`Effect ${i + 1} (${effect.op}): ${message}`);
    };
    const need = (id: TaskId): Task => next.tasks.find((t) => t.id === id) ?? fail(`unknown task ${id}`);
    const touch = (t: Task): void => {
      touchedTasks.add(t.id);
      touchedModules.add(t.moduleId);
    };
    const edgeIndex = (p: TaskId, s: TaskId): number =>
      next.dependencies.findIndex((d) => d.predecessorId === p && d.successorId === s);
    const addEdge = (pred: Task, succ: Task): void => {
      if (pred.id === succ.id) fail(`task ${pred.id} cannot depend on itself`);
      if (edgeIndex(pred.id, succ.id) >= 0) fail(`${succ.id} already depends on ${pred.id}`);
      if (hasStarted(succ)) fail(`task ${succ.id} has already started, so it cannot be made to wait for ${pred.id}`);
      next.dependencies.push({ predecessorId: pred.id, successorId: succ.id, type: 'FS' });
    };
    const addEffort = (t: Task, delta: WorkDays): void => {
      if (!Number.isFinite(delta)) fail(`invalid effort ${delta}`);
      if (isFinished(t)) fail(`task ${t.id} is already finished; add a rework task instead`);
      const estimate = snap(t.estimate + delta);
      if (estimate < 0) fail(`task ${t.id} would end up with a negative estimate`);
      if (hasStarted(t)) {
        const remaining = snap((t.progress?.remaining ?? t.estimate) + delta);
        if (remaining < 0) fail(`task ${t.id} would end up with negative remaining effort`);
        t.progress = { ...t.progress, remaining };
      }
      t.estimate = estimate;
      effort = snap(effort + delta);
    };

    switch (effect.op) {
      case 'ADD_TASK': {
        const def = effect.task;
        if (next.tasks.some((t) => t.id === def.id)) fail(`task ${def.id} already exists`);
        const task: Task = structuredClone(def);
        delete task.progress;
        next.tasks.push(task);
        for (const pid of effect.dependsOn) addEdge(need(pid), task);
        for (const sid of effect.blocks) addEdge(task, need(sid));
        effort = snap(effort + task.estimate);
        touch(task);
        break;
      }

      case 'ADJUST_ESTIMATE': {
        const t = need(effect.taskId);
        addEffort(t, effect.delta);
        touch(t);
        break;
      }

      case 'REMOVE_TASK': {
        const t = need(effect.taskId);
        if (t.id === next.deliveryTaskId) fail('the delivery milestone cannot be removed');
        if (hasStarted(t)) fail(`task ${t.id} has already started and cannot be removed`);
        const before = next.dependencies.filter((d) => d.successorId === t.id).map((d) => d.predecessorId);
        const after = next.dependencies.filter((d) => d.predecessorId === t.id).map((d) => d.successorId);
        next.dependencies = next.dependencies.filter((d) => d.predecessorId !== t.id && d.successorId !== t.id);
        next.tasks = next.tasks.filter((x) => x.id !== t.id);
        for (const p of before) {
          for (const s of after) {
            if (edgeIndex(p, s) < 0) next.dependencies.push({ predecessorId: p, successorId: s, type: 'FS' });
          }
        }
        effort = snap(effort - t.estimate);
        touch(t);
        break;
      }

      case 'ADD_DEPENDENCY': {
        const succ = need(effect.successorId);
        addEdge(need(effect.predecessorId), succ);
        touch(succ);
        break;
      }

      case 'REMOVE_DEPENDENCY': {
        const succ = need(effect.successorId);
        need(effect.predecessorId);
        const idx = edgeIndex(effect.predecessorId, effect.successorId);
        if (idx < 0) fail(`${effect.successorId} does not depend on ${effect.predecessorId}`);
        next.dependencies.splice(idx, 1);
        touch(succ);
        break;
      }

      case 'BLOCK_UNTIL': {
        const t = need(effect.taskId);
        if (hasStarted(t)) fail(`task ${t.id} has already started`);
        if (effect.date === null) {
          delete t.startNoEarlierThan;
        } else {
          if (!isISODate(effect.date)) fail(`invalid date "${effect.date}"`);
          t.startNoEarlierThan = effect.date;
        }
        touch(t);
        break;
      }

      case 'SET_CAPACITY': {
        if (!next.teams.some((t) => t.id === effect.teamId)) fail(`unknown team ${effect.teamId}`);
        if (!isISODate(effect.from)) fail(`invalid date "${effect.from}"`);
        if (!Number.isFinite(effect.headcount) || effect.headcount < 0) fail(`invalid headcount ${effect.headcount}`);
        const rows = next.capacity.filter((c) => c.teamId === effect.teamId);
        if (rows.length === 0) fail(`team ${effect.teamId} has no planned headcount to change from`);
        const planned = rows.reduce((a, b) => (b.from < a.from ? b : a));
        if (effect.from <= planned.from) {
          fail(`capacity can only change after the planned headcount date ${planned.from}`);
        }
        const idx = next.capacity.findIndex((c) => c.teamId === effect.teamId && c.from === effect.from);
        const point = { teamId: effect.teamId, from: effect.from, headcount: effect.headcount };
        if (idx >= 0) next.capacity[idx] = point;
        else next.capacity.push(point);
        touchedTeams.add(effect.teamId);
        break;
      }

      case 'RECORD_PROGRESS': {
        const t = need(effect.taskId);
        for (const [field, value] of [
          ['startedOn', effect.startedOn],
          ['finishedOn', effect.finishedOn],
        ] as const) {
          if (typeof value === 'string' && !isISODate(value)) fail(`invalid ${field} "${value}"`);
        }
        if (typeof effect.remaining === 'number' && !(effect.remaining >= 0)) fail(`invalid remaining ${effect.remaining}`);

        const p: TaskProgress = { ...t.progress };
        if (effect.startedOn !== undefined) {
          delete p.startedAt;
          if (effect.startedOn === null) delete p.startedOn;
          else p.startedOn = effect.startedOn;
        }
        if (effect.finishedOn !== undefined) {
          delete p.finishedAt;
          if (effect.finishedOn === null) delete p.finishedOn;
          else p.finishedOn = effect.finishedOn;
        }
        if (effect.remaining !== undefined) {
          if (effect.remaining === null) delete p.remaining;
          else p.remaining = effect.remaining;
        }
        if (p.finishedOn !== undefined || p.finishedAt !== undefined) delete p.remaining;
        const started = p.startedOn !== undefined || p.startedAt !== undefined;
        if (p.remaining !== undefined && !started) fail('remaining effort needs a start date (startedOn)');

        if (Object.keys(p).length === 0) delete t.progress;
        else t.progress = p;
        touch(t);
        break;
      }

      case 'TRANSFER_OWNER': {
        const t = need(effect.taskId);
        if (isFinished(t)) fail(`task ${t.id} is already finished`);
        const cost = effect.contextCost ?? 0;
        if (!(cost >= 0)) fail(`invalid context cost ${cost}`);
        if (cost > 0) addEffort(t, cost);
        t.ownerId = effect.toPersonId;
        touch(t);
        break;
      }
    }
  });

  try {
    validatePlan(next);
  } catch (e) {
    if (e instanceof PlanError) throw new EffectError(`Resulting plan is invalid: ${e.issues.join('; ')}`);
    throw e;
  }

  return {
    plan: next,
    effortImpact: effort,
    touchedTaskIds: [...touchedTasks],
    touchedModuleIds: [...touchedModules],
    touchedTeamIds: [...touchedTeams],
  };
}
