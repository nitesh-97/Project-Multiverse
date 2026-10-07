import { describe, expect, it } from 'vitest';
import { buildControlRoom, buildThriveni, recordEvent, startProject } from '../src';
import type { Event, ProjectState } from '../src';
import { adjust, makeEvent } from './helpers';

const fresh = () => startProject(buildThriveni());
const run = (...events: Event[]): ProjectState => events.reduce(recordEvent, fresh());

// Wed 14 Oct = offset 8. Nothing has been reported, so the forecast carries the plan forward: every task that should
// be under way by then is taken to be.
const noop = () => makeEvent('noop', '2026-10-14', []);

const ids = (list: Array<{ taskId: string }>) => list.map((t) => t.taskId);

describe('the control room at the start', () => {
  const cr = buildControlRoom(fresh());

  it('is on plan, with nothing done', () => {
    expect(cr.asOf).toBeNull();
    expect(cr.original).toEqual({ offset: 20, date: '2026-10-30' });
    expect(cr.plan).toEqual({ offset: 20, date: '2026-10-30' });
    expect(cr.forecast).toEqual({ offset: 20, date: '2026-10-30' });
    expect(cr.variance).toBe(0);
    expect(cr.progress).toEqual({ doneEffort: 0, totalEffort: 97, percent: 0, confirmedPercent: 0 });
    expect(cr.firstBreach).toBeNull();
  });

  it('counts effort, not tasks: 97 work-days across the seven modules, shared systems and the project', () => {
    // m1..m7 = 10+9+12+11+13+10+11 = 76, shared = 4+3+5 = 12, project = 1+2+1+1+1+2+1 = 9. Milestones weigh nothing.
    expect(cr.progress.totalEffort).toBe(97);
    expect(cr.modules.map((m) => [m.moduleId, m.totalEffort])).toEqual([
      ['m1', 10], ['m2', 9], ['m3', 12], ['m4', 11], ['m5', 13], ['m6', 10], ['m7', 11], ['shared', 12], ['project', 9],
    ]);
  });

  it('names the pace-setting task: the first step of the 20-day critical path', () => {
    expect(cr.bottleneck.current?.taskId).toBe('m5.sb');
    expect(ids(cr.bottleneck.chain)).toEqual([
      'm5.sb', 'm5.art', 'm5.dev', 'm5.alpha', 'proj.review', 'proj.chg.dev', 'proj.integration', 'proj.qa', 'proj.beta', 'proj.delivery',
    ]);
    expect(cr.bottleneck.chain.every((t) => t.totalFloat === 0)).toBe(true);
  });

  it('has one trend point, the baseline', () => {
    expect(cr.trend).toHaveLength(1);
  });
});

describe('the control room part-way through, with nothing reported', () => {
  const cr = buildControlRoom(run(noop()));

  it('says how far along the plan says we are: 68 of 97 work-days', () => {
    // At offset 8 every module has done 8 days of its single chain (storyboard and art, then some development):
    // 7 modules x 8 = 56, plus the shared work, which has all finished (menu 4, localization 3, evaluation 5 = 12).
    expect(cr.progress.doneEffort).toBe(68);
    expect(cr.progress.percent).toBe(70.1);
  });

  it('says none of it is confirmed: it is the forecast taking the plan on trust', () => {
    expect(cr.progress.confirmedPercent).toBe(0);
    expect(cr.modules.every((m) => m.confirmedPercent === 0)).toBe(true);
  });

  it('gives module progress: M5 has finished storyboard and art (7) and one day of development', () => {
    const m5 = cr.modules.find((m) => m.moduleId === 'm5');
    expect(m5).toMatchObject({ doneEffort: 8, totalEffort: 13, percent: 61.5, openTasks: 1, variance: 0 });
    expect(m5?.baselineFinish).toEqual({ offset: 13, date: '2026-10-21' });
    expect(m5?.forecastFinish).toEqual({ offset: 13, date: '2026-10-21' });
  });

  it('puts the pace on M5 development, with the finished work left off the chain', () => {
    expect(cr.bottleneck.current).toMatchObject({ taskId: 'm5.dev', state: 'IN_PROGRESS', totalFloat: 0, teamId: 'dev' });
    expect(ids(cr.bottleneck.chain)).toEqual([
      'm5.dev', 'm5.alpha', 'proj.review', 'proj.chg.dev', 'proj.integration', 'proj.qa', 'proj.beta', 'proj.delivery',
    ]);
  });

  it('watches what is closest to becoming critical: least float first, then earliest finish, then id', () => {
    // M3 has 1 day (12 against 13), the client changes in art and LXD each have 1 (15 against 16), M4 and M7 have 2.
    expect(cr.bottleneck.watchlist.map((t) => [t.taskId, t.totalFloat])).toEqual([
      ['m3.dev', 1], ['proj.chg.art', 1], ['proj.chg.lxd', 1], ['m4.dev', 2], ['m7.dev', 2],
    ]);
    expect(cr.bottleneck.next?.taskId).toBe('m3.dev');
  });

  it('leaves finished and milestone tasks off the watch list', () => {
    const watched = ids(cr.bottleneck.watchlist);
    expect(watched.some((id) => id.endsWith('.alpha') || id === 'proj.delivery')).toBe(false);
    expect(watched).not.toContain('shared.menu');
  });

  it('honours the options', () => {
    const wide = buildControlRoom(run(noop()), { watchFloat: 3 });
    expect(ids(wide.bottleneck.watchlist)).toContain('m1.dev'); // 3 days of float
    const narrow = buildControlRoom(run(noop()), { watchFloat: 5, watchLimit: 2 });
    expect(narrow.bottleneck.watchlist).toHaveLength(2);
    const none = buildControlRoom(run(noop()), { watchFloat: 0 });
    expect(none.bottleneck.watchlist).toEqual([]);
    expect(none.bottleneck.next).toBeNull();
  });
});

describe('the control room after a slip', () => {
  // M5 development +1 day: the critical path is now 21 days.
  const slipped = run(makeEvent('m5+1', '2026-10-14', [adjust('m5.dev', 1)], { type: 'DEPENDENCY_DELAY' }));
  const cr = buildControlRoom(slipped);

  it('reports the delay against the plan and the original separately', () => {
    expect(cr.original).toEqual({ offset: 20, date: '2026-10-30' });
    expect(cr.plan).toEqual({ offset: 20, date: '2026-10-30' });
    expect(cr.forecast).toEqual({ offset: 21, date: '2026-11-02' });
    expect(cr.variance).toBe(1);
  });

  it('lets progress fall when scope grows: the same 68 days of work out of 98', () => {
    expect(cr.progress).toMatchObject({ doneEffort: 68, totalEffort: 98, percent: 69.4 });
    expect(cr.modules.find((m) => m.moduleId === 'm5')).toMatchObject({ doneEffort: 8, totalEffort: 14, percent: 57.1, variance: 1 });
  });

  it('records when the plan was first breached', () => {
    expect(cr.firstBreach).not.toBeNull();
  });

  it('gives the trend, one point per forecast', () => {
    expect(cr.trend).toHaveLength(2);
  });
});

describe('confirmed progress', () => {
  it('counts what someone recorded, and only that', () => {
    // The forecast already assumed one day of M5 development; recording it makes that one day confirmed, 1 of 97.
    const recorded = run(
      makeEvent('m5-status', '2026-10-14', [{ op: 'RECORD_PROGRESS', taskId: 'm5.dev', startedOn: '2026-10-14', remaining: 5 }], { type: 'TASK_DELAY' }),
    );
    const cr = buildControlRoom(recorded);
    expect(cr.progress.percent).toBe(70.1);
    expect(cr.progress.confirmedPercent).toBe(1);
    expect(cr.modules.find((m) => m.moduleId === 'm5')).toMatchObject({ percent: 61.5, confirmedPercent: 7.7 });
  });
});

describe('a finished project', () => {
  it('has nothing left on the chain or the watch list, and is fully done', () => {
    const cr = buildControlRoom(run(makeEvent('end', '2026-11-02', [])));
    expect(cr.progress.percent).toBe(100);
    expect(cr.bottleneck.current).toBeNull();
    expect(cr.bottleneck.chain).toEqual([]);
    expect(cr.bottleneck.watchlist).toEqual([]);
    expect(cr.bottleneck.next).toBeNull();
    expect(cr.modules.every((m) => m.openTasks === 0)).toBe(true);
  });
});
