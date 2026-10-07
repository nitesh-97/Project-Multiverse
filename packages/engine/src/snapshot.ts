import { rebaseOffset } from './calendar';
import type { Schedule, ScheduledTask } from './schedule';
import type { CalendarSpec, ISODate, ModuleId, Plan, TaskId, WorkDays } from './types';
import { tidy } from './util';

export const ENGINE_VERSION = '0.2.0';

/**
 * BASELINE: the original plan (revision 0). EVENT: something happened to the project. PLAN: the plan of a module that
 * had not started was refined. VOID: an earlier event was withdrawn.
 */
export type SnapshotKind = 'BASELINE' | 'EVENT' | 'PLAN' | 'VOID';

export interface DatedOffset {
  offset: number;
  date: ISODate;
}

export interface ModuleForecast {
  baselineFinish: number | null;
  baselineFinishDate: ISODate | null;
  forecastFinish: number;
  forecastFinishDate: ISODate;
  /** forecastFinish - baselineFinish, in working days of the current calendar; 0 when the module had no baseline. */
  variance: WorkDays;
}

export interface MilestoneForecast {
  baseline: DatedOffset | null;
  forecast: DatedOffset;
}

/**
 * The forecast at one point in the project's history (DESIGN.md §3.5). Immutable and self-contained: it stores
 * results, so history survives later changes to the algorithm. `id`, `projectId` and `recordedAt` are added by
 * persistence.
 */
export interface ForecastSnapshot {
  readonly revision: number;
  readonly kind: SnapshotKind;
  /** The event that triggered this snapshot; for a VOID, the event that was withdrawn. */
  readonly eventId: string | null;
  readonly voidId: string | null;
  /** The plan edit that triggered this snapshot (kind PLAN). */
  readonly planEditId: string | null;
  readonly touchedTaskIds: readonly TaskId[];
  readonly touchedModuleIds: readonly ModuleId[];
  /** Modules that use the feature the trigger is about (`linkedFeatureId`): "affected" without being changed. */
  readonly linkedModuleIds: readonly ModuleId[];
  /** Status date this forecast was made as of (end of that working day); null for the baseline. */
  readonly asOf: ISODate | null;
  /** The calendar the offsets in this snapshot are counted in (holidays can be added during a project). */
  readonly calendar: CalendarSpec;
  /** The plan as it stood at this point. It moves only when a plan edit refines the plan of an unstarted module. */
  readonly baselineDelivery: DatedOffset;
  readonly forecastDelivery: DatedOffset;
  /** forecast delivery - baseline delivery, in working days of the current calendar. */
  readonly variance: WorkDays;
  /** variance - previous snapshot's variance: the schedule impact of this snapshot's trigger. */
  readonly stepDays: WorkDays;
  /** How far the plan itself moved at this step (non-zero only for PLAN snapshots). */
  readonly baselineStepDays: WorkDays;
  /** Effort added (+) or removed (-) by the trigger. */
  readonly effortImpact: WorkDays;
  readonly criticalPath: readonly TaskId[];
  readonly drivingChain: readonly TaskId[];
  readonly tasks: Readonly<Record<TaskId, ScheduledTask>>;
  readonly modules: Readonly<Record<ModuleId, ModuleForecast>>;
  readonly milestones: Readonly<Record<TaskId, MilestoneForecast>>;
  readonly engineVersion: string;
}

export interface SnapshotInput {
  revision: number;
  kind: SnapshotKind;
  eventId: string | null;
  voidId: string | null;
  planEditId?: string | null;
  touchedTaskIds: readonly TaskId[];
  touchedModuleIds: readonly ModuleId[];
  linkedModuleIds?: readonly ModuleId[];
  effortImpact: WorkDays;
  asOf: ISODate | null;
  /** The current plan; its calendar is the one the forecast is counted in. */
  plan: Plan;
  schedule: Schedule;
  /** The calendar the baseline schedule was counted in. */
  baselineCalendar: CalendarSpec;
  baselineSchedule: Schedule;
  previous: ForecastSnapshot | null;
}

export function buildSnapshot(input: SnapshotInput): ForecastSnapshot {
  const { schedule, baselineSchedule: base, previous } = input;
  const now = input.plan.calendar;
  // A baseline made under an older calendar is re-expressed in today's working days before comparing.
  const baseHere = (offset: number): number => rebaseOffset(offset, input.baselineCalendar, now);

  const variance = tidy(schedule.delivery.finish - baseHere(base.delivery.finish));

  const modules: Record<ModuleId, ModuleForecast> = {};
  for (const [id, m] of Object.entries(schedule.modules)) {
    const b = base.modules[id];
    modules[id] = {
      baselineFinish: b?.finish ?? null,
      baselineFinishDate: b?.finishDate ?? null,
      forecastFinish: m.finish,
      forecastFinishDate: m.finishDate,
      variance: b ? tidy(m.finish - baseHere(b.finish)) : 0,
    };
  }

  const milestones: Record<TaskId, MilestoneForecast> = {};
  for (const task of input.plan.tasks) {
    if (task.kind !== 'MILESTONE') continue;
    const f = schedule.tasks[task.id];
    if (!f) continue;
    const b = base.tasks[task.id];
    milestones[task.id] = {
      baseline: b ? { offset: b.finish, date: b.finishDate } : null,
      forecast: { offset: f.finish, date: f.finishDate },
    };
  }

  return structuredClone({
    revision: input.revision,
    kind: input.kind,
    eventId: input.eventId,
    voidId: input.voidId,
    planEditId: input.planEditId ?? null,
    touchedTaskIds: [...input.touchedTaskIds],
    touchedModuleIds: [...input.touchedModuleIds],
    linkedModuleIds: [...(input.linkedModuleIds ?? [])],
    asOf: input.asOf,
    calendar: now,
    baselineDelivery: { offset: base.delivery.finish, date: base.delivery.date },
    forecastDelivery: { offset: schedule.delivery.finish, date: schedule.delivery.date },
    variance,
    stepDays: previous ? tidy(variance - previous.variance) : 0,
    baselineStepDays: previous ? tidy(base.delivery.finish - previous.baselineDelivery.offset) : 0,
    effortImpact: input.effortImpact,
    criticalPath: schedule.criticalPath,
    drivingChain: schedule.drivingChain,
    tasks: schedule.tasks,
    modules,
    milestones,
    engineVersion: ENGINE_VERSION,
  });
}
