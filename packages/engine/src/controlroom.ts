import { EPS } from './calendar';
import type { ProjectState } from './history';
import type { DatedOffset } from './snapshot';
import { firstBreach, forecastDrift } from './timeline';
import type { Breach, DriftPoint } from './timeline';
import type { ISODate, ModuleId, ModuleKind, TaskId, TeamId, WorkDays } from './types';
import { tidy } from './util';

/** A task worth watching: on the driving chain, or close to it. */
export interface WatchTask {
  taskId: TaskId;
  name: string;
  moduleId: ModuleId;
  teamId: TeamId;
  state: 'DONE' | 'IN_PROGRESS' | 'NOT_STARTED';
  startDate: ISODate;
  finishDate: ISODate;
  /** Working days it can slip before delivery moves. 0 = critical. */
  totalFloat: WorkDays;
}

export interface ProgressFigures {
  /** Effort in work-days at planned capacity: everything finished, and everything there is. */
  doneEffort: WorkDays;
  totalEffort: WorkDays;
  /** done / total, as a percentage to one decimal place. Includes work the forecast merely assumes was done. */
  percent: number;
  /** Only what someone recorded. The gap to `percent` is progress the forecast is taking on trust. */
  confirmedPercent: number;
}

export interface ModuleStatus extends ProgressFigures {
  moduleId: ModuleId;
  name: string;
  kind: ModuleKind;
  baselineFinish: DatedOffset | null;
  forecastFinish: DatedOffset;
  variance: WorkDays;
  openTasks: number;
}

export interface ControlRoom {
  asOf: ISODate | null;
  /** The plan as it was when the project started (revision 0). */
  original: DatedOffset;
  /** The plan as it stands after planning changes. Variance is measured against this. */
  plan: DatedOffset;
  forecast: DatedOffset;
  variance: WorkDays;
  progress: ProgressFigures;
  bottleneck: {
    /** The first unfinished task on the driving chain: what is setting the pace right now. */
    current: WatchTask | null;
    /** Every unfinished task on the driving chain, in order, ending at delivery. */
    chain: WatchTask[];
    /** The non-critical task with the least float: the likeliest next bottleneck. */
    next: WatchTask | null;
    /** Unfinished work that is not critical but has little float, least first. */
    watchlist: WatchTask[];
  };
  modules: ModuleStatus[];
  trend: DriftPoint[];
  firstBreach: Breach | null;
}

export interface ControlRoomOptions {
  /** Unfinished non-critical work with at most this much float is on the watch list. Default 2 working days. */
  watchFloat?: WorkDays;
  /** At most this many tasks on the watch list. Default 8. */
  watchLimit?: number;
}

const pct = (done: number, total: number): number => (total <= EPS ? 0 : Math.round((done / total) * 1000) / 10);

/**
 * The management view (spec §18): where are we, are we on time, when will we finish, what is setting the pace, and
 * what is likely to become the next bottleneck. Pure: derived from the project state, nothing is stored.
 */
export function buildControlRoom(state: ProjectState, options: ControlRoomOptions = {}): ControlRoom {
  const watchFloat = options.watchFloat ?? 2;
  const watchLimit = options.watchLimit ?? 8;
  const first = state.snapshots[0];
  const last = state.snapshots[state.snapshots.length - 1];
  if (!first || !last) throw new Error('A project state always has at least its baseline snapshot');

  const tasks = state.plan.tasks;
  const scheduled = state.schedule.tasks;
  const nameOf = new Map(tasks.map((t) => [t.id, t]));

  const watch = (taskId: TaskId): WatchTask | null => {
    const t = nameOf.get(taskId);
    const s = scheduled[taskId];
    if (!t || !s) return null;
    return { taskId, name: t.name, moduleId: t.moduleId, teamId: t.teamId, state: s.state, startDate: s.startDate, finishDate: s.finishDate, totalFloat: s.totalFloat };
  };

  // Effort-weighted progress (spec: not task counts, which would let a one-day task weigh the same as a ten-day one).
  const figures = (ids: readonly TaskId[]): ProgressFigures => {
    let total = 0;
    let done = 0;
    let confirmed = 0;
    for (const id of ids) {
      const t = nameOf.get(id);
      const s = scheduled[id];
      if (!t || !s || t.kind !== 'TASK') continue;
      const worked = s.state === 'DONE' ? t.estimate : s.state === 'IN_PROGRESS' ? Math.max(0, Math.min(t.estimate, t.estimate - s.remainingEffort)) : 0;
      total += t.estimate;
      done += worked;
      if (t.progress?.assumed !== true) confirmed += worked;
    }
    return { doneEffort: tidy(done), totalEffort: tidy(total), percent: pct(done, total), confirmedPercent: pct(confirmed, total) };
  };

  const byModule = new Map<ModuleId, TaskId[]>();
  for (const t of tasks) byModule.set(t.moduleId, [...(byModule.get(t.moduleId) ?? []), t.id]);

  const modules: ModuleStatus[] = state.plan.modules.flatMap((m) => {
    const forecast = last.modules[m.id];
    if (!forecast) return [];
    const ids = byModule.get(m.id) ?? [];
    return [
      {
        moduleId: m.id,
        name: m.name,
        kind: m.kind,
        ...figures(ids),
        baselineFinish:
          forecast.baselineFinish !== null && forecast.baselineFinishDate !== null
            ? { offset: forecast.baselineFinish, date: forecast.baselineFinishDate }
            : null,
        forecastFinish: { offset: forecast.forecastFinish, date: forecast.forecastFinishDate },
        variance: forecast.variance,
        openTasks: ids.filter((id) => nameOf.get(id)?.kind === 'TASK' && scheduled[id]?.state !== 'DONE').length,
      },
    ];
  });

  const chain = state.schedule.drivingChain.flatMap((id) => {
    const w = watch(id);
    return w && w.state !== 'DONE' ? [w] : [];
  });

  const watchlist = tasks
    .filter((t) => {
      const s = scheduled[t.id];
      return t.kind === 'TASK' && s !== undefined && s.state !== 'DONE' && !s.critical && s.totalFloat <= watchFloat + EPS;
    })
    .map((t) => watch(t.id) as WatchTask)
    .sort((a, b) => a.totalFloat - b.totalFloat || (scheduled[a.taskId]?.finish ?? 0) - (scheduled[b.taskId]?.finish ?? 0) || a.taskId.localeCompare(b.taskId))
    .slice(0, watchLimit);

  return {
    asOf: last.asOf,
    original: first.baselineDelivery,
    plan: last.baselineDelivery,
    forecast: last.forecastDelivery,
    variance: last.variance,
    progress: figures(tasks.map((t) => t.id)),
    bottleneck: { current: chain[0] ?? null, chain, next: watchlist[0] ?? null, watchlist },
    modules,
    trend: forecastDrift(state),
    firstBreach: firstBreach(state),
  };
}
