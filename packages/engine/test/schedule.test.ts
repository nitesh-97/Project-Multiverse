import { describe, expect, it } from 'vitest';
import { PlanError, schedule } from '../src';
import { makePlan } from './helpers';

describe('schedule: critical path method', () => {
  it('schedules a chain end to end', () => {
    const s = schedule(
      makePlan([{ id: 'a', est: 3 }, { id: 'b', est: 2 }, { id: 'c', est: 1 }], [['a', 'b'], ['b', 'c']]),
    );
    expect([s.tasks.a?.start, s.tasks.a?.finish]).toEqual([0, 3]);
    expect([s.tasks.b?.start, s.tasks.b?.finish]).toEqual([3, 5]);
    expect([s.tasks.c?.start, s.tasks.c?.finish]).toEqual([5, 6]);
    expect(s.delivery.finish).toBe(6);
    expect(s.delivery.date).toBe('2026-10-12'); // 6th working day is the following Monday
    expect(s.tasks.b?.startDate).toBe('2026-10-08');
    expect(s.tasks.b?.finishDate).toBe('2026-10-09');
    expect(s.tasks.c?.startDate).toBe('2026-10-12');
    expect(s.criticalPath).toEqual(['a', 'b', 'c', 'end']);
  });

  it('computes float on a diamond', () => {
    //  a(2) -> b(4) -> d(1)
    //  a(2) -> c(1) -> d(1)
    const s = schedule(
      makePlan(
        [{ id: 'a', est: 2 }, { id: 'b', est: 4 }, { id: 'c', est: 1 }, { id: 'd', est: 1 }],
        [['a', 'b'], ['a', 'c'], ['b', 'd'], ['c', 'd']],
      ),
    );
    expect(s.delivery.finish).toBe(7);
    expect(s.tasks.c?.finish).toBe(3);
    expect(s.tasks.c?.totalFloat).toBe(3);
    expect(s.tasks.c?.freeFloat).toBe(3);
    expect(s.tasks.b?.totalFloat).toBe(0);
    expect(s.criticalPath).toEqual(['a', 'b', 'd', 'end']);
    expect(s.drivingChain).toEqual(['a', 'b', 'd', 'end']);
    expect(s.tasks.d?.drivingPredecessor).toBe('b');
  });

  it('distinguishes free float from total float', () => {
    // Critical: long(4). Side chain: s1(1) -> s2(1). Delivery is at 4, so the side chain has 2 days to spend.
    const s = schedule(makePlan([{ id: 'long', est: 4 }, { id: 's1' }, { id: 's2' }], [['s1', 's2']]));
    expect(s.delivery.finish).toBe(4);
    // s1 can slip 2 days in total, but any slip at all delays s2's start, so its free float is 0.
    expect(s.tasks.s1?.totalFloat).toBe(2);
    expect(s.tasks.s1?.freeFloat).toBe(0);
    // s2 feeds only the delivery milestone, so total and free float agree.
    expect(s.tasks.s2?.totalFloat).toBe(2);
    expect(s.tasks.s2?.freeFloat).toBe(2);
    expect(s.tasks.long?.critical).toBe(true);
    expect(s.tasks.s1?.critical).toBe(false);
  });

  it('reports every task on tied critical paths and picks the first-declared driver', () => {
    const s = schedule(makePlan([{ id: 'a', est: 2 }, { id: 'b', est: 2 }, { id: 'c' }], [['a', 'c'], ['b', 'c']]));
    expect(s.criticalPath).toEqual(['a', 'b', 'c', 'end']);
    expect(s.tasks.c?.drivingPredecessor).toBe('a');
  });

  it('handles fractional days without floating-point noise', () => {
    const s = schedule(makePlan([{ id: 'a', est: 0.1 }, { id: 'b', est: 0.2 }], [['a', 'b']]));
    expect(s.tasks.b?.finish).toBe(0.3);
    const half = schedule(makePlan([{ id: 'a', est: 0.5 }, { id: 'b', est: 1.5 }], [['a', 'b']]));
    expect(half.tasks.b?.start).toBe(0.5);
    expect(half.tasks.b?.finish).toBe(2);
    expect(half.tasks.b?.startDate).toBe('2026-10-05');
    expect(half.tasks.b?.finishDate).toBe('2026-10-06');
  });

  it('gives a milestone the date of its last predecessor', () => {
    const s = schedule(makePlan([{ id: 'a', est: 5 }]));
    expect(s.tasks.end?.duration).toBe(0);
    expect(s.delivery.date).toBe('2026-10-09');
    expect(s.tasks.end?.startDate).toBe('2026-10-09');
  });

  it('summarises each module by its last task', () => {
    const s = schedule(makePlan([{ id: 'a', est: 2 }, { id: 'b', est: 3 }], [['a', 'b']]));
    expect(s.modules.m?.finish).toBe(5);
    expect(s.modules.m?.finishDate).toBe('2026-10-09');
  });

  it('is deterministic and does not modify the plan', () => {
    const plan = makePlan([{ id: 'a', est: 2 }, { id: 'b' }], [['a', 'b']]);
    const before = JSON.stringify(plan);
    expect(schedule(plan)).toEqual(schedule(plan));
    expect(JSON.stringify(plan)).toBe(before);
  });
});

describe('schedule: capacity', () => {
  const dev = (from: string, headcount: number) => ({ teamId: 'dev', from, headcount });

  it('slows work down when headcount drops part-way through a task', () => {
    // Planned 4, drops to 2 from Wed 7 Oct (offset 2). 2 days done at full speed, 3 left at 0.5 -> 6 days.
    const s = schedule(makePlan([{ id: 'a', est: 5 }], [], { capacity: [dev('2026-10-05', 4), dev('2026-10-07', 2)] }));
    expect(s.tasks.a?.finish).toBe(8);
    expect(s.tasks.a?.duration).toBe(8);
    expect(s.tasks.a?.finishDate).toBe('2026-10-14');
  });

  it('speeds work up when headcount rises', () => {
    // Planned 2, rises to 4 from Tue 6 Oct (offset 1): 1 day done, 4 left at factor 2 -> 2 days.
    const s = schedule(makePlan([{ id: 'a', est: 5 }], [], { capacity: [dev('2026-10-05', 2), dev('2026-10-06', 4)] }));
    expect(s.tasks.a?.finish).toBe(3);
  });

  it('pauses work while a team has no capacity and resumes afterwards', () => {
    // Planned 2; zero from offset 1; back to 2 from offset 3. 3 days of work: 1 done, 2 more after the gap -> 5.
    const s = schedule(
      makePlan([{ id: 'a', est: 3 }], [], {
        capacity: [dev('2026-10-05', 2), dev('2026-10-06', 0), dev('2026-10-08', 2)],
      }),
    );
    expect(s.tasks.a?.finish).toBe(5);
  });

  it('refuses to schedule work for a team that never gets capacity back', () => {
    const plan = makePlan([{ id: 'a', est: 3 }], [], { capacity: [dev('2026-10-05', 2), dev('2026-10-06', 0)] });
    expect(() => schedule(plan)).toThrow(/no capacity/);
  });

  it('applies the capacity in force when a successor starts', () => {
    // a(1) -> b(2); dev halves from offset 1, so b (starting at 1) takes 4 days.
    const s = schedule(
      makePlan([{ id: 'a', est: 1 }, { id: 'b', est: 2 }], [['a', 'b']], {
        capacity: [dev('2026-10-05', 4), dev('2026-10-06', 2)],
      }),
    );
    expect(s.tasks.a?.finish).toBe(1);
    expect(s.tasks.b?.finish).toBe(5);
  });

  it('does not affect other teams and accepts unsorted capacity rows', () => {
    const s = schedule(
      makePlan([{ id: 'a', est: 4 }, { id: 'b', est: 4, team: 'art' }], [], {
        capacity: [dev('2026-10-05', 4), dev('2026-10-06', 2)].reverse(),
      }),
    );
    expect(s.tasks.b?.finish).toBe(4);
    expect(s.tasks.a?.finish).toBe(7); // 1 day at full + 3 left at 0.5 -> 6 more
  });

  it('treats a team with no capacity rows as full capacity', () => {
    expect(schedule(makePlan([{ id: 'a', est: 4 }])).tasks.a?.finish).toBe(4);
  });
});

describe('schedule: actuals and status date', () => {
  const chain = (a: Parameters<typeof makePlan>[0][number]) => makePlan([a, { id: 'b', est: 2 }], [['a', 'b']]);

  it('re-forecasts an in-progress task from its remaining effort', () => {
    // Tue 6 Oct close of business: a (3d) started Mon with 1 day left.
    const s = schedule(chain({ id: 'a', est: 3, progress: { startedOn: '2026-10-05', remaining: 1 } }), '2026-10-06');
    expect(s.statusOffset).toBe(2);
    expect(s.tasks.a?.state).toBe('IN_PROGRESS');
    expect(s.tasks.a?.start).toBe(0);
    expect(s.tasks.a?.finish).toBe(3);
    expect(s.tasks.b?.state).toBe('NOT_STARTED');
    expect([s.tasks.b?.start, s.tasks.b?.finish]).toEqual([3, 5]);
  });

  it('uses actual dates for finished tasks', () => {
    const s = schedule(
      chain({ id: 'a', est: 3, progress: { startedOn: '2026-10-05', finishedOn: '2026-10-07' } }),
      '2026-10-07',
    );
    expect(s.tasks.a?.state).toBe('DONE');
    expect([s.tasks.a?.start, s.tasks.a?.finish]).toEqual([0, 3]);
    expect([s.tasks.b?.start, s.tasks.b?.finish]).toEqual([3, 5]);
  });

  it('pulls successors forward when a predecessor finishes early', () => {
    const s = schedule(
      chain({ id: 'a', est: 3, progress: { startedOn: '2026-10-05', finishedOn: '2026-10-06' } }),
      '2026-10-06',
    );
    expect(s.tasks.b?.finish).toBe(4);
    expect(s.delivery.finish).toBe(4);
  });

  it('pushes successors back when a task overruns', () => {
    const s = schedule(chain({ id: 'a', est: 3, progress: { startedOn: '2026-10-05', remaining: 4 } }), '2026-10-06');
    expect(s.tasks.a?.finish).toBe(6);
    expect(s.tasks.b?.finish).toBe(8);
  });

  it('never plans unstarted work in the past', () => {
    const s = schedule(makePlan([{ id: 'x', est: 2 }]), '2026-10-08'); // end of day 4
    expect([s.tasks.x?.start, s.tasks.x?.finish]).toEqual([4, 6]);
  });

  it('treats a weekend status date as the end of the previous working day', () => {
    expect(schedule(makePlan([{ id: 'x' }]), '2026-10-10').statusOffset).toBe(5);
  });

  it('records a finished milestone', () => {
    const plan = makePlan([{ id: 'a' }]);
    const gate = plan.tasks.find((t) => t.id === 'end');
    if (gate) gate.progress = { finishedOn: '2026-10-05' };
    const s = schedule(plan, '2026-10-05');
    expect(s.tasks.end?.state).toBe('DONE');
    expect(s.delivery.finish).toBe(1);
  });

  it('rejects inconsistent actuals', () => {
    expect(() => schedule(makePlan([{ id: 'a', progress: { startedOn: '2026-10-05' } }]))).toThrow(/no asOf/);
    expect(() =>
      schedule(makePlan([{ id: 'a', progress: { startedOn: '2026-10-05', finishedOn: '2026-10-09' } }]), '2026-10-07'),
    ).toThrow(/after the status date/);
    expect(() => schedule(makePlan([{ id: 'a', progress: { startedOn: '2026-10-09' } }]), '2026-10-07')).toThrow(
      /after the status date/,
    );
    expect(() =>
      schedule(makePlan([{ id: 'a', progress: { startedOn: '2026-10-07', finishedOn: '2026-10-06' } }]), '2026-10-07'),
    ).toThrow(/before it started/);
  });
});

describe('schedule: start constraints', () => {
  it('honours startNoEarlierThan', () => {
    const s = schedule(makePlan([{ id: 'x', est: 2, startNoEarlierThan: '2026-10-12' }]));
    expect([s.tasks.x?.start, s.tasks.x?.finish]).toEqual([5, 7]);
    expect(s.tasks.x?.drivingPredecessor).toBeNull();
  });

  it('maps a weekend constraint to the next working day', () => {
    const s = schedule(makePlan([{ id: 'x', est: 1, startNoEarlierThan: '2026-10-10' }]));
    expect(s.tasks.x?.start).toBe(5);
  });

  it('does not let a constraint hide a later predecessor', () => {
    const s = schedule(
      makePlan([{ id: 'a', est: 8 }, { id: 'x', est: 1, startNoEarlierThan: '2026-10-12' }], [['a', 'x']]),
    );
    expect(s.tasks.x?.start).toBe(8);
    expect(s.tasks.x?.drivingPredecessor).toBe('a');
  });
});

describe('schedule: validation', () => {
  it('reports every structural problem at once', () => {
    const plan = makePlan([{ id: 'a' }, { id: 'b' }], [['a', 'b']]);
    plan.tasks[0]!.moduleId = 'nope';
    plan.tasks[1]!.teamId = 'ghosts';
    plan.tasks[1]!.estimate = -1;
    let error: unknown;
    try {
      schedule(plan);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(PlanError);
    expect((error as PlanError).issues).toHaveLength(3);
  });

  it('rejects cycles, self-dependencies and duplicate dependencies', () => {
    expect(() => schedule(makePlan([{ id: 'a' }, { id: 'b' }], [['a', 'b'], ['b', 'a']]))).toThrow(/cycle/i);
    expect(() => schedule(makePlan([{ id: 'a' }], [['a', 'a']]))).toThrow(/depends on itself/);
    expect(() => schedule(makePlan([{ id: 'a' }, { id: 'b' }], [['a', 'b'], ['a', 'b']]))).toThrow(/Duplicate dependencies/);
  });

  it('rejects unknown references and duplicate ids', () => {
    expect(() => schedule(makePlan([{ id: 'a' }], [['a', 'ghost']]))).toThrow(/unknown task ghost/);
    expect(() => schedule(makePlan([{ id: 'a' }, { id: 'a' }]))).toThrow(/Duplicate task ids/);
  });

  it('requires a proper delivery milestone', () => {
    const notMilestone = makePlan([{ id: 'a' }]);
    notMilestone.deliveryTaskId = 'a';
    expect(() => schedule(notMilestone)).toThrow(/must be a milestone/);

    const missing = makePlan([{ id: 'a' }]);
    missing.deliveryTaskId = 'ghost';
    expect(() => schedule(missing)).toThrow(/does not exist/);

    const withSuccessor = makePlan([{ id: 'a' }]);
    withSuccessor.tasks.push({ id: 'after', moduleId: 'm', teamId: 'dev', kind: 'TASK', name: 'after', estimate: 1 });
    withSuccessor.dependencies.push({ predecessorId: 'end', successorId: 'after', type: 'FS' });
    expect(() => schedule(withSuccessor)).toThrow(/must not have successors/);
  });

  it('rejects milestones with effort and a team with no planned headcount', () => {
    const plan = makePlan([{ id: 'a' }]);
    plan.tasks.find((t) => t.id === 'end')!.estimate = 1;
    expect(() => schedule(plan)).toThrow(/must have estimate 0/);

    const noHeads = makePlan([{ id: 'a' }], [], { capacity: [{ teamId: 'dev', from: '2026-10-05', headcount: 0 }] });
    expect(() => schedule(noHeads)).toThrow(/planned \(earliest\) headcount/);
  });
});
