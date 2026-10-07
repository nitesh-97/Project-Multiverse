import { describe, expect, it } from 'vitest';
import { buildRetro, buildThriveni, recordEvent, recordPlanEdit, startProject } from '../src';
import type { Event, ProjectState } from '../src';
import { adjust, holiday, makeEvent, makePlanEdit, sharedExtinguisherEffects } from './helpers';

const fresh = () => startProject(buildThriveni());
const run = (...events: Event[]): ProjectState => events.reduce(recordEvent, fresh());

// Status dates: Mon 5 Oct = offset 1, Tue 6 Oct = 2, Wed 14 Oct = 8, Fri 16 Oct = 10, Mon 19 Oct = 11.
const feedback = (id: string, asOf: string, phase: Event['phase'], team: string, type: Event['type'] = 'FEEDBACK') =>
  makeEvent(id, asOf, [], { type, phase, sourceTeamId: team });

describe('the retro of a project that has just started', () => {
  const retro = buildRetro(fresh());

  it('is in progress, with the plan as the outcome', () => {
    expect(retro.status).toBe('IN_PROGRESS');
    expect(retro.planned).toEqual({ delivery: { offset: 20, date: '2026-10-30' }, workingDays: 20 });
    expect(retro.outcome).toEqual({ delivery: { offset: 20, date: '2026-10-30' }, workingDays: 20, variance: 0 });
  });

  it('has nothing to report', () => {
    expect(retro.feedback).toEqual({ total: 0, byPhase: [], afterDevelopment: { count: 0, percent: 0 }, bySourceTeam: [] });
    expect(retro.scope).toEqual({ changes: 0, afterDevelopmentStarted: 0, effortDays: 0, scheduleDays: 0 });
    expect(retro.rework).toEqual({ count: 0, effortDays: 0, scheduleDays: 0 });
    expect(retro.planning).toEqual({ edits: 0, planMovedDays: 0 });
    expect(retro.couldHaveBeenEarlier).toEqual({ flagged: 0, of: 0 });
    expect(retro.ownership).toEqual({ transfers: [], tasksTransferred: 0 });
    expect(retro.observations).toEqual([]);
  });

  it('carries both ways of dividing the delay, which agree that there is none', () => {
    expect(retro.contributors.sequential.strategy).toBe('sequential');
    expect(retro.contributors.counterfactual.strategy).toBe('counterfactual');
    expect(retro.contributors.sequential.totalVariance).toBe(0);
    expect(retro.contributors.counterfactual.contributions).toEqual([]);
  });
});

describe('when feedback arrived', () => {
  // One in development, one in alpha, one in QA: two of three came once development had finished.
  const retro = buildRetro(
    run(
      feedback('f1', '2026-10-13', 'DEVELOPMENT', 'lxd', 'CLIENT_FEEDBACK'),
      feedback('f2', '2026-10-14', 'ALPHA', 'lxd'),
      feedback('f3', '2026-10-15', 'QA', 'art'),
      makeEvent('other', '2026-10-15', [], { type: 'BLOCKER', phase: 'QA', sourceTeamId: 'art' }),
    ),
  );

  it('counts feedback only, by phase in project order, leaving out phases with none', () => {
    expect(retro.feedback.total).toBe(3);
    expect(retro.feedback.byPhase).toEqual([
      { phase: 'DEVELOPMENT', count: 1, percent: 33.3 },
      { phase: 'ALPHA', count: 1, percent: 33.3 },
      { phase: 'QA', count: 1, percent: 33.3 },
    ]);
  });

  it('gives the share that came after development had finished', () => {
    expect(retro.feedback.afterDevelopment).toEqual({ count: 2, percent: 66.7 });
  });

  it('splits by the team it came from', () => {
    expect(retro.feedback.bySourceTeam).toEqual([
      { teamId: 'lxd', total: 2, afterDevelopmentPercent: 50 },
      { teamId: 'art', total: 1, afterDevelopmentPercent: 100 },
    ]);
  });

  it('says so in plain language', () => {
    expect(retro.observations).toContain('66.7% of feedback (2 of 3) arrived after development had finished');
  });
});

describe('scope that arrived late', () => {
  // The extinguisher, found in development: one shared 2-day effort on the critical path to delivery.
  const late = makeEvent('ext', '2026-10-14', sharedExtinguisherEffects(), {
    type: 'SCOPE_CHANGE',
    phase: 'DEVELOPMENT',
    linkedFeatureId: 'extinguisher',
    couldHaveBeenEarlier: true,
  });
  const retro = buildRetro(run(late));

  it('is counted, with its effort and its days', () => {
    expect(retro.scope).toEqual({ changes: 1, afterDevelopmentStarted: 1, effortDays: 2, scheduleDays: 2 });
    expect(retro.outcome.variance).toBe(2);
  });

  it('is on the record as something that could have been found earlier', () => {
    expect(retro.couldHaveBeenEarlier).toEqual({ flagged: 1, of: 1 });
  });

  it('is explained in plain language', () => {
    expect(retro.observations).toEqual([
      '1 requirement discovered after development had started',
      '1 of 1 event could have been identified earlier',
      'The largest contributor to delay was Late scope discovery (+2 working days)',
      '1 common feature (Extinguisher) identified only after development had started',
    ]);
  });

  it('is not late scope when it is found before development begins', () => {
    const early = buildRetro(run(makeEvent('ext', '2026-10-06', sharedExtinguisherEffects(), { type: 'SCOPE_CHANGE', phase: 'STORYBOARD', linkedFeatureId: 'extinguisher' })));
    expect(early.scope).toMatchObject({ changes: 1, afterDevelopmentStarted: 0 });
    expect(early.observations.join('\n')).not.toContain('discovered after development');
    expect(early.observations.join('\n')).not.toContain('common feature');
  });
});

describe('the other kinds of change', () => {
  const retro = buildRetro(
    run(
      // A public holiday on Mon 26 Oct: a working day lost, on the critical path.
      makeEvent('hol', '2026-10-14', [holiday('2026-10-26')], { type: 'RESOURCE_CHANGE', phase: 'DEVELOPMENT' }),
      // M5 development re-done for a day.
      makeEvent('redo', '2026-10-14', [adjust('m5.dev', 1)], { type: 'REWORK', phase: 'DEVELOPMENT' }),
      // Handing M3 development over costs half a day of catching up. M3 has a day of float, so delivery does not move.
      makeEvent('hand', '2026-10-14', [{ op: 'TRANSFER_OWNER', taskId: 'm3.dev', toPersonId: 'asha', contextCost: 0.5 }], {
        type: 'OWNERSHIP_TRANSFER',
        phase: 'DEVELOPMENT',
      }),
      makeEvent('block', '2026-10-14', [], { type: 'DEPENDENCY_DELAY', phase: 'DEVELOPMENT' }),
    ),
  );

  it('counts resources and calendar', () => {
    expect(retro.resources).toEqual({ changes: 1, scheduleDays: 1 });
  });

  it('counts rework in effort and in days', () => {
    expect(retro.rework).toEqual({ count: 1, effortDays: 1, scheduleDays: 1 });
  });

  it('counts dependency delays', () => {
    expect(retro.dependencies).toEqual({ count: 1, scheduleDays: 0 });
  });

  it('keeps a history of who tasks moved between, and what it cost', () => {
    expect(retro.ownership).toEqual({
      transfers: [{ eventId: 'hand', asOf: '2026-10-14', taskId: 'm3.dev', moduleId: 'm3', toPersonId: 'asha', contextCost: 0.5 }],
      tasksTransferred: 1,
    });
  });

  it('reports each in plain language, with correct singular and plural', () => {
    expect(retro.observations).toContain('1 capacity or calendar change moved delivery by +1 working day');
    expect(retro.observations).toContain('1 rework or defect event added 1 work-days of effort');
    expect(retro.observations).toContain('1 task transferred between people');
  });

  it('shows the same total delay however it is shared out', () => {
    const { sequential, counterfactual } = retro.contributors;
    expect(sequential.totalVariance).toBe(retro.outcome.variance);
    expect(counterfactual.totalVariance).toBe(retro.outcome.variance);
    const shared = (a: typeof sequential) => a.contributions.reduce((s, c) => s + c.days, 0) + a.interaction;
    expect(shared(sequential)).toBeCloseTo(retro.outcome.variance, 6);
    expect(shared(counterfactual)).toBeCloseTo(retro.outcome.variance, 6);
  });
});

describe('planning changes are not delay', () => {
  // M7 development re-estimated from 5 to 8 days before M7 starts: the plan itself gets a day longer.
  const edit = makePlanEdit('longer-m7', '2026-10-06', [adjust('m7.dev', 3) as never], { title: 'M7 dev re-estimated' });
  const retro = buildRetro(recordPlanEdit(fresh(), edit));

  it('moves the plan but not the outcome against it', () => {
    expect(retro.planned.delivery).toEqual({ offset: 20, date: '2026-10-30' });
    expect(retro.planning).toEqual({ edits: 1, planMovedDays: 1 });
    expect(retro.outcome).toEqual({ delivery: { offset: 21, date: '2026-11-02' }, workingDays: 21, variance: 0 });
  });

  it('says so, and does not count it as scope', () => {
    expect(retro.scope.changes).toBe(0);
    expect(retro.observations).toContain('1 planning change moved the plan by +1 working day (planning, not delay)');
  });
});

describe('a delivered project', () => {
  it('is delivered once the delivery milestone has been reached', () => {
    const retro = buildRetro(run(makeEvent('end', '2026-11-02', [])));
    expect(retro.status).toBe('DELIVERED');
    expect(retro.asOf).toBe('2026-11-02');
  });

  it('is still in progress the day before', () => {
    expect(buildRetro(run(makeEvent('almost', '2026-10-29', []))).status).toBe('IN_PROGRESS');
  });
});
