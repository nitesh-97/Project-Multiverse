/** Calendar date, `YYYY-MM-DD`. The engine never uses timezones. */
export type ISODate = string;
/** Working days; fractional values are allowed (1.5). */
export type WorkDays = number;

export type TaskId = string;
export type ModuleId = string;
export type TeamId = string;

export type ModuleKind = 'DELIVERABLE' | 'SHARED' | 'PROJECT';
export type TaskKind = 'TASK' | 'MILESTONE';

export interface CalendarSpec {
  /** Day 1 is the first working day on or after this date. */
  startDate: ISODate;
  /** Days of the week that are not working days. 0 = Sunday ... 6 = Saturday. */
  weekendDays: number[];
  holidays: ISODate[];
}

export interface Team {
  id: TeamId;
  name: string;
}

/**
 * Headcount of a team from a given date. A team's first point (by date) is its
 * planned headcount and applies from the start of the project. Capacity factor =
 * headcount / planned headcount. A team with no points always has factor 1.
 */
export interface CapacityPoint {
  teamId: TeamId;
  from: ISODate;
  headcount: number;
}

export interface Module {
  id: ModuleId;
  name: string;
  kind: ModuleKind;
}

/**
 * Actuals for a task. `startedOn` / `finishedOn` are what a person records and follow the day conventions in
 * DESIGN.md §3.1. `startedAt` / `finishedAt` are exact working-day offsets written by the engine when it carries a
 * forecast forward (DESIGN.md §3.2); when present they take precedence over the dates.
 */
export interface TaskProgress {
  startedOn?: ISODate;
  startedAt?: number;
  /** Effort still to do as of the status date, in work-days at planned capacity. Defaults to the full estimate. */
  remaining?: WorkDays;
  finishedOn?: ISODate;
  finishedAt?: number;
  /**
   * Set by the engine when carrying a forecast forward put the task in this state without anyone recording it.
   * Recording progress for the task clears it. A finished task that is still `assumed` is an unconfirmed completion.
   */
  assumed?: boolean;
}

export interface Task {
  id: TaskId;
  moduleId: ModuleId;
  teamId: TeamId;
  kind: TaskKind;
  name: string;
  /** Effort in work-days at planned capacity. Must be 0 for milestones. */
  estimate: WorkDays;
  /** Earliest date work may start (start of that day). */
  startNoEarlierThan?: ISODate;
  /** Current owner; informational only, the schedule does not use it. */
  ownerId?: string;
  /** The feature this task implements or integrates, if any. */
  featureId?: string;
  progress?: TaskProgress;
}

/**
 * A capability that modules use (extinguisher, localization, evaluation, menu UI). A feature used by several
 * modules is a candidate for one shared implementation, which `sharedTaskId` names once it has been planned.
 */
export interface Feature {
  id: string;
  name: string;
  moduleIds: ModuleId[];
  sharedTaskId?: TaskId;
}

/** Finish-to-start only for the MVP. */
export interface Dependency {
  predecessorId: TaskId;
  successorId: TaskId;
  type: 'FS';
}

/** One phase of a project, as it appears on an event ("found while in Testing"). */
export interface PhaseDef {
  id: string;
  name: string;
}

/**
 * The phases a project goes through, in order, and the two that the retrospective needs to know about. Every kind of
 * project has its own: a game, a building and a research study do not share them.
 */
export interface PhaseModel {
  phases: PhaseDef[];
  /** The phase in which building starts. Scope found from here on is late discovery. */
  buildStarts: string;
  /** The first phase after building has finished. Feedback from here on arrived after development. */
  afterBuild: string;
}

export interface Plan {
  calendar: CalendarSpec;
  teams: Team[];
  capacity: CapacityPoint[];
  modules: Module[];
  tasks: Task[];
  dependencies: Dependency[];
  /** Optional; does not affect the schedule. Used by advisories. */
  features?: Feature[];
  /** The milestone whose finish is the project delivery date. Must have no successors. */
  deliveryTaskId: TaskId;
  /** The project's own phases. Without them a project uses `LEGACY_PHASES`, which is what existing projects have. */
  phases?: PhaseModel;
}
