import { WorkCalendar } from './calendar';
import type { ISODate, ModuleId, Plan, TaskId } from './types';

export type AdvisoryRule = 'COMMON_FEATURE_WITHOUT_SHARED_TASK' | 'UNCONFIRMED_COMPLETION';

/**
 * Advice, never a blocker (spec §11): the decision stays with the project stakeholders. A WARNING asks someone to
 * confirm something the forecast is quietly assuming.
 */
export interface Advisory {
  rule: AdvisoryRule;
  severity: 'ADVISORY' | 'WARNING';
  message: string;
  recommendation: string;
  // COMMON_FEATURE_WITHOUT_SHARED_TASK
  featureId?: string;
  featureName?: string;
  /** The deliverable modules that use the feature, in plan order. */
  moduleIds?: ModuleId[];
  // UNCONFIRMED_COMPLETION
  taskId?: TaskId;
  taskName?: string;
  moduleId?: ModuleId;
  /** When the forecast had the task finishing. */
  forecastFinish?: ISODate;
}

export interface AdvisoryOptions {
  /** A feature used by at least this many modules is "common". Default 2. */
  commonFeatureMinModules?: number;
}

/**
 * - Common feature detection (spec §11). A feature is used by a module if it is listed against it or if one of the
 *   module's tasks implements it. Only deliverable modules count: shared and project-level modules are where shared
 *   work lives, not consumers of it. A feature has a shared implementation if `sharedTaskId` names a task, or if
 *   any task that implements it sits outside the deliverable modules (done once, for everyone).
 * - Unconfirmed completion. Between events the forecast assumes work progressed as planned. A task it has finished
 *   that nobody has confirmed is flagged, so a quietly late task is asked about rather than trusted.
 */
export function findAdvisories(plan: Plan, options: AdvisoryOptions = {}): Advisory[] {
  const minModules = options.commonFeatureMinModules ?? 2;
  const kindOf = new Map(plan.modules.map((m) => [m.id, m.kind]));
  const deliverable = plan.modules.filter((m) => m.kind === 'DELIVERABLE').map((m) => m.id);
  const taskIds = new Set(plan.tasks.map((t) => t.id));
  const advisories: Advisory[] = [];

  for (const feature of plan.features ?? []) {
    const users = new Set<ModuleId>(feature.moduleIds);
    for (const task of plan.tasks) {
      if (task.featureId === feature.id) users.add(task.moduleId);
    }
    const moduleIds = deliverable.filter((m) => users.has(m));
    const hasSharedTask =
      (feature.sharedTaskId !== undefined && taskIds.has(feature.sharedTaskId)) ||
      plan.tasks.some((t) => t.featureId === feature.id && kindOf.get(t.moduleId) !== 'DELIVERABLE');

    if (moduleIds.length >= minModules && !hasSharedTask) {
      advisories.push({
        rule: 'COMMON_FEATURE_WITHOUT_SHARED_TASK',
        severity: 'ADVISORY',
        featureId: feature.id,
        featureName: feature.name,
        moduleIds,
        message: `Common feature detected: ${feature.name} is used by ${moduleIds.length} modules but has no shared implementation task.`,
        recommendation: 'Plan a shared implementation before individual module integration.',
      });
    }
  }

  const calendar = new WorkCalendar(plan.calendar);
  const unconfirmed = plan.tasks
    .filter((t) => t.kind === 'TASK' && t.progress?.assumed === true && t.progress.finishedAt !== undefined)
    .sort((a, b) => (a.progress?.finishedAt ?? 0) - (b.progress?.finishedAt ?? 0) || a.id.localeCompare(b.id));
  for (const task of unconfirmed) {
    const forecastFinish = calendar.dateAtOffset(task.progress?.finishedAt ?? 0);
    advisories.push({
      rule: 'UNCONFIRMED_COMPLETION',
      severity: 'WARNING',
      taskId: task.id,
      taskName: task.name,
      moduleId: task.moduleId,
      forecastFinish,
      message: `Assumed finished: "${task.name}" (${task.id}) was forecast to finish on ${forecastFinish} and nobody has recorded it.`,
      recommendation: 'Record its progress: confirm it is done, or say how much is left.',
    });
  }
  return advisories;
}
