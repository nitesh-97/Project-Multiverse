import { afterEach, describe, expect, it } from 'vitest';
import { holidayEvent, makeDraftApp, makeSeededApp, P, sharedExt, t2, t3 } from './helpers';
import type { TestApp } from './helpers';

let app: TestApp;
afterEach(async () => app.close());

const noop = (id = 'noop', on = '2026-10-14') => ({ ...t2(), id, occurredAt: on, effects: [] });
const advisories = async (rule?: string) => {
  const all = (await app.get(`${P}/advisories`)).body as Array<{ rule: string; taskId?: string; moduleId?: string; featureId?: string }>;
  return rule ? all.filter((a) => a.rule === rule) : all;
};

describe('holidays added during the project', () => {
  it('are events: a holiday on Wed 28 Oct pushes delivery from Fri 30 Oct to Mon 2 Nov', async () => {
    app = makeSeededApp();
    const r = await app.post(`${P}/events`, holidayEvent());
    expect(r.status).toBe(201);
    expect(r.body.snapshot.forecastDelivery).toEqual({ offset: 20, date: '2026-11-02' });
    expect(r.body.snapshot).toMatchObject({ stepDays: 1, variance: 1, effortImpact: 0 });
    expect(r.body.snapshot.calendar.holidays).toEqual(['2026-10-28']);
    expect(r.body.explanation.modules.map((m: { moduleId: string; delta: number }) => [m.moduleId, m.delta])).toEqual([['project', 1]]);
  });

  it('are attributed to capacity, and appear in the timeline as a delivery branch', async () => {
    app = makeSeededApp();
    await app.post(`${P}/events`, holidayEvent());
    expect((await app.get(`${P}/attribution`)).body.byCategory).toEqual([{ category: 'Capacity changes', days: 1, effortDays: 0, eventIds: ['hol'] }]);
    expect((await app.get(`${P}/timeline`)).body.branches.map((b: { moduleId: string }) => b.moduleId)).toEqual(['project']);
  });

  it('can be voided', async () => {
    app = makeSeededApp();
    await app.post(`${P}/events`, holidayEvent());
    const v = await app.post(`${P}/events/hol/void`, { asOf: '2026-10-15' });
    expect(v.body.snapshot.forecastDelivery.date).toBe('2026-10-30');
    expect(v.body.snapshot.calendar.holidays).toEqual([]);
  });

  it('are refused on a weekend, a past day, or a day that is already a holiday', async () => {
    app = makeSeededApp();
    const weekend = await app.post(`${P}/events`, holidayEvent('2026-10-24', { id: 'sat' }));
    expect(weekend.status).toBe(422);
    expect(weekend.body.message).toMatch(/already a non-working day/);
    const past = await app.post(`${P}/events`, holidayEvent('2026-10-14', { id: 'today' }));
    expect(past.body.message).toMatch(/not after the status date 2026-10-14/);
    await app.post(`${P}/events`, holidayEvent());
    const dupe = await app.post(`${P}/events`, holidayEvent('2026-10-28', { id: 'again', occurredAt: '2026-10-15' }));
    expect(dupe.body.message).toMatch(/already a non-working day/);
    expect((await app.get(`${P}/events`)).body).toHaveLength(1);
  });
});

describe('days to the client date', () => {
  it('starts at zero: the plan finishes on the day promised', async () => {
    app = makeSeededApp();
    expect((await app.get(`${P}/forecast`)).body.target).toEqual({ date: '2026-10-30', daysToSpare: 0 });
    expect((await app.get(P)).body.forecast.target).toEqual({ date: '2026-10-30', daysToSpare: 0 });
  });

  it('goes negative as delivery slips, counted in working days', async () => {
    app = makeSeededApp();
    await app.post(`${P}/events`, t3());
    expect((await app.get(`${P}/forecast`)).body.target.daysToSpare).toBe(-1); // Mon 2 Nov: one working day after Fri 30 Oct
    await app.post(`${P}/events`, sharedExt());
    expect((await app.get(`${P}/forecast`)).body.target.daysToSpare).toBe(-3); // Wed 4 Nov
  });

  it('counts a holiday before the date as a working day lost', async () => {
    app = makeSeededApp();
    await app.post(`${P}/events`, holidayEvent());
    expect((await app.get(`${P}/forecast`)).body.target.daysToSpare).toBe(-1);
  });

  it('is independent of variance: a client date with slack, or none at all', async () => {
    app = makeSeededApp();
    await app.patch(P, { targetDate: '2026-11-06' });
    const f = (await app.get(`${P}/forecast`)).body;
    expect(f.variance).toBe(0);
    expect(f.target).toEqual({ date: '2026-11-06', daysToSpare: 5 });
    await app.patch(P, { targetDate: null });
    expect((await app.get(`${P}/forecast`)).body.target).toBeNull();
  });
});

describe('the extinguisher as one shared effort', () => {
  it('costs 2 effort-days and 2 days of delivery, in one lane, and says which modules it is for', async () => {
    app = makeSeededApp();
    const r = await app.post(`${P}/events`, sharedExt());
    expect(r.status).toBe(201);
    expect(r.body.snapshot).toMatchObject({ effortImpact: 2, stepDays: 2 });
    expect(r.body.snapshot.forecastDelivery).toEqual({ offset: 22, date: '2026-11-03' });
    expect(r.body.explanation.modules.map((m: { moduleId: string; delta: number; origin: string }) => [m.moduleId, m.delta, m.origin])).toEqual([['project', 2, 'DIRECT']]);
    expect(r.body.explanation.linkedModuleIds).toEqual(['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7']);
    expect(r.body.explanation.onCriticalPath).toBe(true);
  });

  it('resolves the advisory, because the work was done once for everyone', async () => {
    app = makeSeededApp();
    expect(await advisories('COMMON_FEATURE_WITHOUT_SHARED_TASK')).toHaveLength(1);
    await app.post(`${P}/events`, sharedExt());
    expect(await advisories('COMMON_FEATURE_WITHOUT_SHARED_TASK')).toEqual([]);
  });
});

describe('work the forecast assumes is finished', () => {
  it('is flagged until someone records it', async () => {
    app = makeSeededApp();
    expect(await advisories('UNCONFIRMED_COMPLETION')).toEqual([]); // nothing has been forecast finished yet
    await app.post(`${P}/events`, noop());
    const warned = await advisories('UNCONFIRMED_COMPLETION');
    expect(warned).toHaveLength(17); // 14 module tasks and 3 shared tasks, forecast finished by the end of 14 Oct
    expect(warned.slice(0, 4).map((a) => a.taskId)).toEqual(['m1.sb', 'm2.sb', 'm4.sb', 'm6.sb']);
    const first = ((await app.get(`${P}/advisories`)).body as Array<Record<string, unknown>>).find((a) => a.taskId === 'm5.art');
    expect(first).toMatchObject({ severity: 'WARNING', forecastFinish: '2026-10-13' });
    expect(first?.message).toBe('Assumed finished: "m5 art" (m5.art) was forecast to finish on 2026-10-13 and nobody has recorded it.');
  });

  it('is cleared by recording the task as finished', async () => {
    app = makeSeededApp();
    await app.post(`${P}/events`, noop());
    await app.post(`${P}/events`, { ...t2(), id: 'confirm', occurredAt: '2026-10-14', type: 'TASK_COMPLETION', effects: [{ op: 'RECORD_PROGRESS', taskId: 'm1.sb', finishedOn: '2026-10-06' }] });
    const ids = (await advisories('UNCONFIRMED_COMPLETION')).map((a) => a.taskId);
    expect(ids).toHaveLength(16);
    expect(ids).not.toContain('m1.sb');
  });

  it('a late actual pushes the work after it: art finished Thu 15 Oct instead of Tue 13 Oct costs 2 days', async () => {
    app = makeSeededApp();
    const r = await app.post(`${P}/events`, { ...t2(), id: 'late-art', occurredAt: '2026-10-15', type: 'TASK_COMPLETION', effects: [{ op: 'RECORD_PROGRESS', taskId: 'm5.art', finishedOn: '2026-10-15' }] });
    expect(r.body.snapshot.forecastDelivery).toEqual({ offset: 22, date: '2026-11-03' });
    expect(r.body.snapshot.stepDays).toBe(2);
  });
});

describe('a module that is not locked but is under way', () => {
  it('is warned about, and the warning goes once it is locked', async () => {
    app = await makeDraftApp();
    expect(await advisories('MODULE_STARTED_NOT_LOCKED')).toEqual([]); // nothing has started yet
    await app.post(`${P}/events`, noop('n', '2026-10-14'));
    const w = await advisories('MODULE_STARTED_NOT_LOCKED');
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ moduleId: 'm7', severity: 'WARNING' });
    expect(((await app.get(`${P}/advisories`)).body as Array<{ message: string }>).find((a) => a.message.startsWith('Module m7'))?.message).toMatch(/Module m7 is not locked, but the forecast has \d+ of its tasks under way or finished/);

    await app.post(`${P}/modules/m7/lock`);
    expect(await advisories('MODULE_STARTED_NOT_LOCKED')).toEqual([]);
  });
});

describe('both ways of dividing the delay', () => {
  it('?strategy=both returns them side by side, and an unknown strategy names the options', async () => {
    app = makeSeededApp();
    await app.post(`${P}/events`, t3());
    const both = (await app.get(`${P}/attribution?strategy=both`)).body;
    expect(both.sequential.strategy).toBe('sequential');
    expect(both.counterfactual.strategy).toBe('counterfactual');
    expect(both.sequential.totalVariance).toBe(both.counterfactual.totalVariance);
    const bad = await app.get(`${P}/attribution?strategy=vibes`);
    expect(bad.status).toBe(400);
    expect(bad.body.message).toMatch(/sequential, counterfactual, both/);
  });
});
