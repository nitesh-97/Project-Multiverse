import { describe, expect, it } from 'vitest';
import { PlanError, buildThriveni, findAdvisories, startProject } from '../src';
import type { Plan } from '../src';

const feature = (plan: Plan, id: string) => {
  const f = plan.features?.find((x) => x.id === id);
  if (!f) throw new Error(`no feature ${id}`);
  return f;
};

describe('common feature detection', () => {
  it('flags the extinguisher on Thriveni: seven modules, no shared task (spec §28 step 3)', () => {
    const found = findAdvisories(buildThriveni());
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      rule: 'COMMON_FEATURE_WITHOUT_SHARED_TASK',
      severity: 'ADVISORY',
      featureId: 'extinguisher',
      featureName: 'Extinguisher',
      moduleIds: ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7'],
    });
    expect(found[0]?.message).toBe(
      'Common feature detected: Extinguisher is used by 7 modules but has no shared implementation task.',
    );
    expect(found[0]?.recommendation).toBe('Plan a shared implementation before individual module integration.');
  });

  it('does not flag features that already have a shared task', () => {
    const ids = findAdvisories(buildThriveni()).map((a) => a.featureId);
    expect(ids).not.toContain('localization');
    expect(ids).not.toContain('evaluation');
    expect(ids).not.toContain('menu-ui');
  });

  it('is cleared by planning a shared implementation', () => {
    const plan = buildThriveni();
    plan.tasks.push({ id: 'shared.ext', moduleId: 'shared', teamId: 'dev', kind: 'TASK', name: 'Extinguisher system', estimate: 2 });
    feature(plan, 'extinguisher').sharedTaskId = 'shared.ext';
    expect(findAdvisories(plan)).toEqual([]);
  });

  it('respects the threshold for what counts as common', () => {
    const plan = buildThriveni();
    feature(plan, 'extinguisher').moduleIds = ['m1', 'm2'];
    expect(findAdvisories(plan)).toHaveLength(1); // default threshold is 2
    expect(findAdvisories(plan, { commonFeatureMinModules: 3 })).toEqual([]);
    feature(plan, 'extinguisher').moduleIds = ['m1'];
    expect(findAdvisories(plan)).toEqual([]);
  });

  it('also counts modules whose tasks implement the feature', () => {
    const plan = buildThriveni();
    plan.features = [{ id: 'x', name: 'Scoreboard', moduleIds: [] }];
    for (const m of ['m1', 'm2', 'm3']) {
      const task = plan.tasks.find((t) => t.id === `${m}.dev`);
      if (task) task.featureId = 'x';
    }
    expect(findAdvisories(plan)[0]).toMatchObject({ featureId: 'x', moduleIds: ['m1', 'm2', 'm3'] });
  });

  it('does not count shared or project-level modules as users', () => {
    const plan = buildThriveni();
    plan.features = [{ id: 'x', name: 'Thing', moduleIds: ['shared', 'project', 'm1'] }];
    expect(findAdvisories(plan)).toEqual([]);
  });

  it('is silent for a plan with no features', () => {
    const plan = buildThriveni();
    delete plan.features;
    expect(findAdvisories(plan)).toEqual([]);
  });
});

describe('feature validation', () => {
  it('rejects references to things that do not exist', () => {
    const badModule = buildThriveni();
    feature(badModule, 'extinguisher').moduleIds.push('m99');
    expect(() => startProject(badModule)).toThrow(/Feature extinguisher refers to unknown module m99/);

    const badShared = buildThriveni();
    feature(badShared, 'extinguisher').sharedTaskId = 'nope';
    expect(() => startProject(badShared)).toThrow(/unknown shared task nope/);

    const badTask = buildThriveni();
    const task = badTask.tasks[0];
    if (task) task.featureId = 'ghost';
    expect(() => startProject(badTask)).toThrow(PlanError);
    expect(() => startProject(badTask)).toThrow(/unknown feature ghost/);

    const dupe = buildThriveni();
    dupe.features?.push({ id: 'extinguisher', name: 'Again', moduleIds: [] });
    expect(() => startProject(dupe)).toThrow(/Duplicate feature ids/);
  });
});
