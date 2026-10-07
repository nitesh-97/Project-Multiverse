import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CATEGORY_RULES,
  FALLBACK_CATEGORY,
  UNEXPLAINED,
  attributeDelay,
  buildThriveni,
  categorizeEvent,
  counterfactualStrategy,
  recordEvent,
  sequentialStrategy,
  startProject,
  voidEvent,
} from '../src';
import type { AttributionStrategy, Event, EventType, Phase, ProjectState } from '../src';
import { adjust, extinguisherEffects, makeEvent } from './helpers';

const fresh = () => startProject(buildThriveni());
const run = (...events: Event[]): ProjectState => events.reduce(recordEvent, fresh());
const finalVariance = (s: ProjectState) => s.snapshots[s.snapshots.length - 1]?.variance ?? NaN;

// Status dates: Tue 13 Oct = offset 7, Wed 14 Oct = offset 8, Wed 21 Oct = offset 13.
const lateDev = () => makeEvent('late-dev', '2026-10-13', [adjust('m2.dev', 3)], { type: 'TASK_DELAY' });
const blocked = () => makeEvent('blocked', '2026-10-14', [adjust('m5.dev', 1)], { type: 'DEPENDENCY_DELAY' });
const extinguisher = () =>
  makeEvent('ext', '2026-10-14', extinguisherEffects(), { type: 'SCOPE_CHANGE', phase: 'DEVELOPMENT' });
const m3Slip = () => makeEvent('m3-slip', '2026-10-14', [adjust('m3.dev', 3)], { type: 'TASK_DELAY' });
const m5Back = () =>
  makeEvent('m5-back', '2026-10-21', [{ op: 'RECORD_PROGRESS', taskId: 'm5.dev', finishedOn: '2026-10-21' }], {
    type: 'TASK_COMPLETION',
  });
const devCut = () =>
  makeEvent('dev-cut', '2026-10-13', [{ op: 'SET_CAPACITY', teamId: 'dev', from: '2026-10-14', headcount: 2 }], {
    type: 'RESOURCE_CHANGE',
  });

describe('sequential attribution (v1)', () => {
  const state = run(lateDev(), blocked(), extinguisher());
  const result = attributeDelay(state);

  it('gives each event the schedule change it caused, and they add up to the total', () => {
    expect(result.strategy).toBe('sequential');
    expect(result.totalVariance).toBe(3);
    expect(result.contributions).toEqual([
      { eventId: 'late-dev', kind: 'EVENT', days: 0, effortDays: 3, category: UNEXPLAINED },
      { eventId: 'blocked', kind: 'EVENT', days: 1, effortDays: 1, category: 'Dependency delays' },
      { eventId: 'ext', kind: 'EVENT', days: 2, effortDays: 14, category: 'Late scope discovery' },
    ]);
    expect(result.contributions.reduce((sum, c) => sum + c.days, 0)).toBe(result.totalVariance);
    expect(result.interaction).toBe(0);
  });

  it('rolls events up into categories, largest delay first', () => {
    expect(result.byCategory).toEqual([
      { category: 'Late scope discovery', days: 2, effortDays: 14, eventIds: ['ext'] },
      { category: 'Dependency delays', days: 1, effortDays: 1, eventIds: ['blocked'] },
      { category: UNEXPLAINED, days: 0, effortDays: 3, eventIds: ['late-dev'] },
    ]);
  });

  it('reports recovery as negative days', () => {
    const result2 = attributeDelay(run(blocked(), m5Back()));
    expect(result2.contributions.map((c) => [c.eventId, c.days])).toEqual([['blocked', 1], ['m5-back', -1]]);
    expect(result2.totalVariance).toBe(0);
    expect(result2.byCategory.map((c) => [c.category, c.days])).toEqual([['Dependency delays', 1], [UNEXPLAINED, -1]]);
  });

  it('ignores voided events entirely', () => {
    const voided = voidEvent(run(lateDev(), blocked(), extinguisher()), { kind: 'VOID', id: 'v', eventId: 'blocked', asOf: '2026-10-15' });
    const r = attributeDelay(voided);
    expect(r.contributions.map((c) => [c.eventId, c.days])).toEqual([['late-dev', 0], ['ext', 2]]);
    expect(r.totalVariance).toBe(2);
  });

  it('has nothing to say about a project with no events', () => {
    expect(attributeDelay(fresh())).toEqual({ strategy: 'sequential', totalVariance: 0, contributions: [], interaction: 0, byCategory: [] });
  });
});

describe('counterfactual attribution (v2)', () => {
  // M5 Dev +1 and M3 Dev +3 land together. M3 sets the pace (+2 overall); M5's slip hides behind it.
  const state = run(blocked(), m3Slip());

  it('differs from sequential when events overlap on the critical path', () => {
    const sequential = attributeDelay(state, { strategy: sequentialStrategy });
    expect(sequential.contributions.map((c) => c.days)).toEqual([1, 1]);

    const counterfactual = attributeDelay(state, { strategy: counterfactualStrategy });
    expect(counterfactual.strategy).toBe('counterfactual');
    expect(counterfactual.totalVariance).toBe(2);
    // Without the M5 slip the project would still be 2 late. Without the M3 slip it would be 1 late.
    expect(counterfactual.contributions.map((c) => [c.eventId, c.days])).toEqual([['blocked', 0], ['m3-slip', 1]]);
    // One day belongs to neither alone: it is the overlap, and is reported rather than given to the first event.
    expect(counterfactual.interaction).toBe(1);
  });

  it('removes events that depend on the one being removed', () => {
    // 'more' adjusts a task that only exists because of the extinguisher event.
    const more = makeEvent('more', '2026-10-14', [adjust('m1.ext', 1)], { type: 'TASK_DELAY', parentEventId: 'ext' });
    const r = attributeDelay(run(extinguisher(), more), { strategy: counterfactualStrategy });
    expect(r.contributions.map((c) => [c.eventId, c.days])).toEqual([['ext', 2], ['more', 0]]);
    expect(r.interaction).toBe(0);
    expect(r.byCategory).toEqual([
      { category: 'Late scope discovery', days: 2, effortDays: 15, eventIds: ['ext', 'more'] }, // 'more' inherits its parent's category
    ]);
  });

  it('is unaffected by voided events', () => {
    const voided = voidEvent(run(blocked(), m3Slip(), lateDev()), { kind: 'VOID', id: 'v', eventId: 'late-dev', asOf: '2026-10-15' });
    expect(attributeDelay(voided, { strategy: counterfactualStrategy }).contributions.map((c) => c.eventId)).toEqual(['blocked', 'm3-slip']);
  });
});

describe('every strategy reconciles with the project variance', () => {
  const scenarios: Array<[string, Event[]]> = [
    ['none', []],
    ['T2', [lateDev()]],
    ['T3', [blocked()]],
    ['T4', [m3Slip()]],
    ['extinguisher', [extinguisher()]],
    ['capacity cut', [devCut()]],
    ['T2 + T3 + extinguisher', [lateDev(), blocked(), extinguisher()]],
    ['overlapping slips', [blocked(), m3Slip()]],
    ['slip then recovery', [blocked(), m5Back()]],
    ['capacity cut then extinguisher', [devCut(), extinguisher()]],
  ];

  it.each(scenarios)('%s', (_name, events) => {
    const state = run(...events);
    for (const strategy of [sequentialStrategy, counterfactualStrategy]) {
      const r = attributeDelay(state, { strategy });
      const sum = r.contributions.reduce((s, c) => s + c.days, 0) + r.interaction;
      expect(sum, strategy.name).toBeCloseTo(finalVariance(state), 6);
      expect(r.totalVariance).toBe(finalVariance(state));
    }
    expect(attributeDelay(state).interaction).toBe(0); // sequential never leaves an interaction
  });
});

describe('writing your own strategy', () => {
  const state = run(lateDev(), blocked(), extinguisher());

  it('is plugged in through the options', () => {
    const evenSplit: AttributionStrategy = {
      name: 'even-split',
      attribute: ({ state: s }) => {
        const events = s.activeEvents;
        const total = finalVariance(s);
        return {
          contributions: events.map((e) => ({ eventId: e.id, days: total / events.length, effortDays: 0 })),
          interaction: 0,
        };
      },
    };
    const r = attributeDelay(state, { strategy: evenSplit });
    expect(r.strategy).toBe('even-split');
    expect(r.contributions.map((c) => c.days)).toEqual([1, 1, 1]);
    expect(r.contributions.map((c) => c.category)).toEqual([UNEXPLAINED, 'Dependency delays', 'Late scope discovery']);
  });

  it('may report everything as interaction', () => {
    const shrug: AttributionStrategy = { name: 'shrug', attribute: ({ state: s }) => ({ contributions: [], interaction: finalVariance(s) }) };
    const r = attributeDelay(state, { strategy: shrug });
    expect(r.interaction).toBe(3);
    expect(r.byCategory).toEqual([]);
  });

  it('is rejected if its numbers do not add up, so days cannot be silently lost or invented', () => {
    const lossy: AttributionStrategy = {
      name: 'lossy',
      attribute: ({ state: s }) => ({
        contributions: s.activeEvents.map((e) => ({ eventId: e.id, days: 0.5, effortDays: 0 })),
        interaction: 0,
      }),
    };
    expect(() => attributeDelay(state, { strategy: lossy })).toThrow(/"lossy" does not reconcile: .* 1.5 days but the project variance is 3/);
  });
});

describe('categories', () => {
  const ev = (type: EventType, phase: Phase = 'DEVELOPMENT', extra: Partial<Event> = {}) =>
    makeEvent(`${type}-${phase}`, '2026-10-14', [], { type, phase, ...extra });

  it.each<[EventType, Phase, string]>([
    ['SCOPE_CHANGE', 'PLANNING', 'Scope changes'],
    ['SCOPE_CHANGE', 'STORYBOARD', 'Scope changes'],
    ['SCOPE_CHANGE', 'DEVELOPMENT', 'Late scope discovery'],
    ['REQUIREMENT_CHANGE', 'ALPHA', 'Late scope discovery'],
    ['REQUIREMENT_CHANGE', 'ART', 'Scope changes'],
    ['FEEDBACK', 'ART', 'Feedback'],
    ['FEEDBACK', 'DEVELOPMENT', 'Feedback'],
    ['FEEDBACK', 'INTERNAL_REVIEW', 'Late feedback'],
    ['FEEDBACK', 'QA', 'Late feedback'],
    ['CLIENT_FEEDBACK', 'CLIENT_REVIEW', 'Client feedback'],
    ['RESOURCE_CHANGE', 'DEVELOPMENT', 'Capacity changes'],
    ['OWNERSHIP_TRANSFER', 'DEVELOPMENT', 'Capacity changes'],
    ['BLOCKER', 'DEVELOPMENT', 'Dependency delays'],
    ['DEPENDENCY_DELAY', 'ART', 'Dependency delays'],
    ['REWORK', 'QA', 'Rework'],
    ['DEFECT', 'QA', 'Rework'],
    ['TECHNICAL_DECISION', 'DEVELOPMENT', 'Technical decisions'],
    ['MILESTONE_CHANGE', 'PLANNING', 'Milestone changes'],
    ['TASK_DELAY', 'DEVELOPMENT', UNEXPLAINED],
    ['TASK_COMPLETION', 'DEVELOPMENT', UNEXPLAINED],
  ])('%s during %s is "%s"', (type, phase, expected) => {
    const event = ev(type, phase);
    expect(categorizeEvent(event, [event])).toBe(expected);
  });

  it('gives a delay that names an explaining event that event\'s category', () => {
    const parent = makeEvent('why', '2026-10-13', [], { type: 'SCOPE_CHANGE', phase: 'DEVELOPMENT' });
    const child = makeEvent('slip', '2026-10-14', [], { type: 'TASK_DELAY', parentEventId: 'why' });
    expect(categorizeEvent(child, [parent, child])).toBe('Late scope discovery');
    expect(categorizeEvent(child, [child])).toBe(UNEXPLAINED); // parent not found
  });

  it('follows a chain of explanations but never loops', () => {
    const a = makeEvent('a', '2026-10-14', [], { type: 'TASK_DELAY', parentEventId: 'b' });
    const b = makeEvent('b', '2026-10-14', [], { type: 'TASK_DELAY', parentEventId: 'a' });
    expect(categorizeEvent(a, [a, b])).toBe(UNEXPLAINED);
    const root = makeEvent('root', '2026-10-14', [], { type: 'BLOCKER' });
    const mid = makeEvent('mid', '2026-10-14', [], { type: 'TASK_DELAY', parentEventId: 'root' });
    const leaf = makeEvent('leaf', '2026-10-14', [], { type: 'TASK_DELAY', parentEventId: 'mid' });
    expect(categorizeEvent(leaf, [root, mid, leaf])).toBe('Dependency delays');
  });

  it('uses the rules it is given, and falls back when none match', () => {
    const event = ev('BLOCKER');
    expect(categorizeEvent(event, [event], [{ category: 'Everything', matches: () => true }])).toBe('Everything');
    expect(categorizeEvent(event, [event], [])).toBe(FALLBACK_CATEGORY);
  });

  it('can be reconfigured for a whole attribution', () => {
    const rules = [
      { category: 'Needs discussion', matches: (e: Event) => e.type === 'SCOPE_CHANGE' },
      ...DEFAULT_CATEGORY_RULES,
    ];
    const r = attributeDelay(run(extinguisher()), { rules });
    expect(r.byCategory.map((c) => c.category)).toEqual(['Needs discussion']);
  });
});
