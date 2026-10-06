import { PlanError } from './errors';
import { topologicalOrder } from './graph';
import type { Plan } from './types';

function duplicates(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const id of ids) (seen.has(id) ? dupes : seen).add(id);
  return [...dupes];
}

/** Checks the structure of a plan and throws a single PlanError listing every problem found. */
export function validatePlan(plan: Plan): void {
  const issues: string[] = [];

  for (const [what, ids] of [
    ['team', plan.teams.map((t) => t.id)],
    ['module', plan.modules.map((m) => m.id)],
    ['task', plan.tasks.map((t) => t.id)],
  ] as const) {
    const dupes = duplicates(ids);
    if (dupes.length > 0) issues.push(`Duplicate ${what} ids: ${dupes.join(', ')}`);
  }

  const teamIds = new Set(plan.teams.map((t) => t.id));
  const moduleIds = new Set(plan.modules.map((m) => m.id));
  const taskById = new Map(plan.tasks.map((t) => [t.id, t]));

  for (const t of plan.tasks) {
    if (!moduleIds.has(t.moduleId)) issues.push(`Task ${t.id} refers to unknown module ${t.moduleId}`);
    if (!teamIds.has(t.teamId)) issues.push(`Task ${t.id} refers to unknown team ${t.teamId}`);
    if (!Number.isFinite(t.estimate) || t.estimate < 0) issues.push(`Task ${t.id} has an invalid estimate ${t.estimate}`);
    if (t.kind === 'MILESTONE' && t.estimate !== 0) issues.push(`Milestone ${t.id} must have estimate 0`);
    if (t.progress?.remaining !== undefined && !(t.progress.remaining >= 0)) {
      issues.push(`Task ${t.id} has an invalid remaining effort ${t.progress.remaining}`);
    }
  }

  const edgeKeys: string[] = [];
  let edgesResolvable = true;
  for (const d of plan.dependencies) {
    if (d.type !== 'FS') issues.push(`Dependency ${d.predecessorId} -> ${d.successorId} has unsupported type ${d.type}`);
    if (d.predecessorId === d.successorId) issues.push(`Task ${d.predecessorId} depends on itself`);
    for (const id of [d.predecessorId, d.successorId]) {
      if (!taskById.has(id)) {
        issues.push(`Dependency refers to unknown task ${id}`);
        edgesResolvable = false;
      }
    }
    edgeKeys.push(`${d.predecessorId} -> ${d.successorId}`);
  }
  const dupEdges = duplicates(edgeKeys);
  if (dupEdges.length > 0) issues.push(`Duplicate dependencies: ${dupEdges.join(', ')}`);

  const firstPlanned = new Map<string, { from: string; headcount: number }>();
  for (const c of plan.capacity) {
    if (!teamIds.has(c.teamId)) issues.push(`Capacity refers to unknown team ${c.teamId}`);
    if (!Number.isFinite(c.headcount) || c.headcount < 0) issues.push(`Team ${c.teamId} has an invalid headcount ${c.headcount}`);
    const first = firstPlanned.get(c.teamId);
    if (!first || c.from < first.from) firstPlanned.set(c.teamId, { from: c.from, headcount: c.headcount });
  }
  for (const [teamId, first] of firstPlanned) {
    if (!(first.headcount > 0)) issues.push(`Team ${teamId} must have a planned (earliest) headcount above 0`);
  }

  const delivery = taskById.get(plan.deliveryTaskId);
  if (!delivery) {
    issues.push(`Delivery task ${plan.deliveryTaskId} does not exist`);
  } else {
    if (delivery.kind !== 'MILESTONE') issues.push(`Delivery task ${delivery.id} must be a milestone`);
    if (plan.dependencies.some((d) => d.predecessorId === delivery.id)) {
      issues.push(`Delivery milestone ${delivery.id} must not have successors`);
    }
  }

  if (edgesResolvable) {
    try {
      topologicalOrder(
        plan.tasks.map((t) => t.id),
        plan.dependencies.map((d) => [d.predecessorId, d.successorId] as const),
      );
    } catch (e) {
      if (e instanceof PlanError) issues.push(...e.issues);
      else throw e;
    }
  }

  if (issues.length > 0) throw new PlanError(issues);
}
