import { COMMUNITY_CENTRE_PHASES, LEGACY_PHASES } from '@multiverse/engine';
import { afterEach, describe, expect, it } from 'vitest';
import { COMMUNITY_CENTRE_ID, seedCommunityCentre, seedCommunityCentreEvents, seedDemoProjects, seedThriveni } from '../src/seed';
import { makeApp } from './helpers';
import type { TestApp } from './helpers';

let app: TestApp;
afterEach(async () => app.close());

describe('the sample projects', () => {
  it('include a community centre with phases of its own, not a VR training', async () => {
    app = makeApp();
    seedCommunityCentre(app.service);
    const view = (await app.get(`/projects/${COMMUNITY_CENTRE_ID}`)).body;
    expect(view.project).toMatchObject({ id: 'centre', name: 'Community centre', targetDate: '2026-11-18' });
    expect(view.project.phases).toEqual(COMMUNITY_CENTRE_PHASES);
    expect(view.modules.map((m: { name: string }) => m.name)).toEqual(['Foundations', 'Structure', 'Fit-out', 'Services', 'Inspection and handover']);
    expect(view.modules.every((m: { lockedAt: string | null }) => m.lockedAt !== null)).toBe(true);
    expect((await app.get(`/projects/${COMMUNITY_CENTRE_ID}/forecast`)).body.forecastDelivery).toEqual({ offset: 33, date: '2026-11-18' });
  });

  it('record its demo events: rain, a second fire exit and an inspector’s note put handover back to Mon 23 Nov', async () => {
    app = makeApp();
    seedCommunityCentre(app.service);
    seedCommunityCentreEvents(app.service);
    const forecast = (await app.get(`/projects/${COMMUNITY_CENTRE_ID}/forecast`)).body;
    expect(forecast.variance).toBe(3);
    expect(forecast.forecastDelivery.date).toBe('2026-11-23');
    expect(forecast.target).toEqual({ date: '2026-11-18', daysToSpare: -3 });
    const retro = (await app.get(`/projects/${COMMUNITY_CENTRE_ID}/retro`)).body;
    expect(retro.scope).toMatchObject({ changes: 1, afterDevelopmentStarted: 1 });
    expect(retro.feedback.afterDevelopment).toEqual({ count: 1, percent: 100 });
  });

  it('are refused a phase from the other sample, in both directions', async () => {
    app = makeApp();
    seedCommunityCentre(app.service);
    seedThriveni(app.service);
    const event = (project: string, phase: string) =>
      app.post(`/projects/${project}/events`, { type: 'FEEDBACK', title: 'x', phase, createdBy: 't', occurredAt: '2026-10-14', effects: [] });
    expect((await event('centre', 'DEVELOPMENT')).status).toBe(422);
    expect((await event('thriveni', 'CONSTRUCTION')).status).toBe(422);
    expect((await event('centre', 'CONSTRUCTION')).status).toBe(201);
    expect((await event('thriveni', 'DEVELOPMENT')).status).toBe(201);
    expect((await app.get('/projects/thriveni')).body.project.phases).toEqual(LEGACY_PHASES);
  });

  it('can be seeded beside each other, and each can leave a module unlocked', async () => {
    app = makeApp();
    seedThriveni(app.service);
    seedCommunityCentre(app.service, 'centre', { leaveUnlocked: ['fitout'] });
    const modules = (await app.get('/projects/centre')).body.modules as Array<{ id: string; lockedAt: string | null }>;
    expect(modules.find((m) => m.id === 'fitout')?.lockedAt).toBeNull();
    expect(modules.filter((m) => m.lockedAt !== null)).toHaveLength(4);
    expect(() => seedCommunityCentre(app.service, 'other', { leaveUnlocked: ['nope'] })).toThrow(/Unknown module/);
  });

  it('give the project and module views for a building as for a training', async () => {
    app = makeApp();
    seedCommunityCentre(app.service);
    seedCommunityCentreEvents(app.service);
    const timeline = (await app.get('/projects/centre/timeline')).body;
    expect(timeline.milestones).toHaveLength(10); // a start and a finish for each of the five parts; the fire exit is not a milestone unless flagged
    const structure = (await app.get('/projects/centre/modules/structure/timeline')).body;
    expect(structure.dots.map((d: { taskId: string }) => d.taskId)).toContain('s.exit');
    expect(structure.branches.some((b: { taskId: string }) => b.taskId === 's.exit')).toBe(true);
  });

  it('are all loaded together by the one-command demo, each in the state the testing guide describes', async () => {
    app = makeApp();
    expect(seedDemoProjects(app.service)).toEqual(['thriveni', 'draft', 'fresh', 'centre']);
    const forecast = async (id: string) => (await app.get(`/projects/${id}/forecast`)).body;
    expect((await forecast('thriveni')).forecastDelivery.date).toBe('2026-11-04'); // three demo events
    expect((await forecast('draft')).forecastDelivery.date).toBe('2026-10-30'); // nothing recorded
    expect((await forecast('fresh')).forecastDelivery.date).toBe('2026-10-30');
    expect((await forecast('centre')).forecastDelivery.date).toBe('2026-11-23'); // rain, a second fire exit
    const draft = (await app.get('/projects/draft')).body.modules as Array<{ id: string; lockedAt: string | null }>;
    expect(draft.filter((m) => m.lockedAt === null).map((m) => m.id)).toEqual(['m7']); // left open for planning changes
    expect(((await app.get('/projects')).body as Array<{ name: string }>).map((p) => p.name)).toEqual(['Thriveni VR Training', 'Thriveni VR Training', 'Thriveni VR Training', 'Community centre']);
  });
});
