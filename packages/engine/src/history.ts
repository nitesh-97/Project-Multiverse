import { WorkCalendar, isISODate } from './calendar';
import { carryForward } from './carry';
import { applyEffects, hasStarted } from './effects';
import type { EffectResult } from './effects';
import { EffectError, PlanError } from './errors';
import { PLAN_EDIT_OPS } from './events';
import type { Effect, Event, LogEntry, PlanEdit, VoidEntry } from './events';
import { schedule } from './schedule';
import type { Schedule } from './schedule';
import { buildSnapshot } from './snapshot';
import type { ForecastSnapshot } from './snapshot';
import type { ISODate, ModuleId, Plan } from './types';

/** What still counts: events that have not been voided, and every plan edit, in recorded order. */
export type ActiveEntry = { kind: 'EVENT'; event: Event } | { kind: 'PLAN'; edit: PlanEdit };

/**
 * Everything needed to continue a project's history. States are immutable values: every function below returns a
 * new state and leaves the one it was given untouched, so earlier forecasts are preserved by construction.
 */
export interface ProjectState {
  /** The plan at the start of the project. Never changes: history is always replayed from here. */
  readonly origin: Plan;
  /** The plan as it stands: the origin plus every plan edit. Variance is measured against this. */
  readonly baseline: Plan;
  readonly baselineSchedule: Schedule;
  /** Current plan: baseline plus all active events, carried forward to `asOf`. */
  readonly plan: Plan;
  readonly schedule: Schedule;
  /** Status date of the latest snapshot; null at the baseline. */
  readonly asOf: ISODate | null;
  readonly activeEntries: readonly ActiveEntry[];
  /** The active events alone, in order. */
  readonly activeEvents: readonly Event[];
  /** The full log in recorded order, including withdrawn events and the voids that withdrew them. */
  readonly log: readonly LogEntry[];
  /** Revision 0 is the baseline; one snapshot follows each log entry. */
  readonly snapshots: readonly ForecastSnapshot[];
}

interface Frame {
  baseline: Plan;
  baselineSchedule: Schedule;
  plan: Plan;
  schedule: Schedule;
  asOf: ISODate | null;
}

interface Step {
  frame: Frame;
  result: EffectResult;
}

const later = (a: ISODate, b: ISODate | null): ISODate => (b !== null && b > a ? b : a);

const entryId = (e: LogEntry): string => (e.kind === 'EVENT' ? e.event.id : e.kind === 'PLAN' ? e.edit.id : e.id);
const eventsOf = (entries: readonly ActiveEntry[]): Event[] => entries.flatMap((e) => (e.kind === 'EVENT' ? [e.event] : []));

/** Starts a project's history at its baseline (revision 0). Throws PlanError if the plan is invalid. */
export function startProject(baseline: Plan): ProjectState {
  const origin = structuredClone(baseline);
  const baselineSchedule = schedule(origin);
  const first = buildSnapshot({
    revision: 0,
    kind: 'BASELINE',
    eventId: null,
    voidId: null,
    touchedTaskIds: [],
    touchedModuleIds: [],
    effortImpact: 0,
    asOf: null,
    plan: origin,
    schedule: baselineSchedule,
    baselineCalendar: origin.calendar,
    baselineSchedule,
    previous: null,
  });
  return {
    origin,
    baseline: origin,
    baselineSchedule,
    plan: origin,
    schedule: baselineSchedule,
    asOf: null,
    activeEntries: [],
    activeEvents: [],
    log: [],
    snapshots: [first],
  };
}

/** Carry the forecast forward to `asOf`, apply an event's `effects` to the plan, and re-forecast. */
function advanceEvent(frame: Frame, effects: readonly Effect[], asOf: ISODate): Step {
  const calendar = new WorkCalendar(frame.plan.calendar);
  const carried = carryForward(frame.plan, frame.schedule, calendar.endOffsetClamped(asOf));
  const result = applyEffects(carried, effects, { asOf });
  return { frame: { ...frame, plan: result.plan, schedule: schedule(result.plan, asOf), asOf }, result };
}

/**
 * Like {@link advanceEvent}, but the edit is planning: it is applied to the baseline as well as the current plan, so
 * the plan moves and the forecast moves with it. It must be valid on both (it can only touch work in the plan, not
 * work an event added), and it is refused for work that has already started.
 */
function advancePlan(frame: Frame, effects: readonly Effect[], asOf: ISODate): Step {
  const calendar = new WorkCalendar(frame.plan.calendar);
  const carried = carryForward(frame.plan, frame.schedule, calendar.endOffsetClamped(asOf));
  // Dependencies, removals and blocks already refuse started work. Re-estimating is allowed for an event (work
  // under way can turn out bigger) but not as planning.
  effects.forEach((effect, i) => {
    if (effect.op !== 'ADJUST_ESTIMATE') return;
    const task = carried.tasks.find((t) => t.id === effect.taskId);
    if (task && hasStarted(task)) {
      throw new EffectError(
        `Effect ${i + 1} (${effect.op}): task ${task.id} has already started; a change to started work is an event, not a planning change`,
      );
    }
  });
  const result = applyEffects(carried, effects, { asOf });
  const baseline = applyEffects(frame.baseline, effects).plan;
  return {
    frame: { baseline, baselineSchedule: schedule(baseline), plan: result.plan, schedule: schedule(result.plan, asOf), asOf },
    result,
  };
}

function stateFrame(state: ProjectState): Frame {
  return { baseline: state.baseline, baselineSchedule: state.baselineSchedule, plan: state.plan, schedule: state.schedule, asOf: state.asOf };
}

/** Modules that still have unfinished work (for any of `teamIds`, or for any team if none are given). */
function modulesWithOpenWork(frame: Frame, teamIds?: readonly string[]): ModuleId[] {
  const modules = new Set<ModuleId>();
  for (const task of frame.plan.tasks) {
    if (teamIds !== undefined && !teamIds.includes(task.teamId)) continue;
    if (frame.schedule.tasks[task.id]?.state !== 'DONE') modules.add(task.moduleId);
  }
  return [...modules];
}

/** Re-throws an engine error with the entry named in the message and its id attached for callers. */
function failure(label: string, id: string, e: unknown): never {
  if (e instanceof EffectError || e instanceof PlanError) throw new EffectError(`${label}: ${e.message}`, id);
  throw e;
}

const idUsed = (state: ProjectState, id: string): boolean => state.log.some((e) => entryId(e) === id);

/**
 * Records `event`: carries the forecast to the event's status date, applies its effects, and appends a snapshot.
 * Throws EffectError (naming the event) if it cannot be applied; the given state is unaffected either way.
 */
export function recordEvent(state: ProjectState, event: Event): ProjectState {
  if (idUsed(state, event.id)) throw new EffectError(`Event ${event.id}: id already used`, event.id);
  if (!isISODate(event.asOf)) throw new EffectError(`Event ${event.id}: invalid asOf "${event.asOf}"`, event.id);

  // Status dates never go backwards. A back-dated event keeps its occurredAt but is forecast as of "now".
  const asOf = later(event.asOf, state.asOf);
  let step: Step;
  try {
    step = advanceEvent(stateFrame(state), event.effects, asOf);
  } catch (e) {
    return failure(`Event ${event.id}`, event.id, e);
  }

  const { frame, result } = step;
  const touchedModuleIds = [
    ...new Set([
      ...result.touchedModuleIds,
      ...(result.touchedTeamIds.length > 0 ? modulesWithOpenWork(frame, result.touchedTeamIds) : []),
      ...(result.calendarChanged ? modulesWithOpenWork(frame) : []),
    ]),
  ];
  const feature = event.linkedFeatureId !== undefined ? frame.plan.features?.find((f) => f.id === event.linkedFeatureId) : undefined;
  const previous = state.snapshots[state.snapshots.length - 1] ?? null;
  const snapshot = buildSnapshot({
    revision: state.snapshots.length,
    kind: 'EVENT',
    eventId: event.id,
    voidId: null,
    touchedTaskIds: result.touchedTaskIds,
    touchedModuleIds,
    linkedModuleIds: feature?.moduleIds ?? [],
    effortImpact: result.effortImpact,
    asOf,
    plan: frame.plan,
    schedule: frame.schedule,
    baselineCalendar: frame.baseline.calendar,
    baselineSchedule: frame.baselineSchedule,
    previous,
  });

  const entry: ActiveEntry = { kind: 'EVENT', event: structuredClone(event) };
  return {
    ...state,
    plan: frame.plan,
    schedule: frame.schedule,
    asOf,
    activeEntries: [...state.activeEntries, entry],
    activeEvents: [...state.activeEvents, entry.event],
    log: [...state.log, entry],
    snapshots: [...state.snapshots, snapshot],
  };
}

/**
 * Records a planning change to modules that have not started: applied to the baseline and the current plan alike,
 * so the plan moves and variance is measured against the refined plan. It is part of history; nothing is rewritten.
 * Only the effects in PLAN_EDIT_OPS are allowed. Anything about actuals, capacity or the calendar is an event.
 */
export function recordPlanEdit(state: ProjectState, edit: PlanEdit): ProjectState {
  if (idUsed(state, edit.id)) throw new EffectError(`Plan edit ${edit.id}: id already used`, edit.id);
  if (!isISODate(edit.asOf)) throw new EffectError(`Plan edit ${edit.id}: invalid asOf "${edit.asOf}"`, edit.id);
  const banned = edit.effects.find((e) => !(PLAN_EDIT_OPS as readonly string[]).includes(e.op));
  if (banned) {
    throw new EffectError(`Plan edit ${edit.id}: ${banned.op} is not a planning change; record it as an event`, edit.id);
  }

  const asOf = later(edit.asOf, state.asOf);
  let step: Step;
  try {
    step = advancePlan(stateFrame(state), edit.effects, asOf);
  } catch (e) {
    return failure(`Plan edit ${edit.id}`, edit.id, e);
  }

  const { frame, result } = step;
  const previous = state.snapshots[state.snapshots.length - 1] ?? null;
  const snapshot = buildSnapshot({
    revision: state.snapshots.length,
    kind: 'PLAN',
    eventId: null,
    voidId: null,
    planEditId: edit.id,
    touchedTaskIds: result.touchedTaskIds,
    touchedModuleIds: result.touchedModuleIds,
    effortImpact: result.effortImpact,
    asOf,
    plan: frame.plan,
    schedule: frame.schedule,
    baselineCalendar: frame.baseline.calendar,
    baselineSchedule: frame.baselineSchedule,
    previous,
  });

  const entry: ActiveEntry = { kind: 'PLAN', edit: structuredClone(edit) };
  return {
    ...state,
    baseline: frame.baseline,
    baselineSchedule: frame.baselineSchedule,
    plan: frame.plan,
    schedule: frame.schedule,
    asOf,
    activeEntries: [...state.activeEntries, entry],
    log: [...state.log, entry],
    snapshots: [...state.snapshots, snapshot],
  };
}

/**
 * Withdraws an earlier event (a correction). The plan is rebuilt from the origin without it, so effects that do
 * not commute are handled, and a VOID snapshot records the change. Fails if a later event relied on it.
 */
export function voidEvent(state: ProjectState, entry: VoidEntry): ProjectState {
  if (idUsed(state, entry.id)) throw new EffectError(`Void ${entry.id}: id already used`);
  const target = state.activeEvents.find((e) => e.id === entry.eventId);
  if (!target) throw new EffectError(`Void ${entry.id}: event ${entry.eventId} does not exist or is already voided`);
  if (!isISODate(entry.asOf)) throw new EffectError(`Void ${entry.id}: invalid asOf "${entry.asOf}"`);

  const remaining = state.activeEntries.filter((e) => !(e.kind === 'EVENT' && e.event.id === target.id));
  const originSchedule = schedule(state.origin);
  let frame: Frame = { baseline: state.origin, baselineSchedule: originSchedule, plan: state.origin, schedule: originSchedule, asOf: null };
  let result: EffectResult | null = null;
  try {
    for (const e of remaining) {
      frame =
        e.kind === 'EVENT'
          ? advanceEvent(frame, e.event.effects, later(e.event.asOf, frame.asOf)).frame
          : advancePlan(frame, e.edit.effects, later(e.edit.asOf, frame.asOf)).frame;
    }
    // Never earlier than the snapshot we are correcting, so status dates stay monotonic.
    const asOf = later(later(entry.asOf, state.asOf), frame.asOf);
    ({ frame, result } = advanceEvent(frame, [], asOf));
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    throw new EffectError(`Cannot void event ${target.id}: a later entry no longer applies without it (${detail})`, target.id);
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
    linkedModuleIds: original?.linkedModuleIds ?? [],
    effortImpact: -(original?.effortImpact ?? 0),
    asOf: frame.asOf,
    plan: frame.plan,
    schedule: frame.schedule,
    baselineCalendar: frame.baseline.calendar,
    baselineSchedule: frame.baselineSchedule,
    previous,
  });

  return {
    ...state,
    baseline: frame.baseline,
    baselineSchedule: frame.baselineSchedule,
    plan: frame.plan,
    schedule: frame.schedule,
    asOf: frame.asOf,
    activeEntries: remaining,
    activeEvents: eventsOf(remaining),
    log: [...state.log, structuredClone(entry)],
    snapshots: [...state.snapshots, snapshot],
  };
}

/** Rebuilds a project's whole history from its baseline and its log. Deterministic. */
export function buildHistory(baseline: Plan, log: readonly LogEntry[]): ProjectState {
  let state = startProject(baseline);
  for (const entry of log) {
    state = entry.kind === 'EVENT' ? recordEvent(state, entry.event) : entry.kind === 'PLAN' ? recordPlanEdit(state, entry.edit) : voidEvent(state, entry);
  }
  return state;
}
