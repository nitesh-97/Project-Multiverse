import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PHASES,
  EffectError,
  LEGACY_PHASES,
  PlanError,
  attributeDelay,
  buildRetro,
  buildThriveni,
  phaseIndex,
  phaseModelOf,
  recordEvent,
  startProject,
  validatePhaseModel,
  validatePlan,
} from '../src';
import type { EventType, PhaseModel } from '../src';
import { adjust, makeEvent } from './helpers';

// A project that is not a VR training: a building. It has its own phases, and none of them is called "development".
const BUILDING: PhaseModel = {
  phases: [
    { id: 'BRIEF', name: 'Brief' },
    { id: 'DRAWINGS', name: 'Drawings' },
    { id: 'CONSTRUCTION', name: 'Construction' },
    { id: 'INSPECTION', name: 'Inspection' },
    { id: 'HANDOVER', name: 'Handover' },
  ],
  buildStarts: 'CONSTRUCTION',
  afterBuild: 'INSPECTION',
};

const building = () => startProject({ ...buildThriveni(), phases: BUILDING });
const at = (id: string, phase: string, type: EventType, effects = [adjust('m5.dev', 1)]) =>
  makeEvent(id, '2026-10-14', effects, { type, phase });

describe('the two ready-made phase models', () => {
  it('are usable', () => {
    expect(validatePhaseModel(LEGACY_PHASES)).toEqual([]);
    expect(validatePhaseModel(DEFAULT_PHASES)).toEqual([]);
  });

  it('keep the legacy list exactly as it was, so recorded data keeps its meaning', () => {
    expect(LEGACY_PHASES.phases.map((p) => p.id)).toEqual(['PLANNING', 'STORYBOARD', 'ART', 'DEVELOPMENT', 'INTERNAL_REVIEW', 'ALPHA', 'CLIENT_REVIEW', 'QA', 'BETA', 'POST_DELIVERY']);
    expect([LEGACY_PHASES.buildStarts, LEGACY_PHASES.afterBuild]).toEqual(['DEVELOPMENT', 'INTERNAL_REVIEW']);
  });

  it('give a project without phases the legacy ones, and a project with phases its own', () => {
    expect(phaseModelOf(buildThriveni())).toBe(LEGACY_PHASES);
    expect(phaseModelOf({ phases: BUILDING })).toBe(BUILDING);
    expect(phaseIndex(BUILDING, 'INSPECTION')).toBe(3);
    expect(phaseIndex(BUILDING, 'DEVELOPMENT')).toBe(-1);
  });
});

describe('checking a phase model', () => {
  const model = (over: Partial<PhaseModel>): PhaseModel => ({ ...BUILDING, ...over });

  it('accepts a project’s own phases', () => {
    expect(validatePhaseModel(BUILDING)).toEqual([]);
  });

  it('wants at least two phases', () => {
    expect(validatePhaseModel(model({ phases: [{ id: 'ONLY', name: 'Only' }], buildStarts: 'ONLY', afterBuild: 'ONLY' }))).toContain('A project needs at least two phases');
  });

  it('reports every problem at once', () => {
    const issues = validatePhaseModel({
      phases: [
        { id: 'A', name: 'A' },
        { id: 'A', name: '' },
        { id: 'has space', name: 'Spaced' },
      ],
      buildStarts: 'NOPE',
      afterBuild: 'ALSO_NOPE',
    });
    expect(issues).toEqual([
      'Phase A needs a name',
      'Phase id "has space" must not be empty or contain spaces',
      'Duplicate phase ids: A',
      'The phase where building starts ("NOPE") is not one of the phases',
      'The first phase after building ("ALSO_NOPE") is not one of the phases',
    ]);
  });

  it('wants "after building" to come after "building starts"', () => {
    expect(validatePhaseModel(model({ buildStarts: 'INSPECTION', afterBuild: 'CONSTRUCTION' }))).toEqual(['The first phase after building must come after the phase where building starts']);
    expect(validatePhaseModel(model({ buildStarts: 'INSPECTION', afterBuild: 'INSPECTION' }))).toHaveLength(1);
  });

  it('is part of checking a plan', () => {
    expect(() => validatePlan({ ...buildThriveni(), phases: BUILDING })).not.toThrow();
    expect(() => validatePlan({ ...buildThriveni(), phases: { ...BUILDING, afterBuild: 'MISSING' } })).toThrow(PlanError);
    expect(() => startProject({ ...buildThriveni(), phases: { ...BUILDING, buildStarts: 'MISSING' } })).toThrow(/not one of the phases/);
  });
});

describe('an event must be about a phase the project has', () => {
  it('is refused for a phase from another kind of project, naming the ones there are', () => {
    expect(() => recordEvent(building(), at('x', 'DEVELOPMENT', 'SCOPE_CHANGE'))).toThrow(EffectError);
    expect(() => recordEvent(building(), at('x', 'DEVELOPMENT', 'SCOPE_CHANGE'))).toThrow(/"DEVELOPMENT" is not one of this project's phases \(BRIEF, DRAWINGS, CONSTRUCTION, INSPECTION, HANDOVER\)/);
  });

  it('is accepted for one of the project’s own', () => {
    expect(() => recordEvent(building(), at('x', 'CONSTRUCTION', 'SCOPE_CHANGE'))).not.toThrow();
  });

  it('is judged by the legacy phases for a project that has none of its own', () => {
    const thriveni = startProject(buildThriveni());
    expect(() => recordEvent(thriveni, at('x', 'DEVELOPMENT', 'SCOPE_CHANGE'))).not.toThrow();
    expect(() => recordEvent(thriveni, at('y', 'BUILD', 'SCOPE_CHANGE'))).toThrow(/not one of this project's phases/);
  });

  it('is refused in a replay too, so a bad phase can never be stored and then break the history', () => {
    expect(() => [at('x', 'NOT_A_PHASE', 'SCOPE_CHANGE')].reduce(recordEvent, building())).toThrow(EffectError);
  });
});

describe('what counts as late follows the project’s own phases', () => {
  const run = (...events: ReturnType<typeof at>[]) => events.reduce(recordEvent, building());
  const category = (state: ReturnType<typeof run>, id: string) => attributeDelay(state).contributions.find((c) => c.eventId === id)?.category;

  it('calls scope found once building has started "late", and earlier scope just a scope change', () => {
    const state = run(at('early', 'DRAWINGS', 'SCOPE_CHANGE'), at('late', 'CONSTRUCTION', 'SCOPE_CHANGE'));
    expect(category(state, 'early')).toBe('Scope changes');
    expect(category(state, 'late')).toBe('Late scope discovery');
  });

  it('calls feedback from the first phase after building "late"', () => {
    const state = run(at('during', 'CONSTRUCTION', 'FEEDBACK'), at('after', 'INSPECTION', 'FEEDBACK'), at('much-after', 'HANDOVER', 'FEEDBACK'));
    expect(category(state, 'during')).toBe('Feedback');
    expect(category(state, 'after')).toBe('Late feedback');
    expect(category(state, 'much-after')).toBe('Late feedback');
  });
});

describe('the retrospective follows them too', () => {
  const state = [
    makeEvent('f1', '2026-10-13', [], { type: 'FEEDBACK', phase: 'DRAWINGS', sourceTeamId: 'lxd' }),
    makeEvent('f2', '2026-10-14', [], { type: 'CLIENT_FEEDBACK', phase: 'INSPECTION', sourceTeamId: 'lxd' }),
    makeEvent('f3', '2026-10-14', [], { type: 'FEEDBACK', phase: 'HANDOVER', sourceTeamId: 'art' }),
    makeEvent('s1', '2026-10-14', [adjust('m5.dev', 1)], { type: 'SCOPE_CHANGE', phase: 'CONSTRUCTION' }),
    makeEvent('s2', '2026-10-14', [], { type: 'REQUIREMENT_CHANGE', phase: 'BRIEF' }),
  ].reduce(recordEvent, building());
  const retro = buildRetro(state);

  it('lists the project’s phases, in order, leaving out those with no feedback', () => {
    expect(retro.feedback.byPhase.map((p) => p.phase)).toEqual(['DRAWINGS', 'INSPECTION', 'HANDOVER']);
  });

  it('counts the share after building from the project’s "first phase after building"', () => {
    expect(retro.feedback.afterDevelopment).toEqual({ count: 2, percent: 66.7 });
  });

  it('counts late scope from the project’s "building starts" phase', () => {
    expect(retro.scope).toMatchObject({ changes: 2, afterDevelopmentStarted: 1 });
  });
});
