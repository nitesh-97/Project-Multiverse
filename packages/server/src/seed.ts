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

export interface SeedOptions {
  /** Modules to leave unlocked, so their plan can still be refined after the project has started. */
  leaveUnlocked?: string[];
}

/**
 * The Thriveni reference project from DESIGN.md §6: seven modules, Mon 5 Oct 2026 to Fri 30 Oct 2026, with every
 * module locked (except any in `leaveUnlocked`) so execution has started and revision 0 (the original plan) exists.
 */
export function seedThriveni(svc: ProjectService, id: string = THRIVENI_ID, options: SeedOptions = {}): void {
  const plan = buildThriveni();
  const unlocked = new Set(options.leaveUnlocked ?? []);
  const unknown = [...unlocked].filter((m) => !plan.modules.some((x) => x.id === m));
  if (unknown.length > 0) {
    throw new Error(`Unknown module(s) to leave unlocked: ${unknown.join(', ')}. Modules are: ${plan.modules.map((m) => m.id).join(', ')}`);
  }
  if (plan.modules.every((m) => unlocked.has(m.id))) throw new Error('At least one module must be locked, or the project never starts');

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
  for (const m of plan.modules) if (!unlocked.has(m.id)) svc.lockModule(id, m.id);
}

/**
 * The extinguisher as the team experienced it: one shared 2-day effort that every module needed, done between the
 * client changes and integration. Because it is built once, outside any module, it also resolves the "common
 * feature without a shared task" advisory.
 */
export const sharedExtinguisherEffects = (): Effect[] => [
  {
    op: 'ADD_TASK',
    task: { id: 'proj.ext', moduleId: 'project', teamId: 'dev', kind: 'TASK', name: 'Extinguisher system', estimate: 2, featureId: 'extinguisher' },
    dependsOn: ['proj.chg.dev'],
    blocks: ['proj.integration'],
  },
];

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
      description: 'Discovered after development started; it should have been planned as a shared feature.',
      phase: 'DEVELOPMENT',
      createdBy: 'demo',
      sourceTeamId: 'lxd',
      affectedTeamId: 'dev',
      linkedFeatureId: 'extinguisher',
      couldHaveBeenEarlier: true,
      occurredAt: '2026-10-14',
      effects: sharedExtinguisherEffects(),
    }),
  );
}
