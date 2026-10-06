import { WorkCalendar, isISODate } from './calendar';
import { carryForward } from './carry';
import { applyEffects } from './effects';
import type { EffectResult } from './effects';
import { EffectError, PlanError } from './errors';
import type { Effect, Event, LogEntry, VoidEntry } from './events';
import { schedule } from './schedule';
import type { Schedule } from './schedule';
import { buildSnapshot } from './snapshot';
import type { ForecastSnapshot } from './snapshot';
import type { ISODate, ModuleId, Plan } from './types';

/**
 * Everything needed to continue a project's history. States are immutable values: every function below returns a
 * new state and leaves the one it was given untouched, so earlier forecasts are preserved by construction.
 */
export interface ProjectState {
  readonly baseline: Plan;
  readonly baselineSchedule: Schedule;
  /** Current plan: baseline plus all active events, carried forward to `asOf`. */
  readonly plan: Plan;
  readonly schedule: Schedule;
  /** Status date of the latest snapshot; null at the baseline. */
  readonly asOf: ISODate | null;
  readonly activeEvents: readonly Event[];
  /** The full log in recorded order, including withdrawn events and the voids that withdrew them. */
  readonly log: readonly LogEntry[];
  /** Revision 0 is the baseline; one snapshot follows each log entry. */
  readonly snapshots: readonly ForecastSnapshot[];
}

interface Frame {
  plan: Plan;
  schedule: Schedule;
  asOf: ISODate | null;
}

const later = (a: ISODate, b: ISODate | null): ISODate => (b !== null && b > a ? b : a);

/** Starts a project's history at its baseline (revision 0). Throws PlanError if the plan is invalid. */
export function startProject(baseline: Plan): ProjectState {
  const base = structuredClone(baseline);
  const baselineSchedule = schedule(base);
  const first = buildSnapshot({
    revision: 0,
    kind: 'BASELINE',
    eventId: null,
    voidId: null,
    touchedTaskIds: [],
    touchedModuleIds: [],
    effortImpact: 0,
    asOf: null,
    plan: base,
    schedule: baselineSchedule,
    baselineSchedule,
    previous: null,
  });
  return {
    baseline: base,
    baselineSchedule,
    plan: base,
    schedule: baselineSchedule,
    asOf: null,
    activeEvents: [],
    log: [],
    snapshots: [first],
  };
}

/** Carry the forecast forward to `asOf`, apply `effects`, and re-forecast. */
function advance(frame: Frame, effects: readonly Effect[], asOf: ISODate): { frame: Frame; result: EffectResult } {
  const calendar = new WorkCalendar(frame.plan.calendar);
  const carried = carryForward(frame.plan, frame.schedule, calendar.endOffsetClamped(asOf));
  const result = applyEffects(carried, effects);
  return { frame: { plan: result.plan, schedule: schedule(result.plan, asOf), asOf }, result };
}

function stateFrame(state: ProjectState): Frame {
  return { plan: state.plan, schedule: state.schedule, asOf: state.asOf };
}

/** Modules that still have unfinished work for any of `teamIds`: the ones a capacity change touches directly. */
function modulesWithOpenWork(frame: Frame, teamIds: readonly string[]): ModuleId[] {
  if (teamIds.length === 0) return [];
  const modules = new Set<ModuleId>();
  for (const task of frame.plan.tasks) {
    if (teamIds.includes(task.teamId) && frame.schedule.tasks[task.id]?.state !== 'DONE') modules.add(task.moduleId);
  }
  return [...modules];
}

function failure(eventId: string, e: unknown): never {
  if (e instanceof EffectError || e instanceof PlanError) throw new EffectError(`Event ${eventId}: ${e.message}`, eventId);
  throw e;
}

/**
 * Records `event`: carries the forecast to the event's status date, applies its effects, and appends a snapshot.
 * Throws EffectError (naming the event) if it cannot be applied; the given state is unaffected either way.
 */
export function recordEvent(state: ProjectState, event: Event): ProjectState {
  if (state.log.some((e) => (e.kind === 'EVENT' ? e.event.id : e.id) === event.id)) {
    throw new EffectError(`Event ${event.id}: id already used`, event.id);
  }
  if (!isISODate(event.asOf)) throw new EffectError(`Event ${event.id}: invalid asOf "${event.asOf}"`, event.id);

  // Status dates never go backwards. A back-dated event keeps its occurredAt but is forecast as of "now".
  const asOf = later(event.asOf, state.asOf);
  let step: { frame: Frame; result: EffectResult };
  try {
    step = advance(stateFrame(state), event.effects, asOf);
  } catch (e) {
    return failure(event.id, e);
  }

  const { frame, result } = step;
  const touchedModuleIds = [...new Set([...result.touchedModuleIds, ...modulesWithOpenWork(frame, result.touchedTeamIds)])];
  const previous = state.snapshots[state.snapshots.length - 1] ?? null;
  const snapshot = buildSnapshot({
    revision: state.snapshots.length,
    kind: 'EVENT',
    eventId: event.id,
    voidId: null,
    touchedTaskIds: result.touchedTaskIds,
    touchedModuleIds,
    effortImpact: result.effortImpact,
    asOf,
    plan: frame.plan,
    schedule: frame.schedule,
    baselineSchedule: state.baselineSchedule,
    previous,
  });

  return {
    ...state,
    plan: frame.plan,
    schedule: frame.schedule,
    asOf,
    activeEvents: [...state.activeEvents, structuredClone(event)],
    log: [...state.log, { kind: 'EVENT', event: structuredClone(event) }],
    snapshots: [...state.snapshots, snapshot],
  };
}

/**
 * Withdraws an earlier event (a correction). The plan is rebuilt from the baseline without it, so effects that
 * do not commute are handled, and a VOID snapshot records the change. Fails if a later event relied on it.
 */
export function voidEvent(state: ProjectState, entry: VoidEntry): ProjectState {
  if (state.log.some((e) => (e.kind === 'EVENT' ? e.event.id : e.id) === entry.id)) {
    throw new EffectError(`Void ${entry.id}: id already used`);
  }
  const target = state.activeEvents.find((e) => e.id === entry.eventId);
  if (!target) throw new EffectError(`Void ${entry.id}: event ${entry.eventId} does not exist or is already voided`);
  if (!isISODate(entry.asOf)) throw new EffectError(`Void ${entry.id}: invalid asOf "${entry.asOf}"`);

  const remaining = state.activeEvents.filter((e) => e.id !== target.id);
  let frame: Frame = { plan: state.baseline, schedule: state.baselineSchedule, asOf: null };
  let result: EffectResult | null = null;
  try {
    for (const e of remaining) {
      frame = advance(frame, e.effects, later(e.asOf, frame.asOf)).frame;
    }
    // Never earlier than the snapshot we are correcting, so status dates stay monotonic.
    const asOf = later(later(entry.asOf, state.asOf), frame.asOf);
    ({ frame, result } = advance(frame, [], asOf));
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    throw new EffectError(`Cannot void event ${target.id}: a later event no longer applies without it (${detail})`, target.id);
  }

  const original = state.snapshots.find((s) => s.kind === 'EVENT' && s.eventId === target.id);
  const previous = state.snapshots[state.snapshots.length - 1] ?? null;
  const snapshot = buildSnapshot({
    revision: state.snapshots.length,
    kind: 'VOID',
    eventId: target.id,
    voidId: entry.id,
    touchedTaskIds: original?.touchedTaskIds ?? result?.touchedTaskIds ?? [],
    touchedModuleIds: original?.touchedModuleIds ?? result?.touchedModuleIds ?? [],
    effortImpact: -(original?.effortImpact ?? 0),
    asOf: frame.asOf,
    plan: frame.plan,
    schedule: frame.schedule,
    baselineSchedule: state.baselineSchedule,
    previous,
  });

  return {
    ...state,
    plan: frame.plan,
    schedule: frame.schedule,
    asOf: frame.asOf,
    activeEvents: remaining,
    log: [...state.log, structuredClone(entry)],
    snapshots: [...state.snapshots, snapshot],
  };
}

/** Rebuilds a project's whole history from its baseline and its log. Deterministic. */
export function buildHistory(baseline: Plan, log: readonly LogEntry[]): ProjectState {
  let state = startProject(baseline);
  for (const entry of log) {
    state = entry.kind === 'EVENT' ? recordEvent(state, entry.event) : voidEvent(state, entry);
  }
  return state;
}
