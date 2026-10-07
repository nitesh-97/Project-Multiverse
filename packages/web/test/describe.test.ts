import { buildThriveni, explainSnapshot, recordPlanEdit, startProject, voidEvent } from '@multiverse/engine';
import type { Effect } from '@multiverse/engine';
import { describe, expect, it } from 'vitest';
import { describeEffect } from '../src/lib/describe';
import type { Names } from '../src/lib/describe';
import { summarizeChange } from '../src/lib/explain';
import { adjust, event, stateWith } from './fixtures';

const names: Names = {
  task: (id) => ({ 'm5.dev': 'M5 development', 'proj.integration': 'Integration', 'proj.chg.dev': 'Client changes' })[id] ?? id,
  team: (id) => ({ dev: 'Development' })[id] ?? id,
  module: (id) => ({ project: 'Delivery' })[id] ?? id,
};

describe('describing effects', () => {
  const say = (e: Effect) => describeEffect(e, names);

  it('says each one in plain words', () => {
    expect(say(adjust('m5.dev', 1))).toBe('M5 development +1 working day');
    expect(say(adjust('m5.dev', -2))).toBe('M5 development −2 working days');
    expect(say({ op: 'REMOVE_TASK', taskId: 'm5.dev' })).toBe('Remove M5 development');
    expect(say({ op: 'ADD_DEPENDENCY', predecessorId: 'm5.dev', successorId: 'proj.integration' })).toBe('Integration now waits for M5 development');
    expect(say({ op: 'REMOVE_DEPENDENCY', predecessorId: 'm5.dev', successorId: 'proj.integration' })).toBe('Integration no longer waits for M5 development');
    expect(say({ op: 'BLOCK_UNTIL', taskId: 'm5.dev', date: '2026-10-20' })).toBe('M5 development can not start before Tue 20 Oct');
    expect(say({ op: 'BLOCK_UNTIL', taskId: 'm5.dev', date: null })).toBe('M5 development is no longer blocked');
    expect(say({ op: 'SET_CAPACITY', teamId: 'dev', from: '2026-10-19', headcount: 2 })).toBe('Development has 2 people from Mon 19 Oct');
    expect(say({ op: 'ADD_HOLIDAY', date: '2026-10-28' })).toBe('Holiday on Wed 28 Oct');
  });

  it('describes new work with where it sits', () => {
    const text = say({
      op: 'ADD_TASK',
      task: { id: 'proj.ext', moduleId: 'project', teamId: 'dev', kind: 'TASK', name: 'Extinguisher system', estimate: 2 },
      dependsOn: ['proj.chg.dev'],
      blocks: ['proj.integration'],
    });
    expect(text).toBe('Add “Extinguisher system” (2 working days) to Delivery, after Client changes, before Integration');
  });

  it('describes progress by whatever was recorded', () => {
    expect(say({ op: 'RECORD_PROGRESS', taskId: 'm5.dev', finishedOn: '2026-10-21' })).toBe('M5 development: finished Wed 21 Oct');
    expect(say({ op: 'RECORD_PROGRESS', taskId: 'm5.dev', startedOn: '2026-10-14', remaining: 3 })).toBe('M5 development: started Wed 14 Oct, 3 working days left');
    expect(say({ op: 'RECORD_PROGRESS', taskId: 'm5.dev' })).toBe('M5 development: progress recorded');
  });

  it('mentions the catch-up time of a hand-over only when there is some', () => {
    expect(say({ op: 'TRANSFER_OWNER', taskId: 'm5.dev', toPersonId: 'Asha' })).toBe('M5 development handed to Asha');
    expect(say({ op: 'TRANSFER_OWNER', taskId: 'm5.dev', toPersonId: 'Asha', contextCost: 0.5 })).toBe('M5 development handed to Asha (0.5 working days to catch up)');
  });
});

describe('summarising a change', () => {
  const explained = (state: ReturnType<typeof stateWith>) => {
    const n = state.snapshots.length;
    return explainSnapshot(state.snapshots[n - 2]!, state.snapshots[n - 1]!);
  };

  it('says when delivery moves, and by how much', () => {
    const s = summarizeChange(explained(stateWith([event('slip', '2026-10-14', [adjust('m5.dev', 1)])])));
    expect(s.headline).toBe('Delivery moves later, from Fri 30 Oct to Mon 2 Nov (+1 working day).');
    expect(s.facts).toContain('It adds 1 working day of effort.');
  });

  it('says when delivery moves earlier', () => {
    const state = stateWith([event('slip', '2026-10-14', [adjust('m5.dev', 1)]), event('back', '2026-10-15', [adjust('m5.dev', -1)])]);
    expect(summarizeChange(explained(state)).headline).toBe('Delivery moves earlier, from Mon 2 Nov to Fri 30 Oct (−1 working day).');
  });

  it('says when float absorbed the slip', () => {
    const s = summarizeChange(explained(stateWith([event('m2', '2026-10-13', [adjust('m2.dev', 3)])])));
    expect(s.headline).toBe('Delivery does not move: float absorbed the slip.');
  });

  it('says so when nothing moved', () => {
    expect(summarizeChange(explained(stateWith([event('quiet', '2026-10-14', [])]))).headline).toBe('Delivery does not move.');
  });

  it('names what became critical and what stopped being', () => {
    const state = stateWith([event('m3', '2026-10-14', [adjust('m3.dev', 3)])]);
    const s = summarizeChange(explained(state), new Map([['m3.dev', 'M3 development']]));
    expect(s.facts.some((f) => f.includes('The critical path changes') && f.includes('M3 development'))).toBe(true);
  });

  it('calls a planning change planning, not delay', () => {
    const state = recordPlanEdit(startProject(buildThriveni()), { id: 'longer-m7', title: 'M7 re-estimated', createdBy: 'p', asOf: '2026-10-06', effects: [{ op: 'ADJUST_ESTIMATE', taskId: 'm7.dev', delta: 3 }] });
    const s = summarizeChange(explained(state));
    expect(s.headline).toBe('The plan itself moves +1 working day. This is planning, not delay.');
    expect(s.facts).toContain('Forecast delivery: Fri 30 Oct → Mon 2 Nov.');
  });

  it('describes withdrawing an event', () => {
    const slipped = stateWith([event('slip', '2026-10-14', [adjust('m5.dev', 1)])]);
    const withdrawn = voidEvent(slipped, { kind: 'VOID', id: 'v1', eventId: 'slip', asOf: '2026-10-15' });
    const s = summarizeChange(explained(withdrawn));
    expect(s.headline).toBe('Withdrawing it brings delivery forward by 1 working day.');
    expect(s.facts).toContain('Forecast delivery: Mon 2 Nov → Fri 30 Oct.');
  });
});
