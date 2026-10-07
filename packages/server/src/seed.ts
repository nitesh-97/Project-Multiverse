import { LEGACY_PHASES, buildCommunityCentre, buildThriveni } from '@multiverse/engine';
import type { Effect, Plan } from '@multiverse/engine';
import type { EventInput } from './schemas';
import type { ProjectService } from './service';

export const THRIVENI_ID = 'thriveni';
export const COMMUNITY_CENTRE_ID = 'centre';

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

/** Creates a project from a plan, starts it by locking its modules, and checks the plan is sound. */
function seedFromPlan(svc: ProjectService, project: { id: string; name: string; targetDate: string; plan: Plan }, options: SeedOptions): void {
  const { id, plan } = project;
  const unlocked = new Set(options.leaveUnlocked ?? []);
  const unknown = [...unlocked].filter((m) => !plan.modules.some((x) => x.id === m));
  if (unknown.length > 0) {
    throw new Error(`Unknown module(s) to leave unlocked: ${unknown.join(', ')}. Modules are: ${plan.modules.map((m) => m.id).join(', ')}`);
  }
  if (plan.modules.every((m) => unlocked.has(m.id))) throw new Error('At least one module must be locked, or the project never starts');

  svc.createProject({
    id,
    name: project.name,
    startDate: plan.calendar.startDate,
    targetDate: project.targetDate,
    weekendDays: plan.calendar.weekendDays,
    holidays: plan.calendar.holidays,
    phases: plan.phases ?? LEGACY_PHASES,
  });
  const validation = loadBlueprint(svc, id, plan);
  if (!validation.valid) throw new Error(`The blueprint for "${project.name}" is invalid: ${validation.issues.join('; ')}`);
  for (const m of plan.modules) if (!unlocked.has(m.id)) svc.lockModule(id, m.id);
}

/**
 * The Thriveni reference project from DESIGN.md §6: seven modules, Mon 5 Oct 2026 to Fri 30 Oct 2026, with every
 * module locked (except any in `leaveUnlocked`) so execution has started and revision 0 (the original plan) exists.
 * Its phases are its own: storyboard, art, development, alpha...
 */
export function seedThriveni(svc: ProjectService, id: string = THRIVENI_ID, options: SeedOptions = {}): void {
  seedFromPlan(svc, { id, name: 'Thriveni VR Training', targetDate: '2026-10-30', plan: { ...buildThriveni(), phases: LEGACY_PHASES } }, options);
}

/**
 * A second sample, and not a VR training: a small community centre built on site, Mon 5 Oct to Wed 18 Nov 2026, with
 * phases of its own (brief, design, construction, inspection, handover). It is here to show the tool is for any kind of
 * project.
 */
export function seedCommunityCentre(svc: ProjectService, id: string = COMMUNITY_CENTRE_ID, options: SeedOptions = {}): void {
  seedFromPlan(svc, { id, name: 'Community centre', targetDate: '2026-11-18', plan: buildCommunityCentre() }, options);
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

/**
 * Three events for the community centre: rain delays the concrete pour (on the critical path), the client asks for a
 * second fire exit (more work than the roof it is built beside), and the inspector leaves a note. Expected result:
 * handover moves from Wed 18 Nov to Mon 23 Nov (+3 working days).
 */
export function seedCommunityCentreEvents(svc: ProjectService, id: string = COMMUNITY_CENTRE_ID): void {
  svc.recordEvent(
    id,
    parsed({
      id: 'demo-rain',
      type: 'TASK_DELAY',
      title: 'Rain delays the concrete pour',
      description: 'Two days lost: the ground was too wet to pour.',
      phase: 'CONSTRUCTION',
      createdBy: 'demo',
      taskId: 'f.concrete',
      occurredAt: '2026-10-14',
      effects: [{ op: 'ADJUST_ESTIMATE', taskId: 'f.concrete', delta: 2 }],
    }),
  );
  svc.recordEvent(
    id,
    parsed({
      id: 'demo-fire-exit',
      type: 'SCOPE_CHANGE',
      title: 'The client wants a second fire exit',
      description: 'Asked for after the foundations were poured; it should have been in the brief.',
      phase: 'CONSTRUCTION',
      createdBy: 'demo',
      couldHaveBeenEarlier: true,
      occurredAt: '2026-10-14',
      effects: [
        {
          op: 'ADD_TASK',
          task: { id: 's.exit', moduleId: 'structure', teamId: 'build', kind: 'TASK', name: 'Fire exit door and frame', estimate: 5 },
          dependsOn: ['s.frame'],
          blocks: ['s.inspect'],
        },
      ],
    }),
  );
  svc.recordEvent(
    id,
    parsed({
      id: 'demo-signage',
      type: 'FEEDBACK',
      title: 'Inspector asks for clearer fire signage',
      phase: 'INSPECTION',
      createdBy: 'demo',
      sourceTeamId: 'inspect',
      occurredAt: '2026-10-14',
      effects: [],
    }),
  );
}

/**
 * Everything the testing guide uses, in one go: Thriveni with its demo events, Thriveni with Module 7 left unstarted (to
 * try planning changes), an untouched Thriveni, and the community centre with its demo events. Returns the project ids.
 */
export function seedDemoProjects(svc: ProjectService): string[] {
  seedThriveni(svc);
  seedDemoEvents(svc);
  seedThriveni(svc, 'draft', { leaveUnlocked: ['m7'] });
  seedThriveni(svc, 'fresh');
  seedCommunityCentre(svc);
  seedCommunityCentreEvents(svc);
  return [THRIVENI_ID, 'draft', 'fresh', COMMUNITY_CENTRE_ID];
}
