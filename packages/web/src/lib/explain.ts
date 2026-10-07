import type { ChangeExplanation, ModuleChange } from '@multiverse/engine';
import { formatDate } from './dates';
import { signedDays, workingDays } from './format';

/**
 * Words for a ChangeExplanation. The engine says what changed; this says it the way a project manager would, in the
 * order they would ask: did delivery move, by how much, why, and is anything on the critical path now different.
 */

export interface ChangeSummary {
  /** One sentence: the answer to "did the date move?" */
  headline: string;
  /** Further plain lines, only for things that happened. */
  facts: string[];
}

const EPS = 1e-6;
const names = (ids: readonly string[], lookup: ReadonlyMap<string, string>): string => ids.map((id) => lookup.get(id) ?? id).join(', ');

export function summarizeChange(e: ChangeExplanation, taskNames: ReadonlyMap<string, string> = new Map()): ChangeSummary {
  const moved = Math.abs(e.stepDays) > EPS;
  const facts: string[] = [];
  let headline: string;

  if (e.kind === 'PLAN') {
    headline =
      Math.abs(e.baselineStepDays) > EPS
        ? `The plan itself moves ${signedDays(e.baselineStepDays)}. This is planning, not delay.`
        : 'The plan was refined without moving its end date.';
    if (e.delivery.before !== e.delivery.after) facts.push(`Forecast delivery: ${formatDate(e.delivery.before)} → ${formatDate(e.delivery.after)}.`);
    if (moved) facts.push(`Against the plan, the delay changes by ${signedDays(e.stepDays)}.`);
  } else if (e.kind === 'VOID') {
    headline = moved
      ? `Withdrawing it ${e.stepDays < 0 ? 'brings delivery forward' : 'pushes delivery back'} by ${workingDays(e.stepDays)}.`
      : 'Withdrawing it does not move delivery.';
    if (e.delivery.before !== e.delivery.after) facts.push(`Forecast delivery: ${formatDate(e.delivery.before)} → ${formatDate(e.delivery.after)}.`);
  } else if (moved) {
    headline = `Delivery moves ${e.stepDays > 0 ? 'later' : 'earlier'}, from ${formatDate(e.delivery.before)} to ${formatDate(e.delivery.after)} (${signedDays(e.stepDays)}).`;
  } else if (e.absorbed) {
    headline = 'Delivery does not move: float absorbed the slip.';
  } else {
    headline = 'Delivery does not move.';
  }

  if (Math.abs(e.effortImpact) > EPS) facts.push(`It ${e.effortImpact > 0 ? 'adds' : 'removes'} ${workingDays(e.effortImpact)} of effort.`);

  if (e.criticalPath.changed) {
    const entered = e.criticalPath.entered.length > 0 ? `now critical: ${names(e.criticalPath.entered, taskNames)}` : '';
    const left = e.criticalPath.left.length > 0 ? `no longer critical: ${names(e.criticalPath.left, taskNames)}` : '';
    facts.push(`The critical path changes (${[entered, left].filter(Boolean).join('; ')}).`);
  } else if (e.onCriticalPath && !moved && !e.absorbed) {
    facts.push('It touches work on the critical path.');
  }

  if (e.linkedModuleIds.length > 0) facts.push(`The same feature is used by ${e.linkedModuleIds.length} ${e.linkedModuleIds.length === 1 ? 'module' : 'modules'}, which it may also affect.`);

  return { headline, facts };
}

/** How a module came to move, in a few words. */
export function describeOrigin(change: ModuleChange, moduleNames: ReadonlyMap<string, string>): string {
  if (change.origin === 'DIRECT') return 'Changed directly';
  return change.fromModuleIds.length > 0 ? `Moved because of ${names(change.fromModuleIds, moduleNames)}` : 'Moved by an earlier step';
}
