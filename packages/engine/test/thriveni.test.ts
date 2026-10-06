import { describe, expect, it } from 'vitest';
import { buildThriveni, schedule } from '../src';
import type { Plan, Task } from '../src';

/** Edits a fresh copy of the Thriveni plan. */
function scenario(edit: (plan: Plan, task: (id: string) => Task) => void): Plan {
  const plan = buildThriveni();
  edit(plan, (id) => {
    const t = plan.tasks.find((x) => x.id === id);
    if (!t) throw new Error(`no task ${id}`);
    return t;
  });
  return plan;
}

/** HS: every module needs a 2-day extinguisher integration between its Dev and Alpha tasks. */
function addExtinguisherToEveryModule(plan: Plan): void {
  for (let n = 1; n <= 7; n++) {
    const m = `m${n}`;
    plan.tasks.push({ id: `${m}.ext`, moduleId: m, teamId: 'dev', kind: 'TASK', name: `${m} extinguisher`, estimate: 2 });
    plan.dependencies = plan.dependencies.filter((d) => !(d.predecessorId === `${m}.dev` && d.successorId === `${m}.alpha`));
    plan.dependencies.push(
      { predecessorId: `${m}.dev`, successorId: `${m}.ext`, type: 'FS' },
      { predecessorId: `${m}.ext`, successorId: `${m}.alpha`, type: 'FS' },
    );
  }
}

const finishOf = (plan: Plan) => schedule(plan).delivery;

describe('Thriveni baseline (T1)', () => {
  const s = schedule(buildThriveni());

  it('delivers on Fri 30 Oct after exactly 20 working days', () => {
    expect(s.delivery.finish).toBe(20);
    expect(s.delivery.date).toBe('2026-10-30');
  });

  it('has the M5 chain as its critical path', () => {
    expect(new Set(s.criticalPath)).toEqual(
      new Set([
        'm5.sb', 'm5.art', 'm5.dev', 'm5.alpha',
        'proj.review', 'proj.chg.dev', 'proj.integration', 'proj.qa', 'proj.beta', 'proj.delivery',
      ]),
    );
    expect(s.drivingChain).toEqual([
      'm5.sb', 'm5.art', 'm5.dev', 'm5.alpha',
      'proj.review', 'proj.chg.dev', 'proj.integration', 'proj.qa', 'proj.beta', 'proj.delivery',
    ]);
  });

  it('finishes each module on its planned day', () => {
    const finishes = Object.fromEntries(Object.entries(s.modules).map(([id, m]) => [id, m.finish]));
    expect(finishes).toEqual({
      m1: 10, m2: 9, m3: 12, m4: 11, m5: 13, m6: 10, m7: 11, shared: 7, project: 20,
    });
  });

  it('gives each module the float shown in DESIGN.md §6', () => {
    const alphaFloat = Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((n) => [n, s.tasks[`m${n}.alpha`]?.totalFloat]));
    expect(alphaFloat).toEqual({ 1: 3, 2: 4, 3: 1, 4: 2, 5: 0, 6: 3, 7: 2 });
  });

  it('gives shared work and parallel client changes their float', () => {
    expect(s.tasks['shared.loc']?.totalFloat).toBe(9);
    expect(s.tasks['shared.menu']?.totalFloat).toBe(9);
    expect(s.tasks['shared.eval']?.totalFloat).toBe(11);
    expect(s.tasks['proj.chg.art']?.totalFloat).toBe(1);
    expect(s.tasks['proj.chg.lxd']?.totalFloat).toBe(1);
  });
});

describe('Thriveni scenarios applied directly to the plan (event-driven versions come with the event engine)', () => {
  it('T2: a delay inside the float moves the module but not delivery', () => {
    const s = schedule(scenario((_, t) => (t('m2.dev').estimate += 3)));
    expect(s.delivery.date).toBe('2026-10-30');
    expect(s.modules.m2?.finish).toBe(12); // 9 -> 12
    expect(s.tasks['m2.alpha']?.totalFloat).toBe(1);
    expect(s.tasks['m2.alpha']?.critical).toBe(false);
  });

  it('T3: a critical delay moves delivery across the weekend', () => {
    const s = schedule(scenario((_, t) => (t('m5.dev').estimate += 1)));
    expect(s.delivery.finish).toBe(21);
    expect(s.delivery.date).toBe('2026-11-02'); // Mon
    expect(s.modules.m5?.finish).toBe(14);
  });

  it('T4: a delay larger than the float moves delivery by the excess and switches the critical path', () => {
    const s = schedule(scenario((_, t) => (t('m3.dev').estimate += 3)));
    expect(s.delivery.finish).toBe(22);
    expect(s.delivery.date).toBe('2026-11-03'); // Tue
    expect(s.modules.m3?.finish).toBe(15);
    expect(s.criticalPath).toEqual(expect.arrayContaining(['m3.sb', 'm3.art', 'm3.dev', 'm3.alpha']));
    expect(s.criticalPath).not.toContain('m5.dev');
    expect(s.tasks['m5.alpha']?.totalFloat).toBe(2);
  });

  it('HS: the late extinguisher costs 14 effort-days but only 2 schedule days', () => {
    const baseline = buildThriveni();
    const plan = scenario((p) => addExtinguisherToEveryModule(p));
    const effortAdded = plan.tasks.filter((t) => t.id.endsWith('.ext')).reduce((sum, t) => sum + t.estimate, 0);
    expect(effortAdded).toBe(14);

    const s = schedule(plan);
    expect(s.delivery.finish).toBe(finishOf(baseline).finish + 2);
    expect(s.delivery.date).toBe('2026-11-03');
    const before = schedule(baseline);
    for (let n = 1; n <= 7; n++) {
      expect(s.modules[`m${n}`]?.finish).toBe((before.modules[`m${n}`]?.finish ?? 0) + 2);
    }
    expect(s.tasks['m5.ext']?.critical).toBe(true);
  });

  it('T2 + T3 + HS together land on Wed 4 Nov (variance +3)', () => {
    const plan = scenario((p, t) => {
      t('m2.dev').estimate += 3;
      t('m5.dev').estimate += 1;
      addExtinguisherToEveryModule(p);
    });
    const s = schedule(plan);
    expect(s.delivery.finish).toBe(23);
    expect(s.delivery.date).toBe('2026-11-04');
  });
});
