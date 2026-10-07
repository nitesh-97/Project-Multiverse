import type { ISODate, ModuleId, PhaseModel, Task, TaskId, TeamId, WorkDays } from './types';

export type PersonId = string;

export const EVENT_TYPES = [
  'FEEDBACK',
  'SCOPE_CHANGE',
  'REQUIREMENT_CHANGE',
  'BLOCKER',
  'DEPENDENCY_DELAY',
  'RESOURCE_CHANGE',
  'REWORK',
  'DEFECT',
  'TECHNICAL_DECISION',
  'OWNERSHIP_TRANSFER',
  'CLIENT_FEEDBACK',
  'TASK_DELAY',
  'TASK_COMPLETION',
  'MILESTONE_CHANGE',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/** A phase id. The ones that exist are the project's own (`Plan.phases`); later in the list means further along. */
export type Phase = string;

/**
 * The phases of the Thriveni project, and what any project that never chose its own is taken to have, so data recorded
 * before phases became the project's own keeps its meaning.
 */
export const LEGACY_PHASES: PhaseModel = {
  phases: [
    { id: 'PLANNING', name: 'Planning' },
    { id: 'STORYBOARD', name: 'Storyboard' },
    { id: 'ART', name: 'Art' },
    { id: 'DEVELOPMENT', name: 'Development' },
    { id: 'INTERNAL_REVIEW', name: 'Internal review' },
    { id: 'ALPHA', name: 'Alpha' },
    { id: 'CLIENT_REVIEW', name: 'Client review' },
    { id: 'QA', name: 'QA' },
    { id: 'BETA', name: 'Beta' },
    { id: 'POST_DELIVERY', name: 'After delivery' },
  ],
  buildStarts: 'DEVELOPMENT',
  afterBuild: 'INTERNAL_REVIEW',
};

/** A starting point for a new project of any kind. Rename, add and remove to suit. */
export const DEFAULT_PHASES: PhaseModel = {
  phases: [
    { id: 'PLANNING', name: 'Planning' },
    { id: 'DESIGN', name: 'Design' },
    { id: 'BUILD', name: 'Build' },
    { id: 'REVIEW', name: 'Review' },
    { id: 'ACCEPTANCE', name: 'Client acceptance' },
    { id: 'TESTING', name: 'Testing' },
    { id: 'RELEASE', name: 'Release' },
    { id: 'AFTER_DELIVERY', name: 'After delivery' },
  ],
  buildStarts: 'BUILD',
  afterBuild: 'REVIEW',
};

/** The phases a plan uses. */
export const phaseModelOf = (plan: { phases?: PhaseModel | undefined }): PhaseModel => plan.phases ?? LEGACY_PHASES;

/** Where a phase sits in the order, or -1 if the project has no such phase. */
export const phaseIndex = (model: PhaseModel, id: Phase): number => model.phases.findIndex((p) => p.id === id);

/** Every problem with a phase model, so a person can fix them all at once. Empty means it is usable. */
export function validatePhaseModel(model: PhaseModel): string[] {
  const issues: string[] = [];
  const ids = model.phases.map((p) => p.id);
  if (model.phases.length < 2) issues.push('A project needs at least two phases');
  for (const p of model.phases) {
    if (p.id.trim() === '' || /s/.test(p.id)) issues.push(`Phase id "${p.id}" must not be empty or contain spaces`);
    if (p.name.trim() === '') issues.push(`Phase ${p.id} needs a name`);
  }
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dupes.length > 0) issues.push(`Duplicate phase ids: ${[...new Set(dupes)].join(', ')}`);
  const start = ids.indexOf(model.buildStarts);
  const after = ids.indexOf(model.afterBuild);
  if (start < 0) issues.push(`The phase where building starts ("${model.buildStarts}") is not one of the phases`);
  if (after < 0) issues.push(`The first phase after building ("${model.afterBuild}") is not one of the phases`);
  if (start >= 0 && after >= 0 && after <= start) issues.push('The first phase after building must come after the phase where building starts');
  return issues;
}

/** A new task as given to ADD_TASK. New work cannot arrive with progress. */
export type TaskDef = Omit<Task, 'progress'>;

/**
 * A typed change an event makes to the plan (DESIGN.md §2.2). Rules shared by all effects:
 * work that has already started cannot be made to wait for something new, finished work cannot be re-estimated
 * (add a rework task), and the resulting plan must still be valid (no cycles, no dangling references).
 */
export type Effect =
  /** New scope, rework or a new shared feature. Costs the task's estimate in effort. */
  | { op: 'ADD_TASK'; task: TaskDef; dependsOn: TaskId[]; blocks: TaskId[] }
  /** Changes a task's estimate by `delta` (negative allowed). On a started task it changes the remaining effort too. */
  | { op: 'ADJUST_ESTIMATE'; taskId: TaskId; delta: WorkDays }
  /** Scope removed. Removes the task and reconnects its predecessors to its successors. Not allowed once started. */
  | { op: 'REMOVE_TASK'; taskId: TaskId }
  | { op: 'ADD_DEPENDENCY'; predecessorId: TaskId; successorId: TaskId }
  | { op: 'REMOVE_DEPENDENCY'; predecessorId: TaskId; successorId: TaskId }
  /** Sets the task's earliest start to `date`; `null` clears it. This replaces any earlier constraint. */
  | { op: 'BLOCK_UNTIL'; taskId: TaskId; date: ISODate | null }
  /** From `from`, the team has `headcount` people. `from` must be after the team's planned-headcount date. */
  | { op: 'SET_CAPACITY'; teamId: TeamId; from: ISODate; headcount: number }
  /** Records actuals. Fields left undefined are kept; `null` clears a field. Recording `finishedOn` clears `remaining`. */
  | { op: 'RECORD_PROGRESS'; taskId: TaskId; startedOn?: ISODate | null; remaining?: WorkDays | null; finishedOn?: ISODate | null }
  /** Changes the owner. `contextCost` is extra effort the new owner needs to get up to speed. */
  | { op: 'TRANSFER_OWNER'; taskId: TaskId; toPersonId: PersonId; contextCost?: WorkDays }
  /** A day nobody works (a public holiday). Must be after the status date and not already a non-working day. */
  | { op: 'ADD_HOLIDAY'; date: ISODate };

/** The effects a planning change to a module that has not started may use. Calendar, capacity and actuals are events. */
export const PLAN_EDIT_OPS = [
  'ADD_TASK',
  'ADJUST_ESTIMATE',
  'REMOVE_TASK',
  'ADD_DEPENDENCY',
  'REMOVE_DEPENDENCY',
  'BLOCK_UNTIL',
] as const;
export type PlanEditEffect = Extract<Effect, { op: (typeof PLAN_EDIT_OPS)[number] }>;

/**
 * A change to the plan of a module that has not started yet, made after the project started. It is recorded in the
 * log like an event, so history shows what changed, when, and why. Unlike an event it moves the *baseline* as well as
 * the forecast, because it is planning, not slippage.
 */
export interface PlanEdit {
  id: string;
  title: string;
  reason?: string;
  createdBy: string;
  /** Status date (end of that working day) for the forecast this edit triggers. Clamped to never go backwards. */
  asOf: ISODate;
  effects: PlanEditEffect[];
}

/**
 * Spec §7. `projectId` and `recordedAt` are persistence concerns and live on the stored row, not here.
 */
export interface Event {
  id: string;
  type: EventType;
  category: string;
  title: string;
  description: string;
  phase: Phase;
  moduleId?: ModuleId;
  taskId?: TaskId;
  createdBy: string;
  sourceTeamId?: TeamId;
  affectedTeamId?: TeamId;
  affectedOwnerId?: PersonId;
  /** When it happened in the real world. */
  occurredAt: ISODate;
  /** Status date (end of that working day) for the forecast this event triggers. Clamped to never go backwards. */
  asOf: ISODate;
  couldHaveBeenEarlier?: boolean;
  estimatedEffortImpact?: WorkDays;
  estimatedScheduleImpact?: WorkDays;
  actualEffortImpact?: WorkDays;
  actualScheduleImpact?: WorkDays;
  parentEventId?: string;
  linkedRequirementId?: string;
  linkedFeatureId?: string;
  effects: Effect[];
}

/** Withdraws an earlier event. The event stays in the log; replay skips it from then on. */
export interface VoidEntry {
  kind: 'VOID';
  id: string;
  eventId: string;
  asOf: ISODate;
  reason?: string;
}

/** The project log in recorded order. */
export type LogEntry = { kind: 'EVENT'; event: Event } | { kind: 'PLAN'; edit: PlanEdit } | VoidEntry;
