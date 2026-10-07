import { describe, expect, it } from 'vitest';
import { buildMilestones, buildModuleView, buildThriveni, buildTimeline, recordEvent, recordPlanEdit, startProject, voidEvent } from '../src';
import type { Effect, Event, MilestoneDot, ProjectState } from '../src';
import { adjust, holiday, makeEvent, makePlanEdit, sharedExtinguisherEffects } from './helpers';

// Working-day offsets in Thriveni (start Mon 5 Oct): 3 = Wed 7 Oct, 7 = Tue 13 Oct, 13 = Wed 21 Oct, 14 = Thu 22 Oct,
// 20 = Fri 30 Oct, 21 = Mon 2 Nov. A task that starts at offset 7 starts on the 8th working day, Wed 14 Oct.
const fresh = () => startProject(buildThriveni());
const run = (...events: Event[]): ProjectState => events.reduce(recordEvent, fresh());
const dot = (dots: MilestoneDot[], id: string): MilestoneDot => {
  const d = dots.find((x) => x.id === id);
  if (!d) throw new Error(`no dot ${id}`);
  return d;
};
const slipM5 = () => makeEvent('t3', '2026-10-14', [adjust('m5.dev', 1)], { type: 'DEPENDENCY_DELAY' });

describe('the project view at the start', () => {
  const dots = buildMilestones(fresh());

  it('has a start and a finish for every module: nine modules, eighteen dots', () => {
    expect(dots).toHaveLength(18);
    expect(dots.filter((d) => d.kind === 'MODULE_START')).toHaveLength(9);
    expect(dots.filter((d) => d.kind === 'MODULE_FINISH')).toHaveLength(9);
  });

  it('puts each module start where its first task starts', () => {
    expect(dot(dots, 'start:m5')).toMatchObject({ kind: 'MODULE_START', name: 'Module 5 starts', taskId: null, original: { offset: 0, date: '2026-10-05' }, reached: false, variance: 0 });
    // The delivery part of the plan starts when client review does, after every module has reached alpha.
    expect(dot(dots, 'start:project').original).toEqual({ offset: 13, date: '2026-10-22' });
  });

  it('puts each module finish where its last task finishes, called by the milestone that ends it', () => {
    expect(dot(dots, 'finish:m5')).toMatchObject({ kind: 'MODULE_FINISH', name: 'm5 alpha', taskId: 'm5.alpha', original: { offset: 13, date: '2026-10-21' } });
    expect(dot(dots, 'finish:project')).toMatchObject({ name: 'Delivery', taskId: 'proj.delivery', original: { offset: 20, date: '2026-10-30' } });
    // No milestone ends the shared systems, so the module is simply "done" when its last task is.
    expect(dot(dots, 'finish:shared')).toMatchObject({ name: 'Shared systems done', taskId: 'shared.loc', original: { offset: 7, date: '2026-10-13' } });
  });

  it('lists them in the order they are planned: starts first, delivery last', () => {
    expect(dots.slice(0, 8).every((d) => d.kind === 'MODULE_START')).toBe(true);
    expect(dots[dots.length - 1]?.name).toBe('Delivery');
    const offsets = dots.map((d) => (d.original as { offset: number }).offset);
    expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
  });

  it('is on plan: original, plan and forecast agree, and nothing is flagged', () => {
    for (const d of dots) {
      expect(d.plan).toEqual(d.original);
      expect(d.forecast).toEqual(d.original);
      expect(d.variance).toBe(0);
      expect(d.flagged).toBe(false);
    }
  });

  it('marks the critical module starts and finishes', () => {
    expect(dot(dots, 'finish:m5').critical).toBe(true);
    expect(dot(dots, 'finish:m1').critical).toBe(false);
  });
});

describe('flagging a task as a project milestone', () => {
  it('adds a dot for it, at its own finish', () => {
    const dots = buildMilestones(fresh(), { flaggedTaskIds: ['proj.review', 'm5.dev'] });
    expect(dots).toHaveLength(20);
    expect(dot(dots, 'task:proj.review')).toMatchObject({ kind: 'MILESTONE', name: 'Client review', moduleId: 'project', flagged: true, original: { offset: 14, date: '2026-10-22' } });
    expect(dot(dots, 'task:m5.dev')).toMatchObject({ name: 'm5 development', original: { offset: 13, date: '2026-10-21' } });
  });

  it('does not add a second dot for the task that already ends its module, but marks that one flagged', () => {
    const dots = buildMilestones(fresh(), { flaggedTaskIds: ['m5.alpha'] });
    expect(dots).toHaveLength(18);
    expect(dot(dots, 'finish:m5').flagged).toBe(true);
  });

  it('ignores an id that is not a task', () => {
    expect(buildMilestones(fresh(), { flaggedTaskIds: ['nope'] })).toHaveLength(18);
  });

  it('gives a milestone task inside a module a dot without being asked', () => {
    const plan = buildThriveni();
    plan.tasks.push({ id: 'm5.signoff', moduleId: 'm5', teamId: 'pm', kind: 'MILESTONE', name: 'M5 art sign-off', estimate: 0 });
    plan.dependencies.push({ predecessorId: 'm5.art', successorId: 'm5.signoff', type: 'FS' });
    plan.dependencies.push({ predecessorId: 'm5.signoff', successorId: 'm5.dev', type: 'FS' });
    const dots = buildMilestones(startProject(plan));
    expect(dot(dots, 'task:m5.signoff')).toMatchObject({ kind: 'MILESTONE', name: 'M5 art sign-off', flagged: false, original: { offset: 7, date: '2026-10-13' } });
  });
});

describe('the project view as the project moves', () => {
  const state = run(slipM5());
  const dots = buildMilestones(state);

  it('shows a slip as a variance on what it pushed: the module finish, the delivery part of the plan, delivery', () => {
    expect(dot(dots, 'finish:m5')).toMatchObject({ variance: 1, plan: { offset: 13, date: '2026-10-21' }, forecast: { offset: 14, date: '2026-10-22' } });
    expect(dot(dots, 'start:project')).toMatchObject({ variance: 1, forecast: { offset: 14, date: '2026-10-23' } });
    expect(dot(dots, 'finish:project')).toMatchObject({ variance: 1, forecast: { offset: 21, date: '2026-11-02' } });
  });

  it('leaves everything else alone, and keeps the original where it was', () => {
    expect(dot(dots, 'finish:m1').variance).toBe(0);
    expect(dot(dots, 'finish:m5').original).toEqual({ offset: 13, date: '2026-10-21' });
  });

  it('knows how far the project has got: by Wed 14 Oct M5 has started and nothing is finished', () => {
    expect(dot(dots, 'start:m5').reached).toBe(true);
    expect(dot(dots, 'start:project').reached).toBe(false);
    expect(dot(dots, 'finish:m1').reached).toBe(false);
  });

  it('knows when a module is done', () => {
    const done = buildMilestones(run(makeEvent('late', '2026-11-03', [])));
    expect(done.every((d) => d.reached)).toBe(true);
  });

  it('counts a holiday as a day lost, in the calendar that is now in force', () => {
    const d = buildMilestones(run(makeEvent('hol', '2026-10-14', [holiday('2026-10-28')], { type: 'RESOURCE_CHANGE' })));
    expect(dot(d, 'finish:project')).toMatchObject({ variance: 1, forecast: { offset: 20, date: '2026-11-02' }, plan: { offset: 20, date: '2026-10-30' } });
  });
});

describe('a holiday, seen from inside a module', () => {
  const state = run(makeEvent('hol', '2026-10-14', [holiday('2026-10-28')], { type: 'RESOURCE_CHANGE' }));
  const view = buildModuleView(state, 'project');

  it('counts the day lost, comparing the plan and the forecast in the same calendar', () => {
    // Delivery is the 20th working day either way, but the 20th working day is now Mon 2 Nov, not Fri 30 Oct.
    expect(view.dots.find((d) => d.taskId === 'proj.delivery')).toMatchObject({ variance: 1, plan: { offset: 20, date: '2026-10-30' }, forecast: { offset: 20, date: '2026-11-02' } });
    expect(view.current).toMatchObject({ variance: 1, finish: { offset: 20, date: '2026-11-02' } });
  });

  it('puts the days that moved on branches, though no task’s offset changed', () => {
    const delivery = view.branches.find((b) => b.taskId === 'proj.delivery');
    expect(delivery?.steps[0]).toMatchObject({ delta: 1, origin: 'PROPAGATED' });
    expect(delivery?.currentDelta).toBe(1);
  });
});

describe('planning moves the plan, not the variance', () => {
  const state = recordPlanEdit(fresh(), makePlanEdit('longer-m7', '2026-10-06', [adjust('m7.dev', 3) as never]));
  const dots = buildMilestones(state);

  it('shows where it was, where the plan now has it, and no delay', () => {
    expect(dot(dots, 'finish:m7')).toMatchObject({
      original: { offset: 11, date: '2026-10-19' },
      plan: { offset: 14, date: '2026-10-22' },
      forecast: { offset: 14, date: '2026-10-22' },
      variance: 0,
    });
    expect(dot(dots, 'finish:project')).toMatchObject({ original: { offset: 20, date: '2026-10-30' }, plan: { offset: 21, date: '2026-11-02' }, variance: 0 });
  });

  it('moves a start the same way: the delivery part of the plan now begins a day later than it originally did', () => {
    expect(dot(dots, 'start:project')).toMatchObject({ original: { offset: 13, date: '2026-10-22' }, plan: { offset: 14, date: '2026-10-23' }, forecast: { offset: 14, date: '2026-10-23' }, variance: 0 });
  });
});

describe('work added after the start', () => {
  const state = run(makeEvent('ext', '2026-10-14', sharedExtinguisherEffects() as Effect[], { type: 'SCOPE_CHANGE' }));

  it('has no original position, and is drawn where it is forecast', () => {
    const d = dot(buildMilestones(state, { flaggedTaskIds: ['proj.ext'] }), 'task:proj.ext');
    expect(d).toMatchObject({ name: 'Extinguisher system', original: null, plan: null, variance: 0, flagged: true });
    expect(d.forecast.date).toBe('2026-10-28'); // client changes end Mon 26 Oct; two more days: Tue 27 and Wed 28
  });
});

describe('a module on its own, at the start', () => {
  const view = buildModuleView(fresh(), 'm5');

  it('has a dot for each task, in the order they finish', () => {
    expect(view.dots.map((d) => [d.taskId, d.original?.offset, d.original?.date])).toEqual([
      ['m5.sb', 3, '2026-10-07'],
      ['m5.art', 7, '2026-10-13'],
      ['m5.dev', 13, '2026-10-21'],
      ['m5.alpha', 13, '2026-10-21'],
    ]);
  });

  it('says where the module starts and finishes', () => {
    expect(view).toMatchObject({ moduleId: 'm5', name: 'Module 5', kind: 'DELIVERABLE' });
    expect(view.original).toEqual({ start: { offset: 0, date: '2026-10-05' }, finish: { offset: 13, date: '2026-10-21' } });
    expect(view.current).toMatchObject({ start: { offset: 0 }, finish: { offset: 13, date: '2026-10-21' }, planFinish: { offset: 13 }, variance: 0, asOf: null });
  });

  it('has no branches and no markers', () => {
    expect(view.branches).toEqual([]);
    expect(view.markers).toEqual([]);
  });

  it('describes each task: team, effort, state, whether it is critical', () => {
    expect(view.dots.find((d) => d.taskId === 'm5.dev')).toMatchObject({ name: 'm5 development', teamId: 'dev', kind: 'TASK', estimate: 6, state: 'NOT_STARTED', critical: true, added: false, variance: 0 });
    expect(view.dots.find((d) => d.taskId === 'm5.alpha')).toMatchObject({ kind: 'MILESTONE', estimate: 0 });
    expect(buildModuleView(fresh(), 'm1').dots.find((d) => d.taskId === 'm1.dev')?.critical).toBe(false);
  });

  it('refuses a module that does not exist', () => {
    expect(() => buildModuleView(fresh(), 'nope')).toThrow('No module "nope"');
  });
});

describe('a module whose task slipped', () => {
  const state = run(slipM5());
  const view = buildModuleView(state, 'm5');

  it('has a branch for the task that was touched and one for what it pushed', () => {
    expect(view.branches.map((b) => b.taskId)).toEqual(['m5.dev', 'm5.alpha']);
  });

  it('knows which was changed directly and which moved because of it', () => {
    const [dev, alpha] = view.branches;
    expect(dev?.steps).toEqual([
      expect.objectContaining({ revision: 1, kind: 'EVENT', eventId: 't3', asOf: '2026-10-14', change: 'MOVED', delta: 1, origin: 'DIRECT', fromTaskIds: [], finishAfter: { offset: 14, date: '2026-10-22' }, onCriticalPath: true }),
    ]);
    expect(alpha?.steps[0]).toMatchObject({ origin: 'PROPAGATED', fromTaskIds: ['m5.dev'], delta: 1 });
  });

  it('says where each stands now against its plan', () => {
    expect(view.branches[0]).toMatchObject({
      name: 'm5 development',
      forkAt: '2026-10-14',
      baselineFinish: { offset: 13, date: '2026-10-21' },
      currentFinish: { offset: 14, date: '2026-10-22' },
      currentDelta: 1,
      status: 'OPEN',
    });
  });

  it('leaves the tasks that did not move alone', () => {
    expect(view.branches.find((b) => b.taskId === 'm5.sb')).toBeUndefined();
    expect(view.dots.find((d) => d.taskId === 'm5.sb')?.variance).toBe(0);
    expect(view.current).toMatchObject({ variance: 1, finish: { offset: 14, date: '2026-10-22' }, planFinish: { offset: 13 }, asOf: '2026-10-14' });
  });

  it('shows the change that did it as a marker, and nothing from other modules', () => {
    expect(view.markers.map((m) => m.eventId)).toEqual(['t3']);
    const other = buildModuleView(run(makeEvent('t2', '2026-10-13', [adjust('m2.dev', 3)]), slipM5()), 'm5');
    expect(other.markers.map((m) => m.eventId)).toEqual(['t3']);
  });

  it('puts the delivery part of the plan on its own branches, each moved because of the one before', () => {
    const project = buildModuleView(state, 'project');
    expect(project.branches.map((b) => b.taskId)).toEqual(['proj.review', 'proj.chg.dev', 'proj.chg.art', 'proj.chg.lxd', 'proj.integration', 'proj.qa', 'proj.beta', 'proj.delivery']);
    expect(project.branches[0]?.steps[0]).toMatchObject({ origin: 'PROPAGATED', fromTaskIds: ['m5.alpha'] });
    expect(project.branches[1]?.steps[0]).toMatchObject({ origin: 'PROPAGATED', fromTaskIds: ['proj.review'] });
  });
});

describe('a task that recovers', () => {
  it('rejoins its plan: the branch is merged, and keeps both steps', () => {
    const back = makeEvent('back', '2026-10-15', [adjust('m5.dev', -1)]);
    const view = buildModuleView(run(slipM5(), back), 'm5');
    const dev = view.branches.find((b) => b.taskId === 'm5.dev');
    expect(dev?.status).toBe('MERGED');
    expect(dev?.currentDelta).toBe(0);
    expect(dev?.steps.map((s) => s.delta)).toEqual([1, -1]);
  });

  it('is also what happens when the event is withdrawn, and the withdrawal is a step', () => {
    const withdrawn = voidEvent(run(slipM5()), { kind: 'VOID', id: 'v1', eventId: 't3', asOf: '2026-10-15' });
    const dev = buildModuleView(withdrawn, 'm5').branches.find((b) => b.taskId === 'm5.dev');
    expect(dev?.status).toBe('MERGED');
    expect(dev?.steps.map((s) => [s.kind, s.delta])).toEqual([['EVENT', 1], ['VOID', -1]]);
  });
});

describe('planning is not a deviation', () => {
  const state = recordPlanEdit(fresh(), makePlanEdit('longer-m7', '2026-10-06', [adjust('m7.dev', 3) as never]));
  const view = buildModuleView(state, 'm7');

  it('makes no branch, even though the task now ends later than it did', () => {
    expect(view.branches).toEqual([]);
    expect(view.dots.find((d) => d.taskId === 'm7.dev')).toMatchObject({ original: { offset: 11 }, plan: { offset: 14 }, forecast: { offset: 14 }, variance: 0 });
  });

  it('is still shown, as a planning marker, so the change is not lost', () => {
    expect(view.markers).toEqual([expect.objectContaining({ kind: 'PLAN', eventId: 'longer-m7', baselineStepDays: 1 })]);
  });
});

describe('new work in a module', () => {
  const add: Effect = { op: 'ADD_TASK', task: { id: 'm3.extra', moduleId: 'm3', teamId: 'dev', kind: 'TASK', name: 'Extra scene', estimate: 1 }, dependsOn: ['m3.dev'], blocks: ['m3.alpha'] };
  const view = buildModuleView(run(makeEvent('extra', '2026-10-14', [add], { type: 'SCOPE_CHANGE' })), 'm3');

  it('is a dot with no original, and a branch that says it was added', () => {
    expect(view.dots.find((d) => d.taskId === 'm3.extra')).toMatchObject({ added: true, original: null, plan: null, variance: 0 });
    const branch = view.branches.find((b) => b.taskId === 'm3.extra');
    expect(branch).toMatchObject({ status: 'OPEN', baselineFinish: null });
    expect(branch?.steps[0]).toMatchObject({ change: 'ADDED', delta: 0, origin: 'DIRECT' });
  });

  it('also moves the task after it, which is on a branch of its own', () => {
    expect(view.branches.find((b) => b.taskId === 'm3.alpha')?.steps[0]).toMatchObject({ change: 'MOVED', origin: 'PROPAGATED' });
  });
});

describe('the two views agree', () => {
  it('on where a module finishes and by how much it is late', () => {
    const state = run(slipM5());
    const dots = buildMilestones(state);
    const view = buildModuleView(state, 'm5');
    expect(view.current.finish).toEqual(dot(dots, 'finish:m5').forecast);
    expect(view.current.variance).toBe(dot(dots, 'finish:m5').variance);
    expect(view.original.finish).toEqual(dot(dots, 'finish:m5').original);
  });

  it('with the project timeline: a module has a branch there exactly when it deviated', () => {
    const state = run(slipM5());
    const deviating = buildTimeline(state).branches.map((b) => b.moduleId).sort();
    const withTaskBranches = state.plan.modules.map((m) => m.id).filter((id) => buildModuleView(state, id).branches.length > 0).sort();
    expect(withTaskBranches).toEqual(deviating);
  });
});
