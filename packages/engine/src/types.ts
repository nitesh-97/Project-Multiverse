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

/** Actuals recorded against a task. `finishedOn` / `startedOn` follow the day conventions in DESIGN.md §3.1. */
export interface TaskProgress {
  startedOn?: ISODate;
  /** Effort still to do, in work-days at planned capacity. Defaults to the full estimate. */
  remaining?: WorkDays;
  finishedOn?: ISODate;
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
  progress?: TaskProgress;
}

/** Finish-to-start only for the MVP. */
export interface Dependency {
  predecessorId: TaskId;
  successorId: TaskId;
  type: 'FS';
}

export interface Plan {
  calendar: CalendarSpec;
  teams: Team[];
  capacity: CapacityPoint[];
  modules: Module[];
  tasks: Task[];
  dependencies: Dependency[];
  /** The milestone whose finish is the project delivery date. Must have no successors. */
  deliveryTaskId: TaskId;
}
