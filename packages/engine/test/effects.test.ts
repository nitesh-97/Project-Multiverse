import { describe, expect, it } from 'vitest';
import { EffectError, applyEffects, buildThriveni, schedule } from '../src';
import type { Effect, Plan, TaskProgress } from '../src';
import { makePlan } from './helpers';

/** a(2) -> x(3) -> b(1), delivery milestone `end`. */
const abx = () => makePlan([{ id: 'a', est: 2 }, { id: 'x', est: 3 }, { id: 'b', est: 1 }], [['a', 'x'], ['x', 'b']]);

const withProgress = (plan: Plan, id: string, progress: TaskProgress): Plan => {
  const t = plan.tasks.find((x) => x.id === id);
  if (t) t.progress = progress;
  return plan;
};

const taskDef = (id: string, estimate = 1) =>
  ({ id, moduleId: 'm', teamId: 'dev', kind: 'TASK', name: id, estimate }) as const;

const deps = (plan: Plan) => plan.dependencies.map((d) => `${d.predecessorId}>${d.successorId}`).sort();

describe('applyEffects', () => {
  it('never modifies the plan it is given', () => {
    const plan = abx();
    const before = JSON.stringify(plan);
    applyEffects(plan, [{ op: 'ADJUST_ESTIMATE', taskId: 'x', delta: 5 }]);
    expect(JSON.stringify(plan)).toBe(before);
  });

  it('applies effects in order, so later ones can use earlier ones', () => {
    const r = applyEffects(abx(), [
      { op: 'ADD_TASK', task: taskDef('n', 2), dependsOn: ['a'], blocks: [] },
      { op: 'ADD_DEPENDENCY', predecessorId: 'n', successorId: 'b' },
    ]);
    expect(deps(r.plan)).toContain('n>b');
  });

  it('names the failing effect', () => {
    const run = () =>
      applyEffects(abx(), [
        { op: 'ADJUST_ESTIMATE', taskId: 'x', delta: 1 },
        { op: 'ADJUST_ESTIMATE', taskId: 'ghost', delta: 1 },
      ]);
    expect(run).toThrow(EffectError);
    expect(run).toThrow(/Effect 2 \(ADJUST_ESTIMATE\): unknown task ghost/);
  });

  it('rejects a result that is not a valid plan', () => {
    expect(() => applyEffects(abx(), [{ op: 'ADD_DEPENDENCY', predecessorId: 'b', successorId: 'a' }])).toThrow(
      /Resulting plan is invalid.*cycle/i,
    );
  });

  describe('ADD_TASK', () => {
    it('adds the task, wires it in, and counts its effort', () => {
      const r = applyEffects(abx(), [{ op: 'ADD_TASK', task: taskDef('n', 2), dependsOn: ['a'], blocks: ['b'] }]);
      expect(r.plan.tasks.map((t) => t.id)).toContain('n');
      expect(deps(r.plan)).toEqual(expect.arrayContaining(['a>n', 'n>b']));
      expect(r.effortImpact).toBe(2);
      expect(r.touchedTaskIds).toEqual(['n']);
      expect(r.touchedModuleIds).toEqual(['m']);
    });

    it('rejects duplicate ids and unknown neighbours', () => {
      expect(() => applyEffects(abx(), [{ op: 'ADD_TASK', task: taskDef('a'), dependsOn: [], blocks: [] }])).toThrow(/already exists/);
      expect(() => applyEffects(abx(), [{ op: 'ADD_TASK', task: taskDef('n'), dependsOn: ['ghost'], blocks: [] }])).toThrow(/unknown task ghost/);
    });

    it('cannot make started work wait for new work', () => {
      const plan = withProgress(abx(), 'b', { startedOn: '2026-10-05' });
      expect(() => applyEffects(plan, [{ op: 'ADD_TASK', task: taskDef('n'), dependsOn: [], blocks: ['b'] }])).toThrow(
        /task b has already started/,
      );
    });
  });

  describe('ADJUST_ESTIMATE', () => {
    it('changes the estimate and reports the effort', () => {
      const r = applyEffects(abx(), [{ op: 'ADJUST_ESTIMATE', taskId: 'x', delta: 1.5 }]);
      expect(r.plan.tasks.find((t) => t.id === 'x')?.estimate).toBe(4.5);
      expect(r.effortImpact).toBe(1.5);
    });

    it('also changes the remaining effort of a started task', () => {
      const plan = withProgress(abx(), 'x', { startedOn: '2026-10-05', remaining: 2 });
      const x = applyEffects(plan, [{ op: 'ADJUST_ESTIMATE', taskId: 'x', delta: 1 }]).plan.tasks.find((t) => t.id === 'x');
      expect(x?.estimate).toBe(4);
      expect(x?.progress?.remaining).toBe(3);
    });

    it('treats a started task with no recorded remaining as having its whole estimate left', () => {
      const plan = withProgress(abx(), 'x', { startedOn: '2026-10-05' });
      const x = applyEffects(plan, [{ op: 'ADJUST_ESTIMATE', taskId: 'x', delta: 1 }]).plan.tasks.find((t) => t.id === 'x');
      expect(x?.progress?.remaining).toBe(4);
    });

    it('allows reductions but never below zero', () => {
      expect(applyEffects(abx(), [{ op: 'ADJUST_ESTIMATE', taskId: 'x', delta: -3 }]).plan.tasks.find((t) => t.id === 'x')?.estimate).toBe(0);
      expect(() => applyEffects(abx(), [{ op: 'ADJUST_ESTIMATE', taskId: 'x', delta: -3.5 }])).toThrow(/negative estimate/);
      const plan = withProgress(abx(), 'x', { startedOn: '2026-10-05', remaining: 1 });
      expect(() => applyEffects(plan, [{ op: 'ADJUST_ESTIMATE', taskId: 'x', delta: -2 }])).toThrow(/negative remaining/);
    });

    it('refuses to re-estimate finished work', () => {
      const plan = withProgress(abx(), 'a', { startedOn: '2026-10-05', finishedOn: '2026-10-06' });
      expect(() => applyEffects(plan, [{ op: 'ADJUST_ESTIMATE', taskId: 'a', delta: 1 }])).toThrow(/add a rework task/);
    });

    it('rejects effort on a milestone through plan validation', () => {
      expect(() => applyEffects(abx(), [{ op: 'ADJUST_ESTIMATE', taskId: 'end', delta: 1 }])).toThrow(/Milestone end must have estimate 0/);
    });
  });

  describe('REMOVE_TASK', () => {
    it('reconnects predecessors to successors and removes its effort', () => {
      const r = applyEffects(abx(), [{ op: 'REMOVE_TASK', taskId: 'x' }]);
      expect(r.plan.tasks.map((t) => t.id)).not.toContain('x');
      expect(deps(r.plan)).toEqual(expect.arrayContaining(['a>b']));
      expect(deps(r.plan).some((d) => d.includes('x'))).toBe(false);
      expect(r.effortImpact).toBe(-3);
      expect(schedule(r.plan).delivery.finish).toBe(3); // a(2) -> b(1)
    });

    it('does not duplicate an edge that already exists', () => {
      const plan = makePlan([{ id: 'a' }, { id: 'x' }, { id: 'b' }], [['a', 'x'], ['x', 'b'], ['a', 'b']]);
      expect(deps(applyEffects(plan, [{ op: 'REMOVE_TASK', taskId: 'x' }]).plan).filter((d) => d === 'a>b')).toHaveLength(1);
    });

    it('protects the delivery milestone and started work', () => {
      expect(() => applyEffects(abx(), [{ op: 'REMOVE_TASK', taskId: 'end' }])).toThrow(/delivery milestone/);
      const plan = withProgress(abx(), 'x', { startedOn: '2026-10-05' });
      expect(() => applyEffects(plan, [{ op: 'REMOVE_TASK', taskId: 'x' }])).toThrow(/already started/);
    });
  });

  describe('dependencies', () => {
    it('adds and removes edges, touching the successor', () => {
      const plan = makePlan([{ id: 'a' }, { id: 'b' }]);
      const added = applyEffects(plan, [{ op: 'ADD_DEPENDENCY', predecessorId: 'a', successorId: 'b' }]);
      expect(deps(added.plan)).toContain('a>b');
      expect(added.touchedTaskIds).toEqual(['b']);
      const removed = applyEffects(added.plan, [{ op: 'REMOVE_DEPENDENCY', predecessorId: 'a', successorId: 'b' }]);
      expect(deps(removed.plan)).not.toContain('a>b');
    });

    it('rejects duplicates, self-dependencies, missing edges and started successors', () => {
      expect(() => applyEffects(abx(), [{ op: 'ADD_DEPENDENCY', predecessorId: 'a', successorId: 'x' }])).toThrow(/already depends/);
      expect(() => applyEffects(abx(), [{ op: 'ADD_DEPENDENCY', predecessorId: 'a', successorId: 'a' }])).toThrow(/itself/);
      expect(() => applyEffects(abx(), [{ op: 'REMOVE_DEPENDENCY', predecessorId: 'a', successorId: 'b' }])).toThrow(/does not depend/);
      const plan = withProgress(makePlan([{ id: 'a' }, { id: 'b' }]), 'b', { startedOn: '2026-10-05' });
      expect(() => applyEffects(plan, [{ op: 'ADD_DEPENDENCY', predecessorId: 'a', successorId: 'b' }])).toThrow(/already started/);
    });
  });

  describe('BLOCK_UNTIL', () => {
    it('sets the earliest start, replaces it, and clears it with null', () => {
      const set = applyEffects(abx(), [{ op: 'BLOCK_UNTIL', taskId: 'a', date: '2026-10-12' }]).plan;
      expect(set.tasks.find((t) => t.id === 'a')?.startNoEarlierThan).toBe('2026-10-12');
      const moved = applyEffects(set, [{ op: 'BLOCK_UNTIL', taskId: 'a', date: '2026-10-08' }]).plan;
      expect(moved.tasks.find((t) => t.id === 'a')?.startNoEarlierThan).toBe('2026-10-08');
      const cleared = applyEffects(moved, [{ op: 'BLOCK_UNTIL', taskId: 'a', date: null }]).plan;
      expect(cleared.tasks.find((t) => t.id === 'a')?.startNoEarlierThan).toBeUndefined();
    });

    it('moves the schedule', () => {
      const blocked = applyEffects(abx(), [{ op: 'BLOCK_UNTIL', taskId: 'a', date: '2026-10-12' }]).plan;
      expect(schedule(blocked).delivery.finish).toBe(5 + 6); // starts at offset 5, then 2 + 3 + 1
    });

    it('rejects bad dates and started tasks', () => {
      expect(() => applyEffects(abx(), [{ op: 'BLOCK_UNTIL', taskId: 'a', date: '12/10/2026' }])).toThrow(/invalid date/);
      const plan = withProgress(abx(), 'a', { startedOn: '2026-10-05' });
      expect(() => applyEffects(plan, [{ op: 'BLOCK_UNTIL', taskId: 'a', date: '2026-10-12' }])).toThrow(/already started/);
    });
  });

  describe('SET_CAPACITY', () => {
    const thriveni = () => buildThriveni();

    it('adds a point, replaces one on the same date, and records the team as touched', () => {
      const first = applyEffects(thriveni(), [{ op: 'SET_CAPACITY', teamId: 'dev', from: '2026-10-14', headcount: 2 }]);
      expect(first.plan.capacity.filter((c) => c.teamId === 'dev')).toHaveLength(2);
      expect(first.touchedTeamIds).toEqual(['dev']);
      expect(first.effortImpact).toBe(0);
      const again = applyEffects(first.plan, [{ op: 'SET_CAPACITY', teamId: 'dev', from: '2026-10-14', headcount: 3 }]);
      const points = again.plan.capacity.filter((c) => c.teamId === 'dev');
      expect(points).toHaveLength(2);
      expect(points.find((c) => c.from === '2026-10-14')?.headcount).toBe(3);
    });

    it('rejects changes at or before the planned date, unknown teams, and bad values', () => {
      expect(() => applyEffects(thriveni(), [{ op: 'SET_CAPACITY', teamId: 'dev', from: '2026-10-05', headcount: 2 }])).toThrow(/after the planned headcount date/);
      expect(() => applyEffects(thriveni(), [{ op: 'SET_CAPACITY', teamId: 'dev', from: '2026-10-01', headcount: 2 }])).toThrow(/after the planned headcount date/);
      expect(() => applyEffects(thriveni(), [{ op: 'SET_CAPACITY', teamId: 'ghosts', from: '2026-10-14', headcount: 2 }])).toThrow(/unknown team/);
      expect(() => applyEffects(thriveni(), [{ op: 'SET_CAPACITY', teamId: 'dev', from: '2026-10-14', headcount: -1 }])).toThrow(/invalid headcount/);
      expect(() => applyEffects(abx(), [{ op: 'SET_CAPACITY', teamId: 'dev', from: '2026-10-14', headcount: 2 }])).toThrow(/no planned headcount/);
    });
  });

  describe('RECORD_PROGRESS', () => {
    const progressOf = (plan: Plan, id: string) => plan.tasks.find((t) => t.id === id)?.progress;
    const run = (plan: Plan, effect: Extract<Effect, { op: 'RECORD_PROGRESS' }>) => applyEffects(plan, [effect]).plan;

    it('merges fields, keeping what is not mentioned', () => {
      let plan = run(abx(), { op: 'RECORD_PROGRESS', taskId: 'x', startedOn: '2026-10-05' });
      plan = run(plan, { op: 'RECORD_PROGRESS', taskId: 'x', remaining: 2 });
      expect(progressOf(plan, 'x')).toEqual({ startedOn: '2026-10-05', remaining: 2 });
    });

    it('clears fields with null and removes empty progress', () => {
      let plan = run(abx(), { op: 'RECORD_PROGRESS', taskId: 'x', startedOn: '2026-10-05' });
      plan = run(plan, { op: 'RECORD_PROGRESS', taskId: 'x', startedOn: null });
      expect(progressOf(plan, 'x')).toBeUndefined();
    });

    it('finishing a task clears its remaining effort', () => {
      let plan = run(abx(), { op: 'RECORD_PROGRESS', taskId: 'x', startedOn: '2026-10-05', remaining: 2 });
      plan = run(plan, { op: 'RECORD_PROGRESS', taskId: 'x', finishedOn: '2026-10-07' });
      expect(progressOf(plan, 'x')).toEqual({ startedOn: '2026-10-05', finishedOn: '2026-10-07' });
    });

    it('a recorded date replaces an engine-derived offset', () => {
      const plan = withProgress(abx(), 'x', { startedAt: 3, remaining: 1 });
      expect(progressOf(run(plan, { op: 'RECORD_PROGRESS', taskId: 'x', startedOn: '2026-10-08' }), 'x')).toEqual({
        startedOn: '2026-10-08',
        remaining: 1,
      });
    });

    it('rejects remaining effort without a start, bad dates and negative effort', () => {
      expect(() => run(abx(), { op: 'RECORD_PROGRESS', taskId: 'x', remaining: 2 })).toThrow(/needs a start date/);
      expect(() => run(abx(), { op: 'RECORD_PROGRESS', taskId: 'x', startedOn: 'yesterday' })).toThrow(/invalid startedOn/);
      expect(() => run(abx(), { op: 'RECORD_PROGRESS', taskId: 'x', startedOn: '2026-10-05', remaining: -1 })).toThrow(/invalid remaining/);
    });
  });

  describe('TRANSFER_OWNER', () => {
    it('sets the owner; a context cost becomes extra effort', () => {
      const r = applyEffects(abx(), [{ op: 'TRANSFER_OWNER', taskId: 'x', toPersonId: 'dev-b', contextCost: 1 }]);
      const x = r.plan.tasks.find((t) => t.id === 'x');
      expect(x?.ownerId).toBe('dev-b');
      expect(x?.estimate).toBe(4);
      expect(r.effortImpact).toBe(1);
    });

    it('adds the cost to remaining effort when the task is under way', () => {
      const plan = withProgress(abx(), 'x', { startedOn: '2026-10-05', remaining: 2 });
      const x = applyEffects(plan, [{ op: 'TRANSFER_OWNER', taskId: 'x', toPersonId: 'dev-b', contextCost: 0.5 }]).plan.tasks.find((t) => t.id === 'x');
      expect(x?.progress?.remaining).toBe(2.5);
    });

    it('is free without a cost, and refused for finished work', () => {
      expect(applyEffects(abx(), [{ op: 'TRANSFER_OWNER', taskId: 'x', toPersonId: 'dev-b' }]).effortImpact).toBe(0);
      const plan = withProgress(abx(), 'a', { startedOn: '2026-10-05', finishedOn: '2026-10-06' });
      expect(() => applyEffects(plan, [{ op: 'TRANSFER_OWNER', taskId: 'a', toPersonId: 'dev-b' }])).toThrow(/already finished/);
    });
  });
});
