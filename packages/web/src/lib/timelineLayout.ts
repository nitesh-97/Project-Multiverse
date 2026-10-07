import type { DatedOffset, EventMarker, ModuleView, ProjectTimelineView } from '@multiverse/engine';
import { addDays, daysBetween, formatDate, formatShortDate, isHoliday, isWeekend, isWorkingDay, weekday } from './dates';
import type { CalendarLike } from './dates';
import { signedDays, workingDays } from './format';
import { INK } from './palette';

/**
 * Where everything goes on the Multiverse timeline, at either level: the whole project, or one module. Pure: the same
 * data and width always give the same picture, so the geometry can be tested without a browser. Time runs left to
 * right by calendar date; every instant the engine reports (a status date, a finish) is the end of a working day, so
 * it is drawn at the right edge of that day. A start is the left edge of its day.
 *
 * Both levels are the same picture: an original line with dots on it, a branch for everything that has moved away
 * from it, and the recorded changes along the top. `layoutScene` draws that; `layoutTimeline` and `layoutModule` say
 * what the dots and branches are.
 */

/** Room at the left for lane names, and at the right for each lane's end label. */
export const GUTTER = 150;
export const RIGHT = 170;
const TOP = 10;
const MARKER_Y = TOP + 22;
/** The original line is this far below the markers, plus room for any dots stacked above it. */
const ORIGINAL_GAP = 56;
/** The first branch is this far below the line, plus room for any dots stacked below it. */
const FIRST_LANE_GAP = 64;
const LANE_GAP = 58;
const AXIS_BAND = 52;
const MIN_LABEL_GAP = 52;
/** Label every day only when a day is wide enough that "10 Oct" and "11 Oct" do not touch. */
const DAILY_TICK_WIDTH = 46;
/** Dot names are wider than axis labels, so they need more room to stay readable. */
export const STATION_LABEL_GAP = 68;
/** How far before its first node a branch starts to leave the original line. */
const FORK_RUN = 30;
/** Dots this close in x are in one cluster, and are stacked rather than printed on top of each other. */
const CLUSTER_GAP = 12;
/** Vertical distance between stacked dots. */
export const STACK_STEP = 16;

export interface CalendarInput extends CalendarLike {
  startDate: string;
}

// ---------------------------------------------------------------------------------------------------------------
// What a scene is made of
// ---------------------------------------------------------------------------------------------------------------

export type DotShape = 'start' | 'finish' | 'milestone' | 'delivery' | 'task' | 'taskMilestone';

/** What a dot has to say for itself when hovered. */
export interface DotData {
  name: string;
  /** Where it was in the original plan. Null for something added after the project started. */
  original: DatedOffset | null;
  plan: DatedOffset | null;
  forecast: DatedOffset;
  /** Forecast against plan in working days. Positive is late. */
  variance: number;
  reached: boolean;
  critical: boolean;
  /** Further plain lines for the tooltip. */
  notes: string[];
}

export interface DotInput {
  key: string;
  shape: DotShape;
  color: string;
  /** The date it sits on, and which edge of that day. */
  at: string;
  edge: 'start' | 'end';
  /** Lower is more important: it is labelled first and sits nearest the line. */
  priority: number;
  /** Printed beside the dot if there is room. */
  label: string | null;
  data: DotData;
  /** Clicking opens this module's own timeline. */
  opens?: string | null;
}

export interface LaneStepData {
  revision: number;
  kind: 'EVENT' | 'PLAN' | 'VOID';
  eventId: string;
  asOf: string;
  /** How far this step moved the lane's finish. Negative is recovery. */
  delta: number;
  finishAfter: DatedOffset;
  origin: 'DIRECT' | 'PROPAGATED';
  /** The things upstream that explain a PROPAGATED step. */
  fromIds: string[];
  /** It slipped but float absorbed it: delivery did not move. */
  absorbed: boolean;
  onCriticalPath: boolean;
  /** The step is the work being added, not moved. */
  added?: boolean;
}

export interface LaneInput {
  id: string;
  name: string;
  color: string;
  isDelivery: boolean;
  forkAt: string;
  planned: DatedOffset | null;
  forecast: DatedOffset;
  status: 'OPEN' | 'MERGED';
  delta: number;
  steps: LaneStepData[];
}

export interface SceneInput {
  width: number;
  calendar: CalendarInput;
  today?: string | null;
  clientDate?: string | null;
  statusDate: string | null;
  /** The two ends of the original line: its first day, and the last day it runs to. */
  original: { start: string; finish: string };
  /** Where the plan now ends, when planning has moved it away from the original. */
  plan: { date: string } | null;
  dots: DotInput[];
  lanes: LaneInput[];
  markers: readonly EventMarker[];
  /** Other dates the picture must be wide enough to hold. */
  include?: readonly string[];
}

// ---------------------------------------------------------------------------------------------------------------
// What a layout is made of
// ---------------------------------------------------------------------------------------------------------------

export interface Tick {
  x: number;
  label: string;
  date: string;
}

export interface Band {
  x: number;
  width: number;
  date: string;
  /** Number of days merged into this band. */
  days: number;
}

export interface DotLayout {
  key: string;
  shape: DotShape;
  color: string;
  x: number;
  y: number;
  /** Which row of its cluster: 0 is on the line, negative above it, positive below. */
  slot: number;
  /** Only some dots are labelled: close ones would overprint. The others are still there to hover. */
  labelled: boolean;
  label: string | null;
  reached: boolean;
  /** No original position: it was added after the project started. */
  added: boolean;
  data: DotData;
  opens: string | null;
}

export interface StepLayout {
  x: number;
  y: number;
  step: LaneStepData;
  /** "+3", shown beside the node when there is room. */
  label: string;
  labelled: boolean;
}

export interface LaneLayout {
  id: string;
  name: string;
  color: string;
  isDelivery: boolean;
  y: number;
  status: 'OPEN' | 'MERGED';
  /** From the original line, curving down into the lane and along it to the forecast finish. */
  path: string;
  /** For a branch that is back on its original date: the curve rejoining the original line. */
  mergePath: string | null;
  forkX: number;
  endX: number;
  planned: { x: number; date: string } | null;
  forecast: { x: number; date: string };
  /** The bracket between where it was due and where it will now finish. */
  slip: { x0: number; x1: number; y: number; label: string; late: boolean } | null;
  steps: StepLayout[];
  endLabel: { x: number; y: number; date: string; text: string };
  currentDelta: number;
}

export interface MarkerLayout {
  x: number;
  y: number;
  marker: EventMarker;
}

export interface TimelineLayout {
  width: number;
  height: number;
  left: number;
  right: number;
  axisY: number;
  originalY: number;
  markerY: number;
  firstDate: string;
  lastDate: string;
  dayWidth: number;
  ticks: Tick[];
  weekends: Band[];
  holidays: Band[];
  original: { x0: number; x1: number; finishDate: string };
  /** The plan as it stands, when planning changes have moved it away from the original. */
  plan: { x: number; date: string } | null;
  dots: DotLayout[];
  /** How many rows of stacked dots sit above and below the original line. */
  dotRows: { above: number; below: number };
  lanes: LaneLayout[];
  markers: MarkerLayout[];
  status: { x: number; date: string } | null;
  /** Where the project is right now, like the train on a route: today, on the original line. Null before the project starts. */
  here: { x: number; y: number; date: string } | null;
  client: { x: number; date: string } | null;
  /** Converts a date (taken as the end of that day) to x. */
  xEnd: (date: string) => number;
}

// ---------------------------------------------------------------------------------------------------------------
// The scene
// ---------------------------------------------------------------------------------------------------------------

/** Row for each member of a cluster of n: on the line, then alternately above and below it. */
export const slotOf = (index: number): number => (index === 0 ? 0 : index % 2 === 1 ? -Math.ceil(index / 2) : Math.ceil(index / 2));

export function layoutScene(input: SceneInput): TimelineLayout {
  const { calendar, clientDate = null } = input;
  const width = Math.max(input.width, GUTTER + RIGHT + 280);

  /** A date that lands on a day off means the end of the last working day before it. */
  const worked = (date: string): string => {
    let d = date;
    for (let i = 0; i < 14 && !isWorkingDay(d, calendar); i++) d = addDays(d, -1);
    return d;
  };

  // The span: everything that has a date, with a day of air on the left and a little more on the right.
  const today = input.today && input.today >= calendar.startDate ? input.today : null;
  const dates: string[] = [calendar.startDate, input.original.start, input.original.finish, ...(input.include ?? [])];
  if (input.plan) dates.push(input.plan.date);
  if (clientDate) dates.push(clientDate);
  if (today) dates.push(today);
  if (input.statusDate) dates.push(input.statusDate);
  for (const d of input.dots) dates.push(d.at);
  for (const lane of input.lanes) {
    dates.push(lane.forkAt, lane.forecast.date);
    if (lane.planned) dates.push(lane.planned.date);
    for (const s of lane.steps) dates.push(s.asOf);
  }
  for (const m of input.markers) dates.push(m.asOf);
  const sorted = [...dates].sort();
  const firstDate = addDays(sorted[0] as string, -1);
  const lastDate = addDays(sorted[sorted.length - 1] as string, 2);
  const nDays = daysBetween(firstDate, lastDate) + 1;

  const left = GUTTER;
  const right = width - RIGHT;
  const dayWidth = (right - left) / nDays;
  const xStart = (date: string): number => left + daysBetween(firstDate, date) * dayWidth;
  const xEnd = (date: string): number => xStart(date) + dayWidth;

  // Axis ticks: every day if the days are wide, otherwise Mondays, thinned until the labels clear each other.
  const ticks: Tick[] = [];
  const mondaysEvery = [1, 2, 4, 8].find((k) => 7 * k * dayWidth >= MIN_LABEL_GAP) ?? 8;
  let mondayCount = 0;
  for (let i = 0; i < nDays; i++) {
    const date = addDays(firstDate, i);
    if (dayWidth >= DAILY_TICK_WIDTH) {
      ticks.push({ x: xStart(date), label: formatShortDate(date), date });
    } else if (weekday(date) === 1) {
      if (mondayCount % mondaysEvery === 0) ticks.push({ x: xStart(date), label: formatShortDate(date), date });
      mondayCount += 1;
    }
  }

  const merge = (test: (d: string) => boolean): Band[] => {
    const bands: Band[] = [];
    for (let i = 0; i < nDays; i++) {
      const date = addDays(firstDate, i);
      if (!test(date)) continue;
      const prev = bands[bands.length - 1];
      if (prev && Math.abs(prev.x + prev.width - xStart(date)) < 1e-6) {
        prev.width += dayWidth;
        prev.days += 1;
      } else {
        bands.push({ x: xStart(date), width: dayWidth, date, days: 1 });
      }
    }
    return bands;
  };
  const weekends = merge((d) => isWeekend(d, calendar) && !isHoliday(d, calendar));
  const holidays = merge((d) => isHoliday(d, calendar));

  // Dots on the original line. Dots that fall within a few pixels of each other are one cluster: stacked, so each can
  // be seen and hovered, with the most important on the line itself.
  const placed = input.dots
    .map((d) => ({ d, x: d.edge === 'start' ? xStart(d.at) : xEnd(d.at) }))
    .sort((a, b) => a.x - b.x || a.d.priority - b.d.priority || a.d.key.localeCompare(b.d.key));
  const clusters: Array<Array<{ d: DotInput; x: number }>> = [];
  for (const p of placed) {
    const current = clusters[clusters.length - 1];
    if (current && p.x - (current[0] as { x: number }).x <= CLUSTER_GAP) current.push(p);
    else clusters.push([p]);
  }
  let above = 0;
  let below = 0;
  const slots = new Map<string, number>();
  for (const cluster of clusters) {
    [...cluster]
      .sort((a, b) => a.d.priority - b.d.priority || a.x - b.x || a.d.key.localeCompare(b.d.key))
      .forEach((p, i) => {
        const slot = slotOf(i);
        slots.set(p.d.key, slot);
        above = Math.max(above, -slot);
        below = Math.max(below, slot);
      });
  }

  const originalY = MARKER_Y + ORIGINAL_GAP + above * STACK_STEP;
  const firstLaneY = originalY + FIRST_LANE_GAP + below * STACK_STEP;

  // Label the most important dots that are on the line, with nothing stacked above them, and room to either side.
  const labelTaken: number[] = [];
  const labelFree = (x: number): boolean => labelTaken.every((t) => Math.abs(t - x) >= STATION_LABEL_GAP);
  const clusterHasAbove = new Map<string, boolean>();
  for (const cluster of clusters) {
    const stackedAbove = cluster.some((p) => (slots.get(p.d.key) ?? 0) < 0);
    for (const p of cluster) clusterHasAbove.set(p.d.key, stackedAbove);
  }
  const labelled = new Set<string>();
  for (const p of [...placed].sort((a, b) => a.d.priority - b.d.priority || a.x - b.x)) {
    if (p.d.label === null || slots.get(p.d.key) !== 0 || clusterHasAbove.get(p.d.key)) continue;
    if (labelFree(p.x)) {
      labelled.add(p.d.key);
      labelTaken.push(p.x);
    }
  }

  const dots: DotLayout[] = placed.map(({ d, x }) => {
    const slot = slots.get(d.key) ?? 0;
    return {
      key: d.key,
      shape: d.shape,
      color: d.color,
      x,
      y: originalY + slot * STACK_STEP,
      slot,
      labelled: labelled.has(d.key),
      label: d.label,
      reached: d.data.reached,
      added: d.data.original === null,
      data: d.data,
      opens: d.opens ?? null,
    };
  });

  // Lanes: in the order given (the caller puts delivery first).
  const lanes: LaneLayout[] = input.lanes.map((lane, index) => {
    const y = firstLaneY + index * LANE_GAP;
    const forkX = xEnd(worked(lane.forkAt));
    const forecastX = xEnd(lane.forecast.date);
    const plannedX = lane.planned ? xEnd(lane.planned.date) : null;
    const merged = lane.status === 'MERGED';
    const endX = Math.max(forecastX, forkX + 8);
    // The branch leaves the original line a little before the day it deviates and arrives at its first node on that day.
    const bendStart = Math.max(forkX - FORK_RUN, xStart(calendar.startDate));

    // Nodes for each step, nudged apart when several happened on the same day.
    let previousX = Number.NEGATIVE_INFINITY;
    let previousLabelX = Number.NEGATIVE_INFINITY;
    const steps: StepLayout[] = lane.steps.map((step) => {
      let x = xEnd(worked(step.asOf));
      if (x - previousX < 9) x = previousX + 9;
      previousX = x;
      const labelled = x - previousLabelX >= 30;
      if (labelled) previousLabelX = x;
      return { x, y, step, label: step.added ? 'new' : signedDays(step.delta).replace(/ working days?/, ''), labelled };
    });

    const half = (forkX - bendStart) * 0.6;
    const path = `M ${bendStart} ${originalY} C ${bendStart + half} ${originalY}, ${forkX - half} ${y}, ${forkX} ${y} L ${endX} ${y}`;
    const mergePath = merged && plannedX !== null ? `M ${endX} ${y} C ${endX + 16} ${y}, ${plannedX + 4} ${originalY + 24}, ${plannedX} ${originalY}` : null;

    const slip =
      plannedX !== null && Math.abs(forecastX - plannedX) > 2
        ? { x0: Math.min(plannedX, forecastX), x1: Math.max(plannedX, forecastX), y: y + 16, label: signedDays(lane.delta), late: lane.delta > 0 }
        : null;

    const sign = merged ? 'back on its original date' : lane.planned === null ? 'new work' : signedDays(lane.delta);
    return {
      id: lane.id,
      name: lane.name,
      color: lane.color,
      isDelivery: lane.isDelivery,
      y,
      status: lane.status,
      path,
      mergePath,
      forkX,
      endX,
      planned: lane.planned && plannedX !== null ? { x: plannedX, date: lane.planned.date } : null,
      forecast: { x: forecastX, date: lane.forecast.date },
      slip,
      steps,
      endLabel: { x: endX + 12, y, date: lane.forecast.date, text: `${formatDate(lane.forecast.date)} · ${sign}` },
      currentDelta: lane.delta,
    };
  });

  // Event markers along the top; several on one day sit side by side.
  let lastMarkerX = Number.NEGATIVE_INFINITY;
  const markers: MarkerLayout[] = input.markers.map((marker) => {
    let x = xEnd(worked(marker.asOf));
    if (x - lastMarkerX < 13) x = lastMarkerX + 13;
    lastMarkerX = x;
    return { x, y: MARKER_Y, marker };
  });

  const axisY = (lanes.length > 0 ? firstLaneY + (lanes.length - 1) * LANE_GAP + 34 : originalY + 40 + below * STACK_STEP) + 6;

  return {
    width,
    height: axisY + AXIS_BAND,
    left,
    right,
    axisY,
    originalY,
    markerY: MARKER_Y,
    firstDate,
    lastDate,
    dayWidth,
    ticks,
    weekends,
    holidays,
    original: { x0: xStart(input.original.start), x1: xEnd(input.original.finish), finishDate: input.original.finish },
    plan: input.plan ? { x: xEnd(input.plan.date), date: input.plan.date } : null,
    dots,
    dotRows: { above, below },
    lanes,
    markers,
    // Today is a real instant, not the end of a working day: the middle of its column, whether or not it is a day off.
    here: today ? { x: xStart(today) + dayWidth / 2, y: originalY, date: today } : null,
    status: input.statusDate ? { x: xEnd(worked(input.statusDate)), date: input.statusDate } : null,
    client: clientDate ? { x: xEnd(clientDate), date: clientDate } : null,
    xEnd,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The project view
// ---------------------------------------------------------------------------------------------------------------

export interface LayoutInput {
  timeline: ProjectTimelineView;
  calendar: CalendarInput;
  clientDate: string | null;
  /** Colour for each module id (see palette.ts). */
  colors: ReadonlyMap<string, string>;
  width: number;
  /** Today, for the live "we are here" dot. Left out, there is no dot. */
  today?: string | null;
}

const reachedNote = (reached: boolean, started: boolean): string => (started ? (reached ? 'The module has started' : 'Not started yet') : reached ? 'Done' : 'Not done yet');

/** The whole project: module starts and finishes and flagged milestones as dots, a branch for each module that moved. */
export function layoutTimeline(input: LayoutInput): TimelineLayout {
  const { timeline, colors } = input;
  const kindOf = new Map(timeline.original.modules.map((m) => [m.moduleId, m.kind]));

  const dots: DotInput[] = timeline.milestones.map((m) => {
    const isDelivery = m.kind === 'MODULE_FINISH' && kindOf.get(m.moduleId) === 'PROJECT';
    const shape: DotShape = m.kind === 'MODULE_START' ? 'start' : isDelivery ? 'delivery' : m.kind === 'MODULE_FINISH' ? 'finish' : 'milestone';
    const at = m.original ?? m.forecast;
    return {
      key: m.id,
      shape,
      color: isDelivery ? INK : (colors.get(m.moduleId) ?? INK),
      at: at.date,
      edge: m.kind === 'MODULE_START' ? 'start' : 'end',
      priority: isDelivery ? 0 : m.kind === 'MILESTONE' ? 1 : m.kind === 'MODULE_START' ? 2 : 3,
      label: isDelivery ? `${m.name} ${formatDate(at.date)}` : m.kind === 'MILESTONE' ? m.name : null,
      data: {
        name: m.name,
        original: m.original,
        plan: m.plan,
        forecast: m.forecast,
        variance: m.variance,
        reached: m.reached,
        critical: m.critical,
        notes: [reachedNote(m.reached, m.kind === 'MODULE_START'), ...(m.flagged ? ['Flagged as a project milestone'] : [])],
      },
      opens: m.kind === 'MODULE_START' ? m.moduleId : null,
    };
  });

  // Delivery first, then the others in the order they first deviated.
  const ordered = [...timeline.branches].sort((a, b) => Number(b.isDelivery) - Number(a.isDelivery));
  const lanes: LaneInput[] = ordered.map((b) => ({
    id: b.moduleId,
    name: b.moduleName,
    color: colors.get(b.moduleId) ?? INK,
    isDelivery: b.isDelivery,
    forkAt: b.forkAt,
    planned: b.baselineFinish,
    forecast: b.currentFinish,
    status: b.status,
    delta: b.currentDelta,
    steps: b.steps.map((s) => ({
      revision: s.revision,
      kind: s.kind,
      eventId: s.eventId,
      asOf: s.asOf,
      delta: s.delta,
      finishAfter: s.finishAfter,
      origin: s.origin,
      fromIds: s.fromModuleIds,
      absorbed: s.absorbed,
      onCriticalPath: s.onCriticalPath,
    })),
  }));

  const planMoved = timeline.current.planDelivery.date !== timeline.original.delivery.date;
  return layoutScene({
    width: input.width,
    calendar: input.calendar,
    today: input.today ?? null,
    clientDate: input.clientDate,
    statusDate: timeline.current.asOf,
    original: { start: input.calendar.startDate, finish: timeline.original.delivery.date },
    plan: planMoved ? { date: timeline.current.planDelivery.date } : null,
    dots,
    lanes,
    markers: timeline.markers,
    include: [timeline.current.delivery.date],
  });
}

// ---------------------------------------------------------------------------------------------------------------
// One module
// ---------------------------------------------------------------------------------------------------------------

export interface ModuleLayoutInput {
  view: ModuleView;
  calendar: CalendarInput;
  /** The module's colour: its tasks and branches wear it. */
  color: string;
  width: number;
  today?: string | null;
}

const stateNote = (state: 'DONE' | 'IN_PROGRESS' | 'NOT_STARTED'): string => (state === 'DONE' ? 'Done' : state === 'IN_PROGRESS' ? 'Under way' : 'Not started yet');

/** One module: each of its tasks as a dot on the original line, and a branch for each task that moved from its plan. */
export function layoutModule(input: ModuleLayoutInput): TimelineLayout {
  const { view, color } = input;

  const dots: DotInput[] = view.dots.map((t) => {
    const at = t.original ?? t.forecast;
    return {
      key: t.taskId,
      shape: t.kind === 'MILESTONE' ? 'taskMilestone' : 'task',
      color,
      at: at.date,
      edge: 'end',
      priority: t.kind === 'MILESTONE' ? 0 : 1,
      label: t.name,
      data: {
        name: t.name,
        original: t.original,
        plan: t.plan,
        forecast: t.forecast,
        variance: t.variance,
        reached: t.state === 'DONE',
        critical: t.critical,
        notes: [stateNote(t.state), ...(t.kind === 'TASK' ? [`${workingDays(t.estimate)} of effort`] : []), ...(t.added ? ['Added after the project started'] : [])],
      },
    };
  });

  const lanes: LaneInput[] = view.branches.map((b) => ({
    id: b.taskId,
    name: b.name,
    color,
    isDelivery: false,
    forkAt: b.forkAt,
    planned: b.baselineFinish,
    forecast: b.currentFinish,
    status: b.status,
    delta: b.currentDelta,
    steps: b.steps.map((s) => ({
      revision: s.revision,
      kind: s.kind,
      eventId: s.eventId,
      asOf: s.asOf,
      delta: s.delta,
      finishAfter: s.finishAfter,
      origin: s.origin,
      fromIds: s.fromTaskIds,
      absorbed: false,
      onCriticalPath: s.onCriticalPath,
      added: s.change === 'ADDED',
    })),
  }));

  const start = view.original.start ?? view.current.start;
  const finish = view.original.finish ?? view.current.finish;
  const planMoved = view.current.planFinish !== null && view.original.finish !== null && view.current.planFinish.date !== view.original.finish.date;
  return layoutScene({
    width: input.width,
    calendar: input.calendar,
    today: input.today ?? null,
    statusDate: view.current.asOf,
    original: { start: start.date, finish: finish.date },
    plan: planMoved && view.current.planFinish ? { date: view.current.planFinish.date } : null,
    dots,
    lanes,
    markers: view.markers,
    include: [view.current.finish.date, view.current.start.date],
  });
}
