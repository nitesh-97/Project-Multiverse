import type { ISODate, ModuleId, Task, TaskId, TeamId, WorkDays } from './types';

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

/** In project order: a later phase means the work it concerns is further along. */
export const PHASES = [
  'PLANNING',
  'STORYBOARD',
  'ART',
  'DEVELOPMENT',
  'INTERNAL_REVIEW',
  'ALPHA',
  'CLIENT_REVIEW',
  'QA',
  'BETA',
  'POST_DELIVERY',
] as const;
export type Phase = (typeof PHASES)[number];

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
  | { op: 'TRANSFER_OWNER'; taskId: TaskId; toPersonId: PersonId; contextCost?: WorkDays };

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
export type LogEntry = { kind: 'EVENT'; event: Event } | VoidEntry;
