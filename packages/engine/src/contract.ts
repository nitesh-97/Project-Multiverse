import type { ChangeExplanation } from './explain';
import type { Advisory } from './advisories';
import type { Attribution } from './attribution';
import type { Timeline } from './timeline';
import type { MilestoneDot } from './views';
import type { ControlRoom, ModuleStatus } from './controlroom';
import type { Event, PlanEdit } from './events';
import type { Retro } from './retro';
import type { ForecastSnapshot } from './snapshot';
import type { CapacityPoint, Feature, ISODate, ModuleKind, PhaseModel, Task, Team, WorkDays } from './types';

/**
 * The shapes the HTTP API serves, written down once. The server is checked against them (packages/server/src/
 * contract-check.ts) and the web app is written against them, so a field cannot be renamed on one side only.
 * Types only: nothing here exists at run time.
 */

/** The forecast against the date promised to the client. */
export interface TargetStatus {
  date: ISODate;
  /** Working days to spare (positive) or late (negative) against that date. */
  daysToSpare: WorkDays;
}

/** An engine advisory, or one only the server can raise because it needs to know which modules are locked. */
export interface ProjectAdvisory extends Omit<Advisory, 'rule'> {
  rule: Advisory['rule'] | 'MODULE_STARTED_NOT_LOCKED';
}

export interface ProjectInfo {
  id: string;
  name: string;
  /** The project's own phases: what an event can say it was found in, and how late is "late". */
  phases: PhaseModel;
  startDate: ISODate;
  targetDate: ISODate | null;
  weekendDays: number[];
  holidays: ISODate[];
  deliveryTaskId: string | null;
  /** When the first module was locked; null while the project is still a draft. */
  startedAt: string | null;
}

export interface ModuleInfo {
  id: string;
  name: string;
  kind: ModuleKind;
  /** When execution of the module started; null while its plan can still be refined. */
  lockedAt: string | null;
}

/** A project with everything stored about its blueprint, as GET /projects/:id returns it. */
export interface ProjectDetail {
  project: ProjectInfo;
  started: boolean;
  teams: Team[];
  capacity: CapacityPoint[];
  modules: ModuleInfo[];
  tasks: Task[];
  features: Feature[];
  forecast: { revision: number; variance: number; target: TargetStatus | null } | null;
}

/** An event as stored: the engine's Event plus where it sits in the log and whether it has been withdrawn. */
export interface EventLogItem extends Event {
  seq: number;
  recordedAt: string;
  status: 'ACTIVE' | 'VOIDED';
  voidedBy: string | null;
}

export interface PlanEditLogItem extends PlanEdit {
  seq: number;
  recordedAt: string;
}

/** The control room as the API serves it: the engine's figures plus what only the server knows. */
export interface ControlRoomView extends Omit<ControlRoom, 'modules'> {
  modules: Array<ModuleStatus & { locked: boolean }>;
  /** The forecast against the date promised to the client; null if no client date was set. */
  target: TargetStatus | null;
  contributors: Attribution;
  advisories: ProjectAdvisory[];
}

export interface RetroView extends Retro {
  target: TargetStatus | null;
}

/** One task of the current plan, with where it stands in the forecast. */
export interface CurrentTask {
  id: string;
  name: string;
  moduleId: string;
  teamId: string;
  kind: 'TASK' | 'MILESTONE';
  estimate: number;
  featureId?: string;
  ownerId?: string;
  state: 'DONE' | 'IN_PROGRESS' | 'NOT_STARTED';
  startDate: ISODate;
  finishDate: ISODate;
  remainingEffort: number;
  totalFloat: number;
  critical: boolean;
  /** The forecast takes this task's state on trust: nobody has recorded it. */
  assumed: boolean;
  /** Added after the project started, by an event or a plan edit. */
  added: boolean;
  moduleLocked: boolean;
}

/**
 * The project view: the original plan as one line with a branch for each module that deviated (`Timeline`), and the
 * dots on it. `flaggedTaskIds` are the tasks the project manager flagged as milestones.
 */
export interface ProjectTimelineView extends Timeline {
  milestones: MilestoneDot[];
  flaggedTaskIds: string[];
}

/** The current forecast with its client-date comparison: GET /projects/:id/forecast. */
export type ForecastView = ForecastSnapshot & { target: TargetStatus | null };

/** "What would this do?" for an event: nothing is written. */
export interface EventPreview {
  event: Event;
  explanation: ChangeExplanation;
}

export interface PlanEditPreview {
  planEdit: PlanEdit;
  explanation: ChangeExplanation;
}

/** What recording an event (or withdrawing one) returns. */
export interface RecordedEventView {
  event: EventLogItem;
  snapshot: ForecastSnapshot;
  explanation: ChangeExplanation;
}

export interface RecordedPlanEditView {
  planEdit: PlanEditLogItem;
  snapshot: ForecastSnapshot;
  explanation: ChangeExplanation;
}

/** One snapshot with why it differs from the one before: GET /projects/:id/snapshots/:revision. */
export interface SnapshotView {
  snapshot: ForecastSnapshot;
  explanation: ChangeExplanation | null;
}
