import { buildControlRoom, buildRetro, phaseModelOf, buildThriveni, buildTimeline, recordEvent, recordPlanEdit, startProject, attributeDelay, sequentialStrategy, slackToTarget } from '@multiverse/engine';
import type { ControlRoomView, CurrentTask, Event, ModuleInfo, PhaseModel, PlanEdit, ProjectDetail, ProjectState, RetroView, TargetStatus } from '@multiverse/engine';
import type { FormContext } from '../src/lib/templates';

/**
 * Real engine output shaped the way the API serves it, so the screens are tested against what they will actually get.
 */

export const TARGET_DATE = '2026-10-30';

export const event = (id: string, asOf: string, effects: Event['effects'], extra: Partial<Event> = {}): Event => ({
  id,
  type: 'TASK_DELAY',
  category: 'General',
  title: id,
  description: '',
  phase: 'DEVELOPMENT',
  createdBy: 'tester',
  occurredAt: asOf,
  asOf,
  effects,
  ...extra,
});

export const adjust = (taskId: string, delta: number): Event['effects'][number] => ({ op: 'ADJUST_ESTIMATE', taskId, delta });

/** Everything locked except the modules named. */
export function modulesOf(state: ProjectState, unlocked: readonly string[] = []): ModuleInfo[] {
  return state.origin.modules.map((m) => ({ id: m.id, name: m.name, kind: m.kind, lockedAt: unlocked.includes(m.id) ? null : '2026-10-01T09:00:00.000Z' }));
}

export function currentTasksOf(state: ProjectState, modules: readonly ModuleInfo[]): CurrentTask[] {
  const original = new Set(state.origin.tasks.map((t) => t.id));
  const locked = new Map(modules.map((m) => [m.id, m.lockedAt !== null]));
  return state.plan.tasks.flatMap((t) => {
    const s = state.schedule.tasks[t.id];
    if (!s) return [];
    return [
      {
        id: t.id,
        name: t.name,
        moduleId: t.moduleId,
        teamId: t.teamId,
        kind: t.kind,
        estimate: t.estimate,
        ...(t.featureId !== undefined ? { featureId: t.featureId } : {}),
        state: s.state,
        startDate: s.startDate,
        finishDate: s.finishDate,
        remainingEffort: s.remainingEffort,
        totalFloat: s.totalFloat,
        critical: s.critical,
        assumed: t.progress?.assumed === true,
        added: !original.has(t.id),
        moduleLocked: locked.get(t.moduleId) === true,
      },
    ];
  });
}

export function stateWith(events: readonly Event[] = [], planEdits: readonly PlanEdit[] = [], phases?: PhaseModel): ProjectState {
  let state = startProject(phases ? { ...buildThriveni(), phases } : buildThriveni());
  for (const e of events) state = recordEvent(state, e);
  for (const p of planEdits) state = recordPlanEdit(state, p);
  return state;
}

export function formContext(state: ProjectState, unlocked: readonly string[] = [], today = '2026-10-14'): FormContext {
  const modules = modulesOf(state, unlocked);
  return {
    today,
    tasks: currentTasksOf(state, modules),
    teams: state.plan.teams,
    modules,
    features: state.plan.features ?? [],
    deliveryTaskId: state.plan.deliveryTaskId,
    phases: phaseModelOf(state.plan),
  };
}

export function targetOf(state: ProjectState, date: string | null = TARGET_DATE): TargetStatus | null {
  const last = state.snapshots[state.snapshots.length - 1];
  if (date === null || !last) return null;
  return { date, daysToSpare: slackToTarget(last.calendar ?? state.origin.calendar, last.forecastDelivery.offset, date) };
}

export function controlRoomView(state: ProjectState, unlocked: readonly string[] = [], target: string | null = TARGET_DATE): ControlRoomView {
  const room = buildControlRoom(state);
  return {
    ...room,
    modules: room.modules.map((m) => ({ ...m, locked: !unlocked.includes(m.moduleId) })),
    target: targetOf(state, target),
    contributors: attributeDelay(state, { strategy: sequentialStrategy }),
    advisories: [],
  };
}

export function retroView(state: ProjectState, target: string | null = TARGET_DATE): RetroView {
  return { ...buildRetro(state), target: targetOf(state, target) };
}

export function detailOf(state: ProjectState, unlocked: readonly string[] = [], targetDate: string | null = TARGET_DATE): ProjectDetail {
  return {
    project: {
      id: 'thriveni',
      name: 'Thriveni VR Training',
      startDate: state.origin.calendar.startDate,
      targetDate,
      weekendDays: state.origin.calendar.weekendDays,
      holidays: state.origin.calendar.holidays,
      deliveryTaskId: state.plan.deliveryTaskId,
      phases: phaseModelOf(state.plan),
      startedAt: '2026-10-01T09:00:00.000Z',
    },
    started: true,
    teams: state.plan.teams,
    capacity: state.plan.capacity,
    modules: modulesOf(state, unlocked),
    tasks: state.origin.tasks,
    features: state.plan.features ?? [],
    forecast: { revision: state.snapshots.length - 1, variance: state.snapshots[state.snapshots.length - 1]?.variance ?? 0, target: targetOf(state, targetDate) },
  };
}

export const timelineOf = buildTimeline;
