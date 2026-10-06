import { afterEach, describe, expect, it } from 'vitest';
import { hs, makeApp, makeSeededApp, P, t2, t3, t4 } from './helpers';
import type { TestApp } from './helpers';

let app: TestApp;
afterEach(async () => app.close());

const record = (event: object) => app.post(`${P}/events`, event);

/** The same scenarios the engine tests establish, now over HTTP and through SQLite. */
describe('recording events', () => {
  it('T2: a delay inside the float moves the module, not delivery', async () => {
    app = makeSeededApp();
    const r = await record(t2());
    expect(r.status).toBe(201);
    expect(r.body.event).toMatchObject({ id: 't2', seq: 1, status: 'ACTIVE', voidedBy: null, asOf: '2026-10-13' });
    expect(r.body.snapshot).toMatchObject({ revision: 1, kind: 'EVENT', eventId: 't2', stepDays: 0, variance: 0, effortImpact: 3 });
    expect(r.body.snapshot.forecastDelivery).toEqual({ offset: 20, date: '2026-10-30' });
    expect(r.body.explanation).toMatchObject({ absorbed: true, onCriticalPath: false });
    expect(r.body.explanation.modules).toEqual([expect.objectContaining({ moduleId: 'm2', delta: 3, origin: 'DIRECT', absorbed: true })]);
  });

  it('T3: a critical delay moves delivery across the weekend', async () => {
    app = makeSeededApp();
    const r = await record(t3());
    expect(r.body.snapshot.forecastDelivery).toEqual({ offset: 21, date: '2026-11-02' });
    expect(r.body.snapshot.stepDays).toBe(1);
    expect(r.body.explanation.modules).toEqual([
      expect.objectContaining({ moduleId: 'm5', origin: 'DIRECT' }),
      expect.objectContaining({ moduleId: 'project', origin: 'PROPAGATED', fromModuleIds: ['m5'] }),
    ]);
  });

  it('T4: the critical path switches', async () => {
    app = makeSeededApp();
    const r = await record(t4());
    expect(r.body.snapshot.forecastDelivery.date).toBe('2026-11-03');
    expect(r.body.explanation.criticalPath.changed).toBe(true);
    expect(r.body.explanation.criticalPath.entered).toContain('m3.dev');
  });

  it('the late extinguisher: 14 effort-days, +2 schedule days (spec §40)', async () => {
    app = makeSeededApp();
    const r = await record(hs());
    expect(r.body.snapshot).toMatchObject({ effortImpact: 14, stepDays: 2, variance: 2 });
    expect(r.body.snapshot.forecastDelivery).toEqual({ offset: 22, date: '2026-11-03' });
    expect(r.body.explanation.onCriticalPath).toBe(true);
    expect(r.body.explanation.modules).toHaveLength(8);
    expect(r.body.explanation.tasks.filter((t: { change: string }) => t.change === 'ADDED')).toHaveLength(7);
  });

  it('keeps every earlier forecast: history grows, nothing is rewritten', async () => {
    app = makeSeededApp();
    await record(t2());
    const before = (await app.get(`${P}/snapshots/1?`)).body;
    await record(t3());
    await record(hs());

    const list = (await app.get(`${P}/snapshots`)).body;
    expect(list.map((s: { revision: number }) => s.revision)).toEqual([0, 1, 2, 3]);
    expect(list.map((s: { forecastDelivery: { date: string } }) => s.forecastDelivery.date)).toEqual(['2026-10-30', '2026-10-30', '2026-11-02', '2026-11-04']);
    expect(list.map((s: { stepDays: number }) => s.stepDays)).toEqual([0, 0, 1, 2]);
    expect((await app.get(`${P}/snapshots/1`)).body).toEqual(before);
  });

  it('numbers the log and stamps recorded time from the server clock', async () => {
    app = makeSeededApp();
    await record(t2());
    await record(t3());
    const events = (await app.get(`${P}/events`)).body;
    expect(events.map((e: { id: string; seq: number }) => [e.id, e.seq])).toEqual([['t2', 1], ['t3', 2]]);
    expect(events[0].recordedAt < events[1].recordedAt).toBe(true);
  });

  it('generates an id, defaults asOf to occurredAt, and keeps optional metadata', async () => {
    app = makeSeededApp();
    const r = await record({
      type: 'FEEDBACK',
      title: 'LXD note',
      phase: 'ALPHA',
      createdBy: 'priya',
      occurredAt: '2026-10-14',
      sourceTeamId: 'lxd',
      affectedTeamId: 'dev',
      couldHaveBeenEarlier: true,
      estimatedEffortImpact: 2,
      taskId: 'm1.dev',
      effects: [],
    });
    expect(r.status).toBe(201);
    expect(r.body.event.id).toMatch(/^evt-[0-9a-f]{8}$/);
    expect(r.body.event).toMatchObject({ asOf: '2026-10-14', sourceTeamId: 'lxd', affectedTeamId: 'dev', couldHaveBeenEarlier: true, estimatedEffortImpact: 2, taskId: 'm1.dev', description: '', category: 'General' });
    const stored = (await app.get(`${P}/events/${r.body.event.id}`)).body;
    expect(stored.event).toMatchObject({ couldHaveBeenEarlier: true, taskId: 'm1.dev' });
    expect(r.body.snapshot.stepDays).toBe(0); // an event with no effects changes nothing
  });
});

describe('preview', () => {
  it('answers what an event would do, and writes nothing', async () => {
    app = makeSeededApp();
    const r = await app.post(`${P}/events/preview`, hs());
    expect(r.status).toBe(200);
    expect(r.body.explanation).toMatchObject({ stepDays: 2, effortImpact: 14, onCriticalPath: true });
    expect(r.body.explanation.delivery).toEqual({ before: '2026-10-30', after: '2026-11-03' });
    expect(r.body.event.id).toBe('hs');

    expect((await app.get(`${P}/events`)).body).toEqual([]);
    expect((await app.get(`${P}/snapshots`)).body).toHaveLength(1);
    expect((await app.get(`${P}/forecast`)).body.forecastDelivery.date).toBe('2026-10-30');
  });

  it('matches what recording then explains', async () => {
    app = makeSeededApp();
    await record(t2());
    const preview = (await app.post(`${P}/events/preview`, t3())).body.explanation;
    const recorded = (await record(t3())).body.explanation;
    expect(preview).toEqual(recorded);
  });

  it('applies the same checks as recording', async () => {
    app = makeSeededApp();
    const r = await app.post(`${P}/events/preview`, { ...t2(), effects: [{ op: 'ADJUST_ESTIMATE', taskId: 'ghost', delta: 1 }] });
    expect(r.status).toBe(422);
    expect(r.body.error).toBe('EVENT_REJECTED');
  });
});

describe('events that cannot be applied', () => {
  it('rejects an effect the plan cannot take, naming the event and the effect, and leaves no trace', async () => {
    app = makeSeededApp();
    // By Thu 22 Oct every Alpha has happened, so new work can no longer block it.
    const late = { ...hs(), id: 'hs-late', occurredAt: '2026-10-22' };
    const r = await record(late);
    expect(r.status).toBe(422);
    expect(r.body.error).toBe('EVENT_REJECTED');
    expect(r.body.message).toMatch(/Event hs-late: Effect 1 \(ADD_TASK\).*already started/);
    expect(r.body.details).toEqual({ eventId: 'hs-late' });

    expect((await app.get(`${P}/events`)).body).toEqual([]);
    expect((await app.get(`${P}/snapshots`)).body).toHaveLength(1);
    // and the next event is still number 1 in the log
    expect((await record(t2())).body.event.seq).toBe(1);
  });

  it('rejects references to things that do not exist, all at once', async () => {
    app = makeSeededApp();
    const r = await record({ ...t2(), moduleId: 'm99', taskId: 'ghost', sourceTeamId: 'nobody', linkedFeatureId: 'nothing', parentEventId: 'missing' });
    expect(r.status).toBe(422);
    expect(r.body.details).toEqual(['unknown module "m99"', 'unknown task "ghost"', 'unknown team "nobody"', 'unknown feature "nothing"', 'unknown parent event "missing"']);
  });

  it('refuses a reused id', async () => {
    app = makeSeededApp();
    await record(t2());
    const r = await record({ ...t3(), id: 't2' });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('ALREADY_EXISTS');
  });

  it('refuses events before the project has started', async () => {
    app = makeApp();
    await app.post('/projects', { id: 'thriveni', name: 'x', startDate: '2026-10-05' });
    const r = await record(t2());
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('NOT_STARTED');
  });

  it('rejects malformed events with the path of each problem', async () => {
    app = makeSeededApp();
    const r = await record({ type: 'NOT_A_TYPE', title: '', phase: 'DEVELOPMENT', createdBy: 'x', occurredAt: '13/10/2026', effects: [{ op: 'TELEPORT' }], surprise: 1 });
    expect(r.status).toBe(400);
    const paths = r.body.details.map((d: { path: string }) => d.path);
    expect(paths).toEqual(expect.arrayContaining(['type', 'title', 'occurredAt', 'effects.0.op']));
  });

  it('rejects an unknown field on an effect, catching typos', async () => {
    app = makeSeededApp();
    const r = await record({ ...t2(), effects: [{ op: 'ADJUST_ESTIMATE', taskId: 'm2.dev', deltaa: 3 }] });
    expect(r.status).toBe(400);
  });
});

describe('events with other kinds of effect', () => {
  it('a capacity change: no effort, delivery +9 working days (Thu 12 Nov)', async () => {
    app = makeSeededApp();
    const r = await record({
      id: 'dev-cut', type: 'RESOURCE_CHANGE', category: 'Capacity', title: 'Dev 4 -> 2', phase: 'DEVELOPMENT', createdBy: 'pm',
      occurredAt: '2026-10-13', effects: [{ op: 'SET_CAPACITY', teamId: 'dev', from: '2026-10-14', headcount: 2 }],
    });
    expect(r.body.snapshot).toMatchObject({ effortImpact: 0, stepDays: 9 });
    expect(r.body.snapshot.forecastDelivery).toEqual({ offset: 29, date: '2026-11-12' });
  });

  it('recorded actuals can pull delivery in', async () => {
    app = makeSeededApp();
    const r = await record({
      id: 'm5-done', type: 'TASK_COMPLETION', category: 'Progress', title: 'M5 dev finished', phase: 'DEVELOPMENT', createdBy: 'dev-lead',
      occurredAt: '2026-10-16', effects: [{ op: 'RECORD_PROGRESS', taskId: 'm5.dev', finishedOn: '2026-10-16' }],
    });
    expect(r.body.snapshot.forecastDelivery).toEqual({ offset: 19, date: '2026-10-29' });
    expect(r.body.snapshot.stepDays).toBe(-1);
  });

  it('new work can be wired in with ADD_TASK and an owner transfer can add context cost', async () => {
    app = makeSeededApp();
    const r = await record({
      ...t2(), id: 'mix',
      effects: [
        { op: 'ADD_TASK', task: { id: 'qa.extra', moduleId: 'project', teamId: 'qa', name: 'Extra QA pass', estimate: 1 }, dependsOn: ['proj.integration'], blocks: ['proj.qa'] },
        { op: 'TRANSFER_OWNER', taskId: 'm4.dev', toPersonId: 'dev-b', contextCost: 0.5 },
      ],
    });
    expect(r.status).toBe(201);
    expect(r.body.snapshot.effortImpact).toBe(1.5);
    expect(r.body.snapshot.forecastDelivery.offset).toBe(21); // the extra QA pass is on the critical path
  });
});

describe('voiding', () => {
  it('withdraws an event; the log keeps both, and a VOID snapshot records the correction', async () => {
    app = makeSeededApp();
    await record(hs());
    const r = await app.post(`${P}/events/hs/void`, { id: 'v1', asOf: '2026-10-15', reason: 'entered by mistake' });
    expect(r.status).toBe(201);
    expect(r.body.snapshot).toMatchObject({ kind: 'VOID', eventId: 'hs', voidId: 'v1', stepDays: -2, effortImpact: -14, variance: 0 });
    expect(r.body.snapshot.forecastDelivery.date).toBe('2026-10-30');
    expect(r.body.event).toMatchObject({ id: 'hs', status: 'VOIDED', voidedBy: 'v1' });

    const events = (await app.get(`${P}/events`)).body;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ id: 'hs', status: 'VOIDED', voidedBy: 'v1' });
    expect((await app.get(`${P}/snapshots`)).body.map((s: { kind: string }) => s.kind)).toEqual(['BASELINE', 'EVENT', 'VOID']);
  });

  it('refuses a second void, an unknown event, and one that later events relied on', async () => {
    app = makeSeededApp();
    await record(hs());
    await app.post(`${P}/events/hs/void`, { asOf: '2026-10-15' });
    expect((await app.post(`${P}/events/hs/void`, { asOf: '2026-10-16' })).body.error).toBe('ALREADY_VOIDED');
    expect((await app.post(`${P}/events/ghost/void`, { asOf: '2026-10-16' })).status).toBe(404);

    await app.close();
    app = makeSeededApp();
    await record(hs());
    await record({ ...t2(), id: 'builds-on-hs', effects: [{ op: 'ADJUST_ESTIMATE', taskId: 'm1.ext', delta: 1 }] });
    const r = await app.post(`${P}/events/hs/void`, { asOf: '2026-10-15' });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('CANNOT_VOID');
    expect((await app.get(`${P}/events`)).body.every((e: { status: string }) => e.status === 'ACTIVE')).toBe(true);
    expect((await app.get(`${P}/snapshots`)).body).toHaveLength(3);
  });

  it('lets later events build on the corrected history', async () => {
    app = makeSeededApp();
    await record(hs());
    await app.post(`${P}/events/hs/void`, { asOf: '2026-10-15' });
    const r = await record({ ...t3(), occurredAt: '2026-10-16', id: 'after-void' });
    expect(r.body.snapshot.forecastDelivery.date).toBe('2026-11-02');
    expect(r.body.event.seq).toBe(3);
  });
});

describe('listing and filtering events', () => {
  it('filters by type, phase, module, team and status', async () => {
    app = makeSeededApp();
    await record({ ...t2(), moduleId: 'm2', sourceTeamId: 'lxd' });
    await record({ ...t3(), moduleId: 'm5', phase: 'ALPHA', affectedTeamId: 'dev' });
    await record(hs());
    await app.post(`${P}/events/hs/void`, { asOf: '2026-10-15' });

    const ids = async (qs: string) => (await app.get(`${P}/events?${qs}`)).body.map((e: { id: string }) => e.id);
    expect(await ids('')).toEqual(['t2', 't3', 'hs']);
    expect(await ids('type=TASK_DELAY')).toEqual(['t2']);
    expect(await ids('phase=ALPHA')).toEqual(['t3']);
    expect(await ids('moduleId=m5')).toEqual(['t3']);
    expect(await ids('teamId=lxd')).toEqual(['t2']);
    expect(await ids('teamId=dev')).toEqual(['t3']);
    expect(await ids('status=voided')).toEqual(['hs']);
    expect(await ids('status=active')).toEqual(['t2', 't3']);
  });

  it('shows one event with the forecast change it caused', async () => {
    app = makeSeededApp();
    await record(t2());
    await record(t3());
    const d = (await app.get(`${P}/events/t3`)).body;
    expect(d.event.id).toBe('t3');
    expect(d.snapshot).toMatchObject({ revision: 2, stepDays: 1 });
    expect(d.explanation.modules.map((m: { moduleId: string }) => m.moduleId)).toEqual(['m5', 'project']);
    expect((await app.get(`${P}/events/ghost`)).status).toBe(404);
  });
});
