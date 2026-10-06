import type { CapacityPoint, Effect, Event, EventType, Plan, TaskProgress } from '../src';

/** An event with sensible defaults. `asOf` doubles as occurredAt. */
export function makeEvent(
  id: string,
  asOf: string,
  effects: Effect[],
  extra: Partial<Event> & { type?: EventType } = {},
): Event {
  return {
    id,
    type: 'FEEDBACK',
    category: 'Requirement',
    title: id,
    description: '',
    phase: 'DEVELOPMENT',
    createdBy: 'tester',
    occurredAt: asOf,
    asOf,
    effects,
    ...extra,
  };
}

export const adjust = (taskId: string, delta: number): Effect => ({ op: 'ADJUST_ESTIMATE', taskId, delta });

/** The late-extinguisher event: every Thriveni module gets a 2-day integration task between its Dev and Alpha. */
export function extinguisherEffects(): Effect[] {
  return [1, 2, 3, 4, 5, 6, 7].map((n): Effect => ({
    op: 'ADD_TASK',
    task: { id: `m${n}.ext`, moduleId: `m${n}`, teamId: 'dev', kind: 'TASK', name: `m${n} extinguisher`, estimate: 2 },
    dependsOn: [`m${n}.dev`],
    blocks: [`m${n}.alpha`],
  }));
}

export interface TaskSpec {
  id: string;
  /** Effort in work-days. Defaults to 1. */
  est?: number;
  team?: string;
  progress?: TaskProgress;
  startNoEarlierThan?: string;
}

/**
 * Builds a small plan: one module, teams `dev` and `art`, calendar starting Mon 2026-10-05 (Sat/Sun off).
 * A milestone `end` is added and made the delivery task; it depends on every task that has no successor.
 */
export function makePlan(
  specs: TaskSpec[],
  deps: Array<[string, string]> = [],
  overrides: { capacity?: CapacityPoint[]; holidays?: string[]; weekendDays?: number[]; startDate?: string } = {},
): Plan {
  const hasSuccessor = new Set(deps.map(([from]) => from));
  const sinks = specs.filter((s) => !hasSuccessor.has(s.id)).map((s) => s.id);
  return {
    calendar: {
      startDate: overrides.startDate ?? '2026-10-05',
      weekendDays: overrides.weekendDays ?? [0, 6],
      holidays: overrides.holidays ?? [],
    },
    teams: [
      { id: 'dev', name: 'Dev' },
      { id: 'art', name: 'Art' },
    ],
    capacity: overrides.capacity ?? [],
    modules: [{ id: 'm', name: 'Module', kind: 'DELIVERABLE' }],
    tasks: [
      ...specs.map((s) => ({
        id: s.id,
        moduleId: 'm',
        teamId: s.team ?? 'dev',
        kind: 'TASK' as const,
        name: s.id,
        estimate: s.est ?? 1,
        ...(s.progress ? { progress: s.progress } : {}),
        ...(s.startNoEarlierThan ? { startNoEarlierThan: s.startNoEarlierThan } : {}),
      })),
      { id: 'end', moduleId: 'm', teamId: 'dev', kind: 'MILESTONE' as const, name: 'end', estimate: 0 },
    ],
    dependencies: [...deps, ...sinks.map((id): [string, string] => [id, 'end'])].map(([predecessorId, successorId]) => ({
      predecessorId,
      successorId,
      type: 'FS' as const,
    })),
    deliveryTaskId: 'end',
  };
}
