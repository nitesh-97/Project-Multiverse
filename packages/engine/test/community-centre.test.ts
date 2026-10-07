import { describe, expect, it } from 'vitest';
import {
  COMMUNITY_CENTRE_PHASES,
  EffectError,
  attributeDelay,
  buildCommunityCentre,
  buildMilestones,
  buildModuleView,
  buildRetro,
  recordEvent,
  startProject,
  validatePhaseModel,
  validatePlan,
} from '../src';
import { adjust, makeEvent } from './helpers';

// Working-day offsets from Mon 5 Oct 2026: 10 = Fri 16 Oct, 21 = Mon 2 Nov, 28 = Wed 11 Nov, 33 = Wed 18 Nov.
const fresh = () => startProject(buildCommunityCentre());

describe('the community centre: a project that is not a VR training', () => {
  it('is a sound plan with phases of its own', () => {
    expect(() => validatePlan(buildCommunityCentre())).not.toThrow();
    expect(validatePhaseModel(COMMUNITY_CENTRE_PHASES)).toEqual([]);
    expect(COMMUNITY_CENTRE_PHASES.phases.map((p) => p.name)).toEqual(['Brief', 'Design', 'Construction', 'Inspection', 'Handover', 'After handover']);
    expect(COMMUNITY_CENTRE_PHASES).toMatchObject({ buildStarts: 'CONSTRUCTION', afterBuild: 'INSPECTION' });
  });

  it('is planned to hand over on Wed 18 Nov, 33 working days after the start', () => {
    const first = fresh().snapshots[0];
    expect(first?.forecastDelivery).toEqual({ offset: 33, date: '2026-11-18' });
    expect(first?.variance).toBe(0);
  });

  it('finishes each part when the plan says', () => {
    const modules = fresh().snapshots[0]?.modules ?? {};
    expect(Object.fromEntries(Object.entries(modules).map(([id, m]) => [id, m.forecastFinishDate]))).toEqual({
      foundations: '2026-10-16',
      structure: '2026-11-02',
      services: '2026-11-02',
      fitout: '2026-11-11',
      handover: '2026-11-18',
    });
  });

  it('has the critical path through foundations, structure, fit-out and handover', () => {
    const critical = fresh().snapshots[0]?.criticalPath ?? [];
    for (const id of ['f.survey', 'f.excavation', 'f.concrete', 's.frame', 's.roof', 'o.plaster', 'o.floor', 'h.handover']) expect(critical).toContain(id);
    expect(critical).not.toContain('v.plumbing'); // a day of float
  });

  it('has dots for every part: a start and a finish, each part finishing on its own milestone where it has one', () => {
    const dots = buildMilestones(fresh());
    expect(dots).toHaveLength(10);
    expect(dots.filter((d) => d.kind === 'MODULE_FINISH').map((d) => d.name).sort()).toEqual(
      ['Fit-out complete', 'Foundations signed off', 'Handover', 'Services done', 'Structure signed off'].sort(),
    );
  });

  it('has a module view for a part of a building just as for a part of a training', () => {
    const view = buildModuleView(fresh(), 'structure');
    expect(view.dots.map((d) => d.name)).toEqual(['Steel frame', 'Roof', 'Structure inspection', 'Structure signed off']);
    expect(view.original.finish).toEqual({ offset: 21, date: '2026-11-02' });
  });
});

describe('events speak the project’s own phases', () => {
  const rain = (phase: string) => makeEvent('rain', '2026-10-14', [adjust('f.concrete', 2)], { type: 'TASK_DELAY', phase });

  it('are accepted for a phase the project has, and refused for one from a VR training', () => {
    expect(() => recordEvent(fresh(), rain('CONSTRUCTION'))).not.toThrow();
    expect(() => recordEvent(fresh(), rain('DEVELOPMENT'))).toThrow(EffectError);
    expect(() => recordEvent(fresh(), rain('DEVELOPMENT'))).toThrow(/BRIEF, DESIGN, CONSTRUCTION, INSPECTION, HANDOVER, AFTER_HANDOVER/);
  });

  it('move handover by what they cost: two days of rain on the concrete is two days late', () => {
    const state = recordEvent(fresh(), rain('CONSTRUCTION'));
    expect(state.snapshots[state.snapshots.length - 1]).toMatchObject({ variance: 2, forecastDelivery: { offset: 35, date: '2026-11-20' } });
  });

  it('say, in the retrospective, that scope found during construction was found late, and feedback at inspection came after building', () => {
    const state = [
      makeEvent('exit', '2026-10-14', [], { type: 'SCOPE_CHANGE', phase: 'CONSTRUCTION' }),
      makeEvent('early', '2026-10-14', [], { type: 'REQUIREMENT_CHANGE', phase: 'DESIGN' }),
      makeEvent('sign', '2026-10-14', [], { type: 'FEEDBACK', phase: 'INSPECTION' }),
      makeEvent('note', '2026-10-14', [], { type: 'FEEDBACK', phase: 'CONSTRUCTION' }),
    ].reduce(recordEvent, fresh());
    const retro = buildRetro(state);
    expect(retro.scope).toMatchObject({ changes: 2, afterDevelopmentStarted: 1 });
    expect(retro.feedback.afterDevelopment).toEqual({ count: 1, percent: 50 });
    expect(retro.feedback.byPhase.map((p) => p.phase)).toEqual(['CONSTRUCTION', 'INSPECTION']);
    // None of these moved handover, so none is charged any delay.
    const shares = attributeDelay(state);
    expect(shares.totalVariance).toBe(0);
    expect(shares.byCategory.every((c) => c.days === 0)).toBe(true);
  });
});
