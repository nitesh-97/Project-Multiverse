import { attributeDelay, counterfactualStrategy, sequentialStrategy } from './attribution';
import type { Attribution } from './attribution';
import { phaseIndex, phaseModelOf } from './events';
import type { Event, Phase } from './events';
import type { ProjectState } from './history';
import type { DatedOffset } from './snapshot';
import type { ISODate, ModuleId, PhaseModel, TaskId, TeamId, WorkDays } from './types';
import { tidy } from './util';


export interface PhaseShare {
  phase: Phase;
  count: number;
  percent: number;
}

export interface FeedbackStats {
  /** Events of type FEEDBACK or CLIENT_FEEDBACK. */
  total: number;
  /** Where each was discovered, in project order, phases with none left out (spec §23). */
  byPhase: PhaseShare[];
  /** Discovered once development had finished: the figure the spec wants ("28% of LXD feedback came after development"). */
  afterDevelopment: { count: number; percent: number };
  bySourceTeam: Array<{ teamId: TeamId | null; total: number; afterDevelopmentPercent: number }>;
}

export interface Retro {
  /** The project is DELIVERED once the delivery milestone has been reached; until then every figure is a forecast. */
  status: 'IN_PROGRESS' | 'DELIVERED';
  asOf: ISODate | null;
  planned: { delivery: DatedOffset; workingDays: WorkDays };
  /** The forecast, or the actual once delivered. */
  outcome: { delivery: DatedOffset; workingDays: WorkDays; variance: WorkDays };
  /** Both ways of dividing the delay, side by side. */
  contributors: { sequential: Attribution; counterfactual: Attribution };
  feedback: FeedbackStats;
  scope: { changes: number; afterDevelopmentStarted: number; effortDays: WorkDays; scheduleDays: WorkDays };
  resources: { changes: number; scheduleDays: WorkDays };
  rework: { count: number; effortDays: WorkDays; scheduleDays: WorkDays };
  dependencies: { count: number; scheduleDays: WorkDays };
  planning: { edits: number; planMovedDays: WorkDays };
  /** Events someone marked as things that could have been identified earlier. */
  couldHaveBeenEarlier: { flagged: number; of: number };
  ownership: {
    transfers: Array<{ eventId: string; asOf: ISODate; taskId: TaskId; moduleId: ModuleId | null; toPersonId: string; contextCost: WorkDays }>;
    tasksTransferred: number;
  };
  /** Plain-language findings (spec §24), only for things that actually happened. */
  observations: string[];
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
/** "+1 working day", "-2 working days", "0 working days". */
const signedDays = (n: number): string => `${n > 0 ? '+' : ''}${n} working ${Math.abs(n) === 1 ? 'day' : 'days'}`;

function feedbackStats(events: readonly Event[], model: PhaseModel): FeedbackStats {
  const feedback = events.filter((e) => e.type === 'FEEDBACK' || e.type === 'CLIENT_FEEDBACK');
  const share = (n: number, of: number): number => (of === 0 ? 0 : Math.round((n / of) * 1000) / 10);
  const after = (e: Event): boolean => phaseIndex(model, e.phase) >= phaseIndex(model, model.afterBuild);

  const byPhase = model.phases.map((p) => ({ phase: p.id, count: feedback.filter((e) => e.phase === p.id).length }))
    .filter((p) => p.count > 0)
    .map((p) => ({ ...p, percent: share(p.count, feedback.length) }));

  const teams = [...new Set(feedback.map((e) => e.sourceTeamId ?? null))];
  return {
    total: feedback.length,
    byPhase,
    afterDevelopment: { count: feedback.filter(after).length, percent: share(feedback.filter(after).length, feedback.length) },
    bySourceTeam: teams.map((teamId) => {
      const mine = feedback.filter((e) => (e.sourceTeamId ?? null) === teamId);
      return { teamId, total: mine.length, afterDevelopmentPercent: share(mine.filter(after).length, mine.length) };
    }),
  };
}

/**
 * The evidence-based retrospective (spec §24): planned against actual, who or what the delay came from, when feedback
 * arrived, and what the project learned. Pure: derived from the log, so it can be read at any point and is exact once
 * the project has been delivered. Nothing here ranks people; ownership is a history, not a score (spec §5.2).
 */
export function buildRetro(state: ProjectState): Retro {
  const first = state.snapshots[0];
  const last = state.snapshots[state.snapshots.length - 1];
  if (!first || !last) throw new Error('A project state always has at least its baseline snapshot');

  const sequential = attributeDelay(state, { strategy: sequentialStrategy });
  const counterfactual = attributeDelay(state, { strategy: counterfactualStrategy });
  const daysOf = new Map(sequential.contributions.map((c) => [c.eventId, c.days]));
  const events = state.activeEvents;
  const phases = phaseModelOf(state.plan);
  const days = (list: readonly Event[]): WorkDays => tidy(list.reduce((sum, e) => sum + (daysOf.get(e.id) ?? 0), 0));
  const effort = (list: readonly Event[]): WorkDays =>
    tidy(sequential.contributions.filter((c) => list.some((e) => e.id === c.eventId)).reduce((sum, c) => sum + c.effortDays, 0));

  const ofType = (...types: Event['type'][]): Event[] => events.filter((e) => types.includes(e.type));
  const scopeEvents = ofType('SCOPE_CHANGE', 'REQUIREMENT_CHANGE');
  const scopeLate = scopeEvents.filter((e) => phaseIndex(phases, e.phase) >= phaseIndex(phases, phases.buildStarts));
  const resource = ofType('RESOURCE_CHANGE');
  const rework = ofType('REWORK', 'DEFECT');
  const dependency = ofType('BLOCKER', 'DEPENDENCY_DELAY');
  const feedback = feedbackStats(events, phases);

  const planEdits = state.activeEntries.flatMap((e) => (e.kind === 'PLAN' ? [e.edit] : []));
  // Only plan edits move the baseline, so the net movement of the planned delivery is the sum of their steps.
  const planMoved = tidy(last.baselineDelivery.offset - first.baselineDelivery.offset);

  const moduleOf = new Map(state.plan.tasks.map((t) => [t.id, t.moduleId]));
  const transfers = events.flatMap((e) =>
    e.effects.flatMap((fx) =>
      fx.op === 'TRANSFER_OWNER'
        ? [{ eventId: e.id, asOf: e.asOf, taskId: fx.taskId, moduleId: moduleOf.get(fx.taskId) ?? null, toPersonId: fx.toPersonId, contextCost: fx.contextCost ?? 0 }]
        : [],
    ),
  );

  const flagged = events.filter((e) => e.couldHaveBeenEarlier === true).length;
  const delivered = state.schedule.tasks[state.plan.deliveryTaskId]?.state === 'DONE';

  const observations: string[] = [];
  if (scopeLate.length > 0) observations.push(`${plural(scopeLate.length, 'requirement')} discovered after development had started`);
  if (feedback.total > 0 && feedback.afterDevelopment.count > 0) {
    observations.push(`${feedback.afterDevelopment.percent}% of feedback (${feedback.afterDevelopment.count} of ${feedback.total}) arrived after development had finished`);
  }
  if (flagged > 0) observations.push(`${flagged} of ${plural(events.length, 'event')} could have been identified earlier`);
  if (resource.length > 0) observations.push(`${plural(resource.length, 'capacity or calendar change')} moved delivery by ${signedDays(days(resource))}`);
  if (rework.length > 0) observations.push(`${plural(rework.length, 'rework or defect event')} added ${effort(rework)} work-days of effort`);
  if (new Set(transfers.map((t) => t.taskId)).size > 0) {
    observations.push(`${plural(new Set(transfers.map((t) => t.taskId)).size, 'task')} transferred between people`);
  }
  if (planEdits.length > 0) {
    observations.push(`${plural(planEdits.length, 'planning change')} moved the plan by ${signedDays(planMoved)} (planning, not delay)`);
  }
  const biggest = [...sequential.byCategory].sort((a, b) => b.days - a.days)[0];
  if (biggest && biggest.days > 0) observations.push(`The largest contributor to delay was ${biggest.category} (${signedDays(biggest.days)})`);
  const lateFeatures = (state.plan.features ?? []).filter((f) => scopeLate.some((e) => e.linkedFeatureId === f.id));
  if (lateFeatures.length > 0) {
    observations.push(`${plural(lateFeatures.length, 'common feature')} (${lateFeatures.map((f) => f.name).join(', ')}) identified only after development had started`);
  }

  return {
    status: delivered ? 'DELIVERED' : 'IN_PROGRESS',
    asOf: last.asOf,
    planned: { delivery: first.baselineDelivery, workingDays: first.baselineDelivery.offset },
    outcome: { delivery: last.forecastDelivery, workingDays: last.forecastDelivery.offset, variance: last.variance },
    contributors: { sequential, counterfactual },
    feedback,
    scope: { changes: scopeEvents.length, afterDevelopmentStarted: scopeLate.length, effortDays: effort(scopeEvents), scheduleDays: days(scopeEvents) },
    resources: { changes: resource.length, scheduleDays: days(resource) },
    rework: { count: rework.length, effortDays: effort(rework), scheduleDays: days(rework) },
    dependencies: { count: dependency.length, scheduleDays: days(dependency) },
    planning: { edits: planEdits.length, planMovedDays: planMoved },
    couldHaveBeenEarlier: { flagged, of: events.length },
    ownership: { transfers, tasksTransferred: new Set(transfers.map((t) => t.taskId)).size },
    observations,
  };
}
