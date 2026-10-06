import type { ModuleId, Plan } from './types';

export type AdvisoryRule = 'COMMON_FEATURE_WITHOUT_SHARED_TASK';

/** Advice, never a blocker (spec §11): the decision stays with the project stakeholders. */
export interface Advisory {
  rule: AdvisoryRule;
  severity: 'ADVISORY';
  featureId: string;
  featureName: string;
  /** The deliverable modules that use the feature, in plan order. */
  moduleIds: ModuleId[];
  message: string;
  recommendation: string;
}

export interface AdvisoryOptions {
  /** A feature used by at least this many modules is "common". Default 2. */
  commonFeatureMinModules?: number;
}

/**
 * Common feature detection (spec §11). A feature is used by a module if it is listed against it or if one of the
 * module's tasks implements it. Only deliverable modules count: shared and project-level modules are where shared
 * work lives, not consumers of it.
 */
export function findAdvisories(plan: Plan, options: AdvisoryOptions = {}): Advisory[] {
  const minModules = options.commonFeatureMinModules ?? 2;
  const deliverable = plan.modules.filter((m) => m.kind === 'DELIVERABLE').map((m) => m.id);
  const taskIds = new Set(plan.tasks.map((t) => t.id));
  const advisories: Advisory[] = [];

  for (const feature of plan.features ?? []) {
    const users = new Set<ModuleId>(feature.moduleIds);
    for (const task of plan.tasks) {
      if (task.featureId === feature.id) users.add(task.moduleId);
    }
    const moduleIds = deliverable.filter((m) => users.has(m));
    const hasSharedTask = feature.sharedTaskId !== undefined && taskIds.has(feature.sharedTaskId);

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
  return advisories;
}
