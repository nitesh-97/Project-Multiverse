import { buildMilestones, buildModuleView, buildThriveni, buildTimeline, recordEvent, recordPlanEdit, startProject } from '@multiverse/engine';
import type { Event, ProjectState, ProjectTimelineView } from '@multiverse/engine';
import { describe, expect, it } from 'vitest';
import { GUTTER, RIGHT, STACK_STEP, STATION_LABEL_GAP, layoutModule, layoutScene, layoutTimeline, slotOf } from '../src/lib/timelineLayout';
import type { DotData, DotInput } from '../src/lib/timelineLayout';
import { moduleColors } from '../src/lib/palette';

const event = (id: string, asOf: string, taskId: string, delta: number, type: Event['type'] = 'TASK_DELAY'): Event => ({
  id,
  type,
  category: 'General',
  title: id,
  description: '',
  phase: 'DEVELOPMENT',
  createdBy: 'tester',
  occurredAt: asOf,
  asOf,
  effects: [{ op: 'ADJUST_ESTIMATE', taskId, delta }],
});

const plan = buildThriveni();
const colors = moduleColors(plan.modules);
const calendar = plan.calendar;

const projectView = (state: ProjectState, flaggedTaskIds: string[] = []): ProjectTimelineView => ({
  ...buildTimeline(state),
  milestones: buildMilestones(state, { flaggedTaskIds }),
  flaggedTaskIds,
});

// M2 development +3 on Tue 13 Oct (absorbed by float); M5 development +1 on Wed 14 Oct (delivery moves to Mon 2 Nov).
const slipped = [event('t2', '2026-10-13', 'm2.dev', 3), event('t3', '2026-10-14', 'm5.dev', 1, 'DEPENDENCY_DELAY')].reduce(recordEvent, startProject(plan));
const timeline = projectView(slipped);

// 1120 wide leaves an 800px plot. The span is Sun 4 Oct to Wed 4 Nov = 32 days, so each day is exactly 25px.
const WIDTH = GUTTER + RIGHT + 800;
const layout = layoutTimeline({ timeline, calendar, clientDate: '2026-10-30', colors, width: WIDTH });
const lane = (id: string) => {
  const l = layout.lanes.find((x) => x.id === id);
  if (!l) throw new Error(`no lane for ${id}`);
  return l;
};
const dot = (key: string) => {
  const d = layout.dots.find((x) => x.key === key);
  if (!d) throw new Error(`no dot ${key}`);
  return d;
};
/** The right-hand edge of a date: x of the end of that day. */
const edge = (date: string) => layout.xEnd(date);

describe('the time scale', () => {
  it('is one day per 25px here, from Sun 4 Oct to Wed 4 Nov', () => {
    expect(layout.firstDate).toBe('2026-10-04');
    expect(layout.lastDate).toBe('2026-11-04');
    expect(layout.dayWidth).toBe(25);
  });

  it('puts an instant at the end of its day: Fri 30 Oct ends at 150 + 26 days x 25 + 25 = 825', () => {
    expect(edge('2026-10-30')).toBe(825);
    expect(edge('2026-11-02')).toBe(900);
  });

  it('draws the original line from the start of the project to the original delivery', () => {
    expect(layout.original).toEqual({ x0: GUTTER + 25, x1: 825, finishDate: '2026-10-30' });
  });

  it('marks the status date and the client date', () => {
    expect(layout.status).toEqual({ x: 425, date: '2026-10-14' });
    expect(layout.client).toEqual({ x: 825, date: '2026-10-30' });
  });

  it('has no plan-now marker while the plan has not moved', () => {
    expect(layout.plan).toBeNull();
  });

  it('puts a tick on each Monday and shades each weekend, with the first Sunday on its own', () => {
    expect(layout.ticks.map((t) => [t.label, t.x])).toEqual([['5 Oct', 175], ['12 Oct', 350], ['19 Oct', 525], ['26 Oct', 700], ['2 Nov', 875]]);
    expect(layout.weekends.map((b) => [b.date, b.x, b.width])).toEqual([
      ['2026-10-04', 150, 25],
      ['2026-10-10', 300, 50],
      ['2026-10-17', 475, 50],
      ['2026-10-24', 650, 50],
      ['2026-10-31', 825, 50],
    ]);
  });

  it('marks a holiday apart from the weekends', () => {
    const withHoliday = layoutTimeline({ timeline, calendar: { ...calendar, holidays: ['2026-10-28'] }, clientDate: null, colors, width: WIDTH });
    expect(withHoliday.holidays).toEqual([{ x: 750, width: 25, date: '2026-10-28', days: 1 }]);
    expect(withHoliday.weekends).toHaveLength(5);
    expect(withHoliday.client).toBeNull();
  });
});

describe('the dots on the original line', () => {
  it('has one for each start and finish of the nine modules', () => {
    expect(layout.dots).toHaveLength(18);
    expect(layout.dots.filter((d) => d.shape === 'start')).toHaveLength(9);
    expect(layout.dots.filter((d) => d.shape === 'finish' || d.shape === 'delivery')).toHaveLength(9);
  });

  it('puts a start at the left edge of its day and a finish at the right edge', () => {
    expect(dot('start:m5').x).toBe(175); // Mon 5 Oct begins at 150 + 25
    expect(dot('finish:m5').x).toBe(600); // Wed 21 Oct ends at 150 + 17 x 25 + 25
    expect(dot('start:project').x).toBe(600); // Thu 22 Oct begins where Wed 21 Oct ends
  });

  it('colours each module’s dots with its own colour, and the delivery part of the plan in ink', () => {
    expect(dot('start:m5').color).toBe('var(--series-5)');
    expect(dot('finish:m2').color).toBe('var(--series-2)');
    expect(dot('start:project').color).toBe('var(--ink)');
  });

  it('draws the delivery as its own kind of dot, and labels it', () => {
    expect(dot('finish:project')).toMatchObject({ shape: 'delivery', x: 825, slot: 0, labelled: true, label: 'Delivery Fri 30 Oct' });
  });

  it('opens a module’s own timeline from its start dot, and nothing else', () => {
    expect(dot('start:m5').opens).toBe('m5');
    expect(layout.dots.filter((d) => d.opens !== null).map((d) => d.key).sort()).toEqual(layout.dots.filter((d) => d.shape === 'start').map((d) => d.key).sort());
  });

  it('carries what the tooltip needs: where it was planned, and where it is forecast now', () => {
    expect(dot('finish:m5').data).toMatchObject({ name: 'm5 alpha', original: { offset: 13, date: '2026-10-21' }, forecast: { offset: 14, date: '2026-10-22' }, variance: 1, reached: false, critical: true });
    expect(dot('start:m5').data.reached).toBe(true); // by Wed 14 Oct M5 has started
    expect(dot('finish:m2').data.variance).toBe(3);
  });

  it('is hollow until reached, and is not "added"', () => {
    expect(dot('finish:m1')).toMatchObject({ reached: false, added: false });
  });
});

describe('dots that fall on the same day', () => {
  it('stack, so every one can be seen and hovered: eight module starts make a column of eight', () => {
    const starts = layout.dots.filter((d) => d.x === 175);
    expect(starts).toHaveLength(8);
    expect(starts.map((d) => d.slot).sort((a, b) => a - b)).toEqual([-4, -3, -2, -1, 0, 1, 2, 3]);
    expect(new Set(starts.map((d) => d.y)).size).toBe(8);
  });

  it('put the most important on the line, then alternate above and below', () => {
    expect([0, 1, 2, 3, 4, 5, 6].map(slotOf)).toEqual([0, -1, 1, -2, 2, -3, 3]);
    expect(dot('start:m1').slot).toBe(0);
    expect(dot('start:m2').slot).toBe(-1);
    expect(dot('start:m5').y).toBe(layout.originalY + 2 * STACK_STEP);
  });

  it('make room: the line sits below the tallest stack above it, and the branches below the one under it', () => {
    expect(layout.dotRows).toEqual({ above: 4, below: 3 });
    expect(layout.originalY).toBe(32 + 56 + 4 * STACK_STEP);
    expect(layout.lanes[0]?.y).toBe(layout.originalY + 64 + 3 * STACK_STEP);
  });

  it('put the start of the delivery part of the plan on the line, and the module finishing the same day above it', () => {
    expect(dot('start:project').slot).toBe(0);
    expect(dot('finish:m5').slot).toBe(-1);
  });

  it('do not stack when they are apart', () => {
    expect(dot('finish:project').slot).toBe(0);
    expect(dot('finish:shared').slot).toBe(0);
  });

  it('are one cluster within the gap, and separate beyond it', () => {
    // 61 days across 525px is 8.6px a day: neighbours are within the gap, two days apart are not.
    const calendarOnly = { startDate: '2026-10-05', weekendDays: [0, 6], holidays: [] };
    const data: DotData = { name: 'x', original: null, plan: null, forecast: { offset: 1, date: '2026-10-05' }, variance: 0, reached: false, critical: false, notes: [] };
    const dotAt = (key: string, at: string): DotInput => ({ key, shape: 'task', color: 'var(--ink)', at, edge: 'end', priority: 1, label: key, data });
    const scene = (dots: DotInput[]) =>
      layoutScene({ width: GUTTER + RIGHT + 525, calendar: calendarOnly, statusDate: null, original: { start: '2026-10-05', finish: '2026-10-07' }, plan: null, dots, lanes: [], markers: [], include: ['2026-12-01'] });
    const near = scene([dotAt('a', '2026-10-07'), dotAt('b', '2026-10-08')]);
    expect(near.dayWidth).toBeLessThan(12);
    expect(near.dots.map((d) => d.slot).sort()).toEqual([-1, 0]);
    const apart = scene([dotAt('a', '2026-10-07'), dotAt('b', '2026-10-09')]);
    expect(apart.dots.map((d) => d.slot)).toEqual([0, 0]);
  });
});

describe('labelling the dots', () => {
  it('labels only what has room, the most important first, and never two on top of each other', () => {
    const calendarOnly = { startDate: '2026-10-05', weekendDays: [0, 6], holidays: [] };
    const data: DotData = { name: 'x', original: { offset: 1, date: '2026-10-05' }, plan: null, forecast: { offset: 1, date: '2026-10-05' }, variance: 0, reached: false, critical: false, notes: [] };
    const dotAt = (key: string, at: string, priority: number): DotInput => ({ key, shape: 'task', color: 'var(--ink)', at, edge: 'end', priority, label: key, data });
    const l = layoutScene({
      width: GUTTER + RIGHT + 800,
      calendar: calendarOnly,
      statusDate: null,
      original: { start: '2026-10-05', finish: '2026-10-30' },
      plan: null,
      // 25px a day: Oct 14 and Oct 15 are one day apart, so only the more important is labelled.
      dots: [dotAt('minor', '2026-10-14', 5), dotAt('major', '2026-10-15', 1), dotAt('far', '2026-10-28', 9)],
      lanes: [],
      markers: [],
    });
    const labelled = l.dots.filter((d) => d.labelled).map((d) => d.key);
    expect(labelled).toEqual(['major', 'far']);
    const xs = l.dots.filter((d) => d.labelled).map((d) => d.x);
    expect(Math.abs((xs[0] as number) - (xs[1] as number))).toBeGreaterThanOrEqual(STATION_LABEL_GAP);
  });

  it('does not label a dot with another stacked above it: the label would print over it', () => {
    expect(dot('start:m1').labelled).toBe(false);
    expect(dot('finish:m5').labelled).toBe(false);
  });

  it('labels a flagged milestone, which is not stacked with anything', () => {
    const flagged = layoutTimeline({ timeline: projectView(slipped, ['proj.review']), calendar, clientDate: null, colors, width: WIDTH });
    const d = flagged.dots.find((x) => x.key === 'task:proj.review');
    expect(d).toMatchObject({ shape: 'milestone', label: 'Client review', labelled: true });
    expect(d?.data.notes).toContain('Flagged as a project milestone');
  });
});

describe('the branches', () => {
  it('has one lane per deviating module, delivery first, then in the order they first deviated', () => {
    expect(layout.lanes.map((l) => l.id)).toEqual(['project', 'm2', 'm5']);
    expect(layout.lanes.map((l) => l.y)).toEqual([264, 322, 380]);
  });

  it('keeps each module on its own colour and draws delivery in ink', () => {
    expect(lane('project').color).toBe('var(--ink)');
    expect(lane('m2').color).toBe('var(--series-2)');
    expect(lane('m5').color).toBe('var(--series-5)');
    expect(lane('project').isDelivery).toBe(true);
  });

  it('forks from the original line on the day it first deviated', () => {
    expect(lane('m5').forkX).toBe(edge('2026-10-14'));
    expect(lane('m2').forkX).toBe(edge('2026-10-13'));
    // It leaves the original line 30px before the day, and arrives at its first node on the day.
    expect(lane('m5').path.startsWith(`M ${edge('2026-10-14') - 30} ${layout.originalY}`)).toBe(true);
    expect(lane('m5').path).toContain(`${edge('2026-10-14')} ${lane('m5').y} L`);
  });

  it('ends the delivery lane at the forecast delivery, with the bracket showing the slip from the original date', () => {
    const d = lane('project');
    expect(d.forecast).toEqual({ x: 900, date: '2026-11-02' });
    expect(d.planned).toEqual({ x: 825, date: '2026-10-30' });
    expect(d.slip).toMatchObject({ x0: 825, x1: 900, label: '+1 working day', late: true });
    expect(d.endLabel.text).toBe('Mon 2 Nov · +1 working day');
    expect(d.status).toBe('OPEN');
  });

  it('shows a slip that float absorbed: M2 moves 3 days and the bracket says so', () => {
    const m2 = lane('m2');
    expect(m2.slip).toMatchObject({ label: '+3 working days', late: true });
    // Three working days from Thu 15 Oct to Tue 20 Oct is five calendar days, because the weekend is in between.
    expect((m2.slip?.x1 as number) - (m2.slip?.x0 as number)).toBeCloseTo(5 * layout.dayWidth, 6);
    expect(m2.steps[0]?.step.absorbed).toBe(true);
  });

  it('puts a node for every step, at the day it happened, labelled with its size', () => {
    const steps = lane('m5').steps;
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ x: 425, y: 380, label: '+1', labelled: true });
    expect(steps[0]?.step.eventId).toBe('t3');
  });

  it('spreads steps that happened on the same day instead of stacking them', () => {
    const twice = [event('a', '2026-10-14', 'm5.dev', 1), event('b', '2026-10-14', 'm5.dev', 1)].reduce(recordEvent, startProject(plan));
    const l = layoutTimeline({ timeline: projectView(twice), calendar, clientDate: null, colors, width: WIDTH });
    const [first, second] = l.lanes.find((x) => x.id === 'm5')?.steps ?? [];
    expect(first?.x).toBe(l.xEnd('2026-10-14'));
    expect((second?.x as number) - (first?.x as number)).toBe(9);
  });

  it('has no lanes while nothing has deviated, but still has the dots', () => {
    const quiet = layoutTimeline({ timeline: projectView(startProject(plan)), calendar, clientDate: null, colors, width: 900 });
    expect(quiet.lanes).toEqual([]);
    expect(quiet.markers).toEqual([]);
    expect(quiet.dots).toHaveLength(18);
    expect(quiet.height).toBeGreaterThan(quiet.originalY);
  });

  it('keeps the axis below the last lane', () => {
    expect(layout.axisY).toBe(380 + 34 + 6);
    expect(layout.height).toBe(layout.axisY + 52);
  });

  it('draws a recovered module back onto the original line', () => {
    const recovered = [event('late', '2026-10-14', 'm5.dev', 1), event('back', '2026-10-15', 'm5.dev', -1)].reduce(recordEvent, startProject(plan));
    const l = layoutTimeline({ timeline: projectView(recovered), calendar, clientDate: null, colors, width: WIDTH });
    const m5 = l.lanes.find((x) => x.id === 'm5');
    expect(m5?.status).toBe('MERGED');
    expect(m5?.mergePath).not.toBeNull();
    expect(m5?.endLabel.text).toContain('back on its original date');
  });
});

describe('the event markers', () => {
  it('has one per event, at the day it was recorded, in a row above the original line', () => {
    expect(layout.markers.map((m) => [m.marker.eventId, m.x, m.y])).toEqual([['t2', 400, 32], ['t3', 425, 32]]);
    expect(layout.markers.every((m) => m.y < layout.originalY - 4 * STACK_STEP)).toBe(true);
  });

  it('sits side by side when several were recorded on one day', () => {
    const same = [event('a', '2026-10-14', 'm5.dev', 1), event('b', '2026-10-14', 'm3.dev', 1)].reduce(recordEvent, startProject(plan));
    const l = layoutTimeline({ timeline: projectView(same), calendar, clientDate: null, colors, width: WIDTH });
    expect(l.markers.map((m) => m.x)).toEqual([l.xEnd('2026-10-14'), l.xEnd('2026-10-14') + 13]);
  });

  it('draws a status date that falls on a day off at the end of the last working day before it', () => {
    const saturday: ProjectTimelineView = { ...timeline, markers: [{ ...(timeline.markers[0] as ProjectTimelineView['markers'][number]), asOf: '2026-10-10' }], current: { ...timeline.current, asOf: '2026-10-10' } };
    const l = layoutTimeline({ timeline: saturday, calendar, clientDate: null, colors, width: WIDTH });
    expect(l.markers[0]?.x).toBe(l.xEnd('2026-10-09'));
    expect(l.status?.x).toBe(l.xEnd('2026-10-09'));
  });
});

describe('when planning has moved the plan', () => {
  it('shows where the plan now ends, apart from the original', () => {
    const moved: ProjectTimelineView = { ...timeline, current: { ...timeline.current, planDelivery: { offset: 21, date: '2026-11-02' } } };
    const l = layoutTimeline({ timeline: moved, calendar, clientDate: null, colors, width: WIDTH });
    expect(l.plan).toEqual({ x: 900, date: '2026-11-02' });
    expect(l.original.x1).toBe(825);
  });

  it('puts a dot for added work where it is forecast, marked as added', () => {
    const added = recordEvent(startProject(plan), {
      ...event('ext', '2026-10-14', 'm5.dev', 0),
      effects: [{ op: 'ADD_TASK', task: { id: 'proj.ext', moduleId: 'project', teamId: 'dev', kind: 'TASK', name: 'Extinguisher system', estimate: 2 }, dependsOn: ['proj.chg.dev'], blocks: ['proj.integration'] }],
    });
    const l = layoutTimeline({ timeline: projectView(added, ['proj.ext']), calendar, clientDate: null, colors, width: WIDTH });
    const d = l.dots.find((x) => x.key === 'task:proj.ext');
    expect(d).toMatchObject({ added: true, label: 'Extinguisher system' });
    expect(d?.x).toBe(l.xEnd('2026-10-28'));
  });
});

describe('where we are right now', () => {
  const at = (today: string | null | undefined) => layoutTimeline({ timeline, calendar, clientDate: '2026-10-30', colors, width: WIDTH, ...(today !== undefined ? { today } : {}) });

  it('puts the live dot on the original line, in the middle of today', () => {
    // Wed 14 Oct is 10 days after the first date, so its column starts at 150 + 10 x 25 = 400; the middle is 12.5 further.
    expect(at('2026-10-14').here).toEqual({ x: 412.5, y: at('2026-10-14').originalY, date: '2026-10-14' });
  });

  it('follows the clock, not the last re-forecast', () => {
    const early = at('2026-10-08');
    expect(early.here?.x).toBe(150 + 4 * 25 + 12.5);
    expect(early.status?.x).toBe(425); // the status date is where the forecast was last re-worked
    expect(early.here?.x).toBeLessThan(early.status?.x as number);
  });

  it('is on a day off when today is, because time does not stop at weekends', () => {
    expect(at('2026-10-10').here?.x).toBe(150 + 6 * 25 + 12.5); // Saturday
  });

  it('is absent before the project starts, and when no date is given', () => {
    expect(at('2026-10-01').here).toBeNull();
    expect(at(null).here).toBeNull();
    expect(at(undefined).here).toBeNull();
  });

  it('widens the chart when today is later than everything else, so the dot is never off the end', () => {
    const late = at('2026-11-20');
    expect(late.here).not.toBeNull();
    expect(late.lastDate).toBe('2026-11-22');
    expect(late.here?.x as number).toBeLessThan(late.right);
  });
});

describe('one module on its own', () => {
  // Width chosen so the span (Sun 4 Oct to Sat 24 Oct, 21 days) is exactly 25px a day.
  const MODULE_WIDTH = GUTTER + RIGHT + 525;
  const view = buildModuleView(recordEvent(startProject(plan), event('t3', '2026-10-14', 'm5.dev', 1, 'DEPENDENCY_DELAY')), 'm5');
  const m = layoutModule({ view, calendar, color: 'var(--series-5)', width: MODULE_WIDTH });
  const mDot = (key: string) => {
    const d = m.dots.find((x) => x.key === key);
    if (!d) throw new Error(`no dot ${key}`);
    return d;
  };

  it('has a dot for each task, at the end of the day it was planned to finish', () => {
    expect(m.dayWidth).toBe(25);
    expect(m.dots.map((d) => [d.key, d.x]).sort()).toEqual([['m5.alpha', 600], ['m5.art', 400], ['m5.dev', 600], ['m5.sb', 250]]);
  });

  it('draws a task as a ring and a milestone as a diamond, all in the module’s colour', () => {
    expect(mDot('m5.dev')).toMatchObject({ shape: 'task', color: 'var(--series-5)' });
    expect(mDot('m5.alpha')).toMatchObject({ shape: 'taskMilestone', color: 'var(--series-5)' });
  });

  it('puts the milestone on the line and the task that ends with it above, and labels what is clear', () => {
    expect(mDot('m5.alpha')).toMatchObject({ slot: 0, labelled: false }); // something is stacked above it
    expect(mDot('m5.dev').slot).toBe(-1);
    expect(mDot('m5.sb')).toMatchObject({ slot: 0, labelled: true, label: 'm5 storyboard' });
    expect(m.dotRows).toEqual({ above: 1, below: 0 });
  });

  it('runs the original line from the module’s first day to its planned finish', () => {
    expect(m.original).toEqual({ x0: 175, x1: 600, finishDate: '2026-10-21' });
    expect(m.originalY).toBe(32 + 56 + STACK_STEP);
  });

  it('has a branch for each task that moved, in the order the work happens, wearing the module’s colour', () => {
    expect(m.lanes.map((l) => l.id)).toEqual(['m5.dev', 'm5.alpha']);
    expect(m.lanes.every((l) => l.color === 'var(--series-5)' && !l.isDelivery)).toBe(true);
    expect(m.lanes.map((l) => l.y)).toEqual([m.originalY + 64, m.originalY + 64 + 58]);
  });

  it('says why each moved: changed directly, or because of the task before it', () => {
    expect(m.lanes[0]?.steps[0]?.step).toMatchObject({ origin: 'DIRECT', fromIds: [], delta: 1, eventId: 't3' });
    expect(m.lanes[1]?.steps[0]?.step).toMatchObject({ origin: 'PROPAGATED', fromIds: ['m5.dev'] });
  });

  it('shows how far each moved, from where it was planned to where it is forecast', () => {
    expect(m.lanes[0]?.planned).toEqual({ x: 600, date: '2026-10-21' });
    expect(m.lanes[0]?.forecast).toEqual({ x: 625, date: '2026-10-22' });
    expect(m.lanes[0]?.endLabel.text).toBe('Thu 22 Oct · +1 working day');
  });

  it('has the recorded changes that touched this module along the top, and no client date', () => {
    expect(m.markers.map((x) => x.marker.eventId)).toEqual(['t3']);
    expect(m.client).toBeNull();
    expect(m.status).toEqual({ x: 425, date: '2026-10-14' });
  });

  it('shows where we are right now, as the project view does', () => {
    const live = layoutModule({ view, calendar, color: 'var(--series-5)', width: MODULE_WIDTH, today: '2026-10-14' });
    expect(live.here).toEqual({ x: 412.5, y: live.originalY, date: '2026-10-14' });
  });

  it('draws added work as a dot with no original, and a lane that says it is new', () => {
    const state = recordEvent(startProject(plan), {
      ...event('extra', '2026-10-14', 'm3.dev', 0),
      type: 'SCOPE_CHANGE',
      effects: [{ op: 'ADD_TASK', task: { id: 'm3.extra', moduleId: 'm3', teamId: 'dev', kind: 'TASK', name: 'Extra scene', estimate: 1 }, dependsOn: ['m3.dev'], blocks: ['m3.alpha'] }],
    });
    const l = layoutModule({ view: buildModuleView(state, 'm3'), calendar, color: 'var(--series-3)', width: MODULE_WIDTH });
    expect(l.dots.find((d) => d.key === 'm3.extra')).toMatchObject({ added: true });
    const added = l.lanes.find((x) => x.id === 'm3.extra');
    expect(added?.planned).toBeNull();
    expect(added?.endLabel.text).toContain('new work');
    expect(added?.steps[0]?.label).toBe('new');
  });

  it('shows where a planning change moved the module’s end', () => {
    const planned = recordPlanEdit(startProject(plan), { id: 'longer-m7', title: 'M7 re-estimated', createdBy: 'p', asOf: '2026-10-06', effects: [{ op: 'ADJUST_ESTIMATE', taskId: 'm7.dev', delta: 3 }] });
    const l = layoutModule({ view: buildModuleView(planned, 'm7'), calendar, color: 'var(--series-7)', width: MODULE_WIDTH });
    expect(l.plan?.date).toBe('2026-10-22');
    expect(l.original.finishDate).toBe('2026-10-19');
    expect(l.lanes).toEqual([]); // planning is not a deviation
  });
});

describe('the axis labels', () => {
  const scene = (width: number, include: string[] = []) =>
    layoutScene({ width, calendar: { startDate: '2026-10-05', weekendDays: [0, 6], holidays: [] }, statusDate: null, original: { start: '2026-10-05', finish: '2026-10-09' }, plan: null, dots: [], lanes: [], markers: [], include });

  it('labels every day when a day is wide enough, so a short module reads by the day', () => {
    // 8 days over 525px is 66px a day.
    const l = scene(GUTTER + RIGHT + 525);
    expect(l.dayWidth).toBeGreaterThanOrEqual(46);
    expect(l.ticks).toHaveLength(8);
    expect(l.ticks[0]).toMatchObject({ label: '4 Oct', date: '2026-10-04' });
  });

  it('labels Mondays only when days are narrow, so the labels never touch', () => {
    // 21 days over 525px is 25px a day: far too narrow for a label each.
    const l = scene(GUTTER + RIGHT + 525, ['2026-10-22']);
    expect(l.dayWidth).toBeLessThan(46);
    expect(l.ticks.map((t) => t.label)).toEqual(['5 Oct', '12 Oct', '19 Oct']);
    const gaps = l.ticks.slice(1).map((t, i) => t.x - (l.ticks[i] as { x: number }).x);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(52);
  });
});

describe('narrow screens', () => {
  it('never squeezes the plot below a readable width', () => {
    const narrow = layoutTimeline({ timeline, calendar, clientDate: null, colors, width: 200 });
    expect(narrow.width).toBeGreaterThanOrEqual(GUTTER + RIGHT + 280);
    expect(narrow.right - narrow.left).toBeGreaterThanOrEqual(280);
  });
});
