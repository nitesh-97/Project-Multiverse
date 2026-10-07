import { EffectError } from './errors';
import { PHASES } from './events';
import type { Event, LogEntry, Phase } from './events';
import { buildHistory } from './history';
import type { ActiveEntry, ProjectState } from './history';
import type { ForecastSnapshot } from './snapshot';
import type { Plan, WorkDays } from './types';
import { tidy } from './util';

// ---------------------------------------------------------------------------------------------------------------
// Strategies: how the project's total delay is divided between events (DESIGN.md §3.7).
// ---------------------------------------------------------------------------------------------------------------

/** One entry's share of the delay, before it has been given a category. */
export interface RawContribution {
  /** The id of the event, or of the plan edit. */
  eventId: string;
  /** Optional: the engine works it out from the id. Strategies can leave it out. */
  kind?: 'EVENT' | 'PLAN';
  /** Working days of schedule variance attributed to the entry. Negative for entries that recovered time. */
  days: WorkDays;
  /** Effort the entry added (+) or removed (-). Reported alongside, because it is not the same thing as days. */
  effortDays: WorkDays;
}

export interface StrategyResult {
  contributions: RawContribution[];
  /**
   * Variance that no single event accounts for (events that overlap on the critical path). The contributions
   * plus this must equal the project's total variance; `attributeDelay` checks it.
   */
  interaction: WorkDays;
}

export interface AttributionInput {
  /** The plan at the start of the project: history is replayed from here. */
  origin: Plan;
  /** The full log in recorded order, including voids. */
  log: readonly LogEntry[];
  /** Where the log leads. */
  state: ProjectState;
}

/** Implement this to try a different way of dividing the delay. */
export interface AttributionStrategy {
  readonly name: string;
  attribute(input: AttributionInput): StrategyResult;
}

const finalSnapshot = (s: ProjectState): ForecastSnapshot => s.snapshots[s.snapshots.length - 1] as ForecastSnapshot;
const idOf = (entry: ActiveEntry): string => (entry.kind === 'EVENT' ? entry.event.id : entry.edit.id);

/**
 * v1. Replays the active entries (events and plan edits) in recorded order; each gets the change in project variance
 * it caused. The steps telescope, so the shares add up exactly to the total with no interaction left over.
 * Simple and auditable. Its weakness is order dependence: when two events overlap on the critical path, the one
 * recorded first takes the credit or blame for the days they share.
 *
 * Plan edits take part because they are steps in the history. A plan edit that lengthens an unstarted module's plan
 * can absorb an earlier slip, and shows as a negative share, so the shares still add up.
 *
 * It replays only the active entries (a voided event is skipped entirely) rather than reading stored snapshots,
 * so voids never distort the shares.
 */
export const sequentialStrategy: AttributionStrategy = {
  name: 'sequential',
  attribute({ origin, state }) {
    const replay = buildHistory(origin, state.activeEntries);
    const contributions = state.activeEntries.map((entry, i): RawContribution => {
      const snapshot = replay.snapshots[i + 1] as ForecastSnapshot;
      return { eventId: idOf(entry), kind: entry.kind, days: snapshot.stepDays, effortDays: snapshot.effortImpact };
    });
    return { contributions, interaction: 0 };
  },
};

/**
 * v2. Removes each entry in turn, replays, and reports how much sooner the project would have finished without it
 * (its marginal contribution). Marginals do not generally add up to the total, because entries that overlap hide
 * each other; the shortfall is reported as `interaction` rather than being handed to whichever came first.
 * If other entries cannot exist without the removed one (they build on its tasks), those are removed with it.
 */
export const counterfactualStrategy: AttributionStrategy = {
  name: 'counterfactual',
  attribute({ origin, state }) {
    const entries = state.activeEntries;
    const full = buildHistory(origin, entries);
    const total = finalSnapshot(full).variance;

    const contributions = entries.map((entry, i): RawContribution => {
      const dropped = new Set([idOf(entry)]);
      let without: ProjectState | null = null;
      while (without === null) {
        try {
          without = buildHistory(origin, entries.filter((e) => !dropped.has(idOf(e))));
        } catch (e) {
          // A later entry that depended on the removed one can no longer be applied: remove it as well.
          if (e instanceof EffectError && e.eventId !== null && !dropped.has(e.eventId)) dropped.add(e.eventId);
          else throw e;
        }
      }
      const snapshot = full.snapshots[i + 1] as ForecastSnapshot;
      return {
        eventId: idOf(entry),
        kind: entry.kind,
        days: tidy(total - finalSnapshot(without).variance),
        effortDays: snapshot.effortImpact,
      };
    });

    return { contributions, interaction: tidy(total - contributions.reduce((sum, c) => sum + c.days, 0)) };
  },
};

// ---------------------------------------------------------------------------------------------------------------
// Categories: how events are grouped into the contributors the retrospective shows (spec §4, §24).
// ---------------------------------------------------------------------------------------------------------------

export const PHASE_ORDER: readonly Phase[] = PHASES;

const atOrAfter = (phase: Phase, from: Phase): boolean => PHASE_ORDER.indexOf(phase) >= PHASE_ORDER.indexOf(from);

/** The first rule that matches wins. Edit or replace this list to change how events are grouped. */
export interface CategoryRule {
  category: string;
  matches(event: Event): boolean;
}

export const UNEXPLAINED = 'Estimation / unexplained variance';
export const FALLBACK_CATEGORY = 'Other';
/** Plan edits (refining a module that had not started) are not events, so they are not classified by rule. */
export const PLANNING = 'Planning changes';

/**
 * v1 rules, using the event's `phase` as the signal for "late". Scope raised once development has started is late
 * discovery; feedback raised after development has finished is late feedback.
 */
export const DEFAULT_CATEGORY_RULES: readonly CategoryRule[] = [
  { category: 'Late scope discovery', matches: (e) => (e.type === 'SCOPE_CHANGE' || e.type === 'REQUIREMENT_CHANGE') && atOrAfter(e.phase, 'DEVELOPMENT') },
  { category: 'Scope changes', matches: (e) => e.type === 'SCOPE_CHANGE' || e.type === 'REQUIREMENT_CHANGE' },
  { category: 'Late feedback', matches: (e) => e.type === 'FEEDBACK' && atOrAfter(e.phase, 'INTERNAL_REVIEW') },
  { category: 'Feedback', matches: (e) => e.type === 'FEEDBACK' },
  { category: 'Client feedback', matches: (e) => e.type === 'CLIENT_FEEDBACK' },
  { category: 'Capacity changes', matches: (e) => e.type === 'RESOURCE_CHANGE' || e.type === 'OWNERSHIP_TRANSFER' },
  { category: 'Dependency delays', matches: (e) => e.type === 'BLOCKER' || e.type === 'DEPENDENCY_DELAY' },
  { category: 'Rework', matches: (e) => e.type === 'REWORK' || e.type === 'DEFECT' },
  { category: 'Technical decisions', matches: (e) => e.type === 'TECHNICAL_DECISION' },
  { category: 'Milestone changes', matches: (e) => e.type === 'MILESTONE_CHANGE' },
  { category: UNEXPLAINED, matches: (e) => e.type === 'TASK_DELAY' || e.type === 'TASK_COMPLETION' },
];

/**
 * A task that slipped for a reason already on record is not "unexplained": a TASK_DELAY that names a parent event
 * takes the parent's category. Without this the contributors would overstate plain estimation error.
 */
export function categorizeEvent(
  event: Event,
  events: readonly Event[],
  rules: readonly CategoryRule[] = DEFAULT_CATEGORY_RULES,
): string {
  const byId = new Map(events.map((e) => [e.id, e]));
  const seen = new Set<string>();
  let current: Event = event;
  while (current.type === 'TASK_DELAY' && current.parentEventId !== undefined && !seen.has(current.id)) {
    seen.add(current.id);
    const parent = byId.get(current.parentEventId);
    if (!parent) break;
    current = parent;
  }
  return rules.find((r) => r.matches(current))?.category ?? FALLBACK_CATEGORY;
}

// ---------------------------------------------------------------------------------------------------------------
// The result
// ---------------------------------------------------------------------------------------------------------------

export interface Contribution extends Omit<RawContribution, 'kind'> {
  kind: 'EVENT' | 'PLAN';
  category: string;
}

export interface CategoryTotal {
  category: string;
  days: WorkDays;
  effortDays: WorkDays;
  eventIds: string[];
}

export interface Attribution {
  strategy: string;
  /** Final delivery variance from the baseline, in working days. */
  totalVariance: WorkDays;
  contributions: Contribution[];
  /** Days no single event accounts for (see StrategyResult). 0 for the sequential strategy. */
  interaction: WorkDays;
  /** Largest delay first. Does not include `interaction`. */
  byCategory: CategoryTotal[];
}

export interface AttributionOptions {
  strategy?: AttributionStrategy;
  rules?: readonly CategoryRule[];
}

/**
 * Divides the project's delay between its events and plan edits. Throws if the strategy's numbers do not add up to
 * the total variance, so a strategy under development cannot silently lose or invent days.
 */
export function attributeDelay(state: ProjectState, options: AttributionOptions = {}): Attribution {
  const strategy = options.strategy ?? sequentialStrategy;
  const rules = options.rules ?? DEFAULT_CATEGORY_RULES;
  const totalVariance = finalSnapshot(state).variance;

  const { contributions: raw, interaction } = strategy.attribute({ origin: state.origin, log: state.log, state });

  const attributed = raw.reduce((sum, c) => sum + c.days, 0) + interaction;
  if (Math.abs(attributed - totalVariance) > 1e-6) {
    throw new Error(
      `Attribution strategy "${strategy.name}" does not reconcile: contributions plus interaction are ${tidy(attributed)} days but the project variance is ${totalVariance}`,
    );
  }

  const events = state.activeEvents;
  const byId = new Map(events.map((e) => [e.id, e]));
  const planEditIds = new Set(state.activeEntries.flatMap((e) => (e.kind === 'PLAN' ? [e.edit.id] : [])));
  const contributions = raw.map((c): Contribution => {
    if (planEditIds.has(c.eventId)) return { ...c, kind: 'PLAN', category: PLANNING };
    const event = byId.get(c.eventId);
    return { ...c, kind: 'EVENT', category: event ? categorizeEvent(event, events, rules) : FALLBACK_CATEGORY };
  });

  const totals = new Map<string, CategoryTotal>();
  for (const c of contributions) {
    const t = totals.get(c.category) ?? { category: c.category, days: 0, effortDays: 0, eventIds: [] };
    t.days = tidy(t.days + c.days);
    t.effortDays = tidy(t.effortDays + c.effortDays);
    t.eventIds.push(c.eventId);
    totals.set(c.category, t);
  }
  const byCategory = [...totals.values()].sort((a, b) => b.days - a.days || a.category.localeCompare(b.category));

  return { strategy: strategy.name, totalVariance, contributions, interaction: tidy(interaction), byCategory };
}
