import { afterEach, describe, expect, it } from 'vitest';
import { TEMPLATES, initialCommon, initialValues, templateById } from '../../web/src/lib/templates';
import type { Built, Common, FormContext, Values } from '../../web/src/lib/templates';
import { makeDraftApp, makeSeededApp, P } from './helpers';
import type { TestApp } from './helpers';

/**
 * The web app's forms build their own payloads. This posts what they build to the real API, so a form and the API can
 * not drift apart: a field one renames, the other rejects, and this fails.
 */

let app: TestApp;
afterEach(async () => app.close());

async function contextOf(a: TestApp, today: string): Promise<FormContext> {
  const detail = (await a.get(P)).body;
  const tasks = (await a.get(`${P}/current-tasks`)).body;
  return { today, tasks, teams: detail.teams, modules: detail.modules, features: detail.features, deliveryTaskId: detail.project.deliveryTaskId, phases: detail.project.phases };
}

const common = (ctx: FormContext, over: Partial<Common> = {}): Common => ({ ...initialCommon(ctx, 'Asha'), ...over });

async function send(a: TestApp, built: Built): Promise<{ preview: number; record: number; body: Record<string, unknown> }> {
  if (!built.ok) throw new Error(`the form refused: ${built.problems.join(' | ')}`);
  const route = built.route === 'event' ? 'events' : 'plan-edits';
  const preview = await a.post(`${P}/${route}/preview`, built.draft);
  if (preview.status !== 200) throw new Error(`preview refused: ${JSON.stringify(preview.body)}`);
  const record = await a.post(`${P}/${route}`, built.draft);
  return { preview: preview.status, record: record.status, body: record.body };
}

const answers: Record<string, Values> = {
  reestimate: { task: 'm5.dev', days: '1' },
  finished: { task: 'm1.sb', finishedOn: '2026-10-06' },
  progress: { task: 'm5.dev', startedOn: '2026-10-14', remaining: '5' },
  blocked: { task: 'proj.qa', until: '2026-10-30' },
  capacity: { team: 'dev', from: '2026-10-19', headcount: '2' },
  holiday: { date: '2026-10-28' },
  handover: { task: 'm3.dev', person: 'Ravi', cost: '0.5' },
  'new-work': { name: 'Extinguisher system', effort: '2', module: 'project', team: 'dev', after: ['proj.chg.dev'], before: 'proj.integration', kind: 'SCOPE_CHANGE', feature: 'extinguisher' },
  feedback: { from: 'CLIENT_FEEDBACK', team: 'lxd' },
};

describe('what the event forms build is accepted by the API', () => {
  for (const [id, values] of Object.entries(answers)) {
    it(`${id}: previews and records, and shows up in the history`, async () => {
      app = makeSeededApp();
      const ctx = await contextOf(app, '2026-10-14');
      const t = templateById(id);
      if (!t) throw new Error(`no template ${id}`);
      const built = t.build(values, common(ctx, { title: id === 'feedback' ? 'Alpha review' : '', phase: id === 'feedback' ? 'ALPHA' : 'DEVELOPMENT' }), ctx);
      const sent = await send(app, built);
      expect(sent.preview).toBe(200);
      expect(sent.record).toBe(201);
      const events = (await app.get(`${P}/events`)).body as Array<{ title: string; createdBy: string; status: string }>;
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ createdBy: 'Asha', status: 'ACTIVE', title: built.ok ? (built.draft as { title: string }).title : '' });
    });
  }

  it('re-estimating moves delivery exactly as the form said it would', async () => {
    app = makeSeededApp();
    const ctx = await contextOf(app, '2026-10-14');
    const built = templateById('reestimate')!.build(answers.reestimate!, common(ctx), ctx);
    await send(app, built);
    const forecast = (await app.get(`${P}/forecast`)).body;
    expect(forecast.variance).toBe(1);
    expect(forecast.forecastDelivery.date).toBe('2026-11-02');
  });

  it('new work linked to a feature resolves the shared-feature warning, as the retrospective counts it', async () => {
    app = makeSeededApp();
    const ctx = await contextOf(app, '2026-10-14');
    await send(app, templateById('new-work')!.build(answers['new-work']!, common(ctx), ctx));
    const forecast = (await app.get(`${P}/forecast`)).body;
    expect(forecast.variance).toBe(2);
    const retro = (await app.get(`${P}/retro`)).body;
    expect(retro.scope).toMatchObject({ changes: 1, afterDevelopmentStarted: 1 });
    expect(retro.observations).toContain('1 common feature (Extinguisher) identified only after development had started');
    const advisories = (await app.get(`${P}/advisories`)).body as Array<{ rule: string; featureId?: string }>;
    expect(advisories.some((a) => a.rule === 'COMMON_FEATURE_WITHOUT_SHARED_TASK' && a.featureId === 'extinguisher')).toBe(false);
  });

  it('every standard form has an answer in this test, or is a planning form tested below', () => {
    const planning = TEMPLATES.filter((t) => t.route === 'plan-edit').map((t) => t.id);
    const events = TEMPLATES.filter((t) => t.route === 'event').map((t) => t.id);
    expect(Object.keys(answers).sort()).toEqual(events.sort());
    expect(planning.sort()).toEqual(['plan-add', 'plan-reestimate', 'plan-remove']);
  });
});

describe('what the planning forms build is accepted by the API', () => {
  const planAnswers: Record<string, Values> = {
    'plan-reestimate': { task: 'm7.dev', days: '3' },
    'plan-add': { name: 'Accessibility pass', effort: '2', module: 'm7', team: 'dev', after: ['m7.dev'], before: 'm7.alpha' },
    'plan-remove': { task: 'm7.art' },
  };
  for (const [id, values] of Object.entries(planAnswers)) {
    it(`${id}: previews and records as a planning change`, async () => {
      app = await makeDraftApp();
      const ctx = await contextOf(app, '2026-10-06');
      const t = templateById(id)!;
      const sent = await send(app, t.build(values, common(ctx), ctx));
      expect(sent.record).toBe(201);
      const edits = (await app.get(`${P}/plan-edits`)).body as Array<{ createdBy: string; effects: unknown[] }>;
      expect(edits).toHaveLength(1);
      expect(edits[0]).toMatchObject({ createdBy: 'Asha' });
      expect((await app.get(`${P}/forecast`)).body.variance).toBe(0); // planning, not delay
    });
  }

  it('offers exactly the tasks the server accepts for each kind of form', async () => {
    app = await makeDraftApp();
    const ctx = await contextOf(app, '2026-10-06');
    // Every task an event form offers, the server takes an event for; every one a planning form offers, a plan edit.
    const openField = TEMPLATES.find((t) => t.id === 'reestimate')!.fields.find((f) => f.id === 'task')!;
    const planField = TEMPLATES.find((t) => t.id === 'plan-reestimate')!.fields.find((f) => f.id === 'task')!;
    expect(openField.scope).toBe('open');
    expect(planField.scope).toBe('unstarted');
    const eventOffered = ctx.tasks.filter((t) => t.kind === 'TASK' && t.state !== 'DONE' && t.moduleLocked);
    const planOffered = ctx.tasks.filter((t) => t.kind === 'TASK' && t.state === 'NOT_STARTED' && !t.moduleLocked);
    expect(eventOffered.some((t) => t.moduleId === 'm7')).toBe(false);
    expect(planOffered.every((t) => t.moduleId === 'm7')).toBe(true);
    // And the initial values never start a form on something invalid.
    for (const t of TEMPLATES) expect(Object.keys(initialValues(t, ctx))).toEqual(t.fields.map((f) => f.id));
  });
});
