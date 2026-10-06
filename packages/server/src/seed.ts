import { buildThriveni } from '@multiverse/engine';
import type { Effect, Plan } from '@multiverse/engine';
import type { EventInput } from './schemas';
import type { ProjectService } from './service';

export const THRIVENI_ID = 'thriveni';

/** Loads a plan into a project as its blueprint. Teams, capacity, modules, tasks, dependencies and features. */
export function loadBlueprint(svc: ProjectService, projectId: string, plan: Plan) {
  return svc.replaceBlueprint(projectId, {
    deliveryTaskId: plan.deliveryTaskId,
    teams: plan.teams,
    capacity: plan.capacity,
    modules: plan.modules,
    tasks: plan.tasks,
    dependencies: plan.dependencies.map(({ predecessorId, successorId }) => ({ predecessorId, successorId })),
    features: (plan.features ?? []).map((f) => ({ id: f.id, name: f.name, moduleIds: f.moduleIds, ...(f.sharedTaskId !== undefined ? { sharedTaskId: f.sharedTaskId } : {}) })),
  });
}

/**
 * The Thriveni reference project from DESIGN.md §6: seven modules, Mon 5 Oct 2026 to Fri 30 Oct 2026, with every
 * module locked so execution has started and revision 0 (the original plan) exists.
 */
export function seedThriveni(svc: ProjectService, id: string = THRIVENI_ID): void {
  const plan = buildThriveni();
  svc.createProject({
    id,
    name: 'Thriveni VR Training',
    startDate: plan.calendar.startDate,
    targetDate: '2026-10-30',
    weekendDays: plan.calendar.weekendDays,
    holidays: plan.calendar.holidays,
  });
  const validation = loadBlueprint(svc, id, plan);
  if (!validation.valid) throw new Error(`The Thriveni blueprint is invalid: ${validation.issues.join('; ')}`);
  for (const m of plan.modules) svc.lockModule(id, m.id);
}

/** Every module needs a 2-day extinguisher integration between its Dev and Alpha tasks. */
const extinguisherEffects = (): Effect[] =>
  [1, 2, 3, 4, 5, 6, 7].map(
    (n): Effect => ({
      op: 'ADD_TASK',
      task: { id: `m${n}.ext`, moduleId: `m${n}`, teamId: 'dev', kind: 'TASK', name: `m${n} extinguisher integration`, estimate: 2, featureId: 'extinguisher' },
      dependsOn: [`m${n}.dev`],
      blocks: [`m${n}.alpha`],
    }),
  );

const parsed = (e: Omit<EventInput, 'category' | 'description'> & Partial<Pick<EventInput, 'category' | 'description'>>): EventInput =>
  ({ category: 'General', description: '', ...e }) as EventInput;

/**
 * Three events worth exploring: a delay absorbed by float, a critical delay, and the late extinguisher (the
 * spec's first demo, §40). Expected result: delivery moves from Fri 30 Oct to Wed 4 Nov (+3 working days).
 */
export function seedDemoEvents(svc: ProjectService, id: string = THRIVENI_ID): void {
  svc.recordEvent(
    id,
    parsed({
      id: 'demo-m2-dev-slip',
      type: 'TASK_DELAY',
      title: 'M2 development needs 3 more days',
      phase: 'DEVELOPMENT',
      createdBy: 'demo',
      taskId: 'm2.dev',
      occurredAt: '2026-10-13',
      effects: [{ op: 'ADJUST_ESTIMATE', taskId: 'm2.dev', delta: 3 }],
    }),
  );
  svc.recordEvent(
    id,
    parsed({
      id: 'demo-m5-blocked',
      type: 'DEPENDENCY_DELAY',
      title: 'M5 waiting on client assets',
      description: 'Client supplied the M5 assets late; development needs a day more.',
      phase: 'DEVELOPMENT',
      createdBy: 'demo',
      taskId: 'm5.dev',
      occurredAt: '2026-10-14',
      effects: [{ op: 'ADJUST_ESTIMATE', taskId: 'm5.dev', delta: 1 }],
    }),
  );
  svc.recordEvent(
    id,
    parsed({
      id: 'demo-extinguisher',
      type: 'SCOPE_CHANGE',
      title: 'LXD: every module needs the extinguisher interaction',
      description: 'Discovered after development started; it should have been a shared feature.',
      phase: 'DEVELOPMENT',
      createdBy: 'demo',
      sourceTeamId: 'lxd',
      affectedTeamId: 'dev',
      linkedFeatureId: 'extinguisher',
      couldHaveBeenEarlier: true,
      occurredAt: '2026-10-14',
      effects: extinguisherEffects(),
    }),
  );
}
