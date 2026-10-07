import { describe, expect, it } from 'vitest';
import { buildThriveni, findAdvisories, recordEvent, schedule, startProject } from '../src';
import type { Advisory, ProjectState } from '../src';
import { makeEvent } from './helpers';

const fresh = () => startProject(buildThriveni());
const noop = (id: string, asOf: string) => makeEvent(id, asOf, []);
const unconfirmed = (s: ProjectState): Advisory[] => findAdvisories(s.plan).filter((a) => a.rule === 'UNCONFIRMED_COMPLETION');
const ids = (s: ProjectState) => unconfirmed(s).map((a) => a.taskId);

describe('tasks the forecast assumes are finished', () => {
  // By the end of Wed 14 Oct (offset 8): 14 module tasks (storyboard and art, plus M3/M4/M5/M7 art) and 3 shared tasks
  // are forecast finished, and nobody has said so.
  const state = recordEvent(fresh(), noop('n', '2026-10-14'));

  it('are flagged, earliest forecast finish first', () => {
    const a = unconfirmed(state);
    expect(a).toHaveLength(17);
    expect(a.slice(0, 4).map((x) => x.taskId)).toEqual(['m1.sb', 'm2.sb', 'm4.sb', 'm6.sb']); // all forecast for Tue 6 Oct
    expect(ids(state)).toContain('m5.art');
    expect(ids(state)).toContain('shared.loc');
  });

  it('say when the task was forecast to finish and what to do', () => {
    const m5art = unconfirmed(state).find((a) => a.taskId === 'm5.art');
    expect(m5art).toMatchObject({
      rule: 'UNCONFIRMED_COMPLETION',
      severity: 'WARNING',
      moduleId: 'm5',
      forecastFinish: '2026-10-13',
    });
    expect(m5art?.message).toBe('Assumed finished: "m5 art" (m5.art) was forecast to finish on 2026-10-13 and nobody has recorded it.');
    expect(m5art?.recommendation).toBe('Record its progress: confirm it is done, or say how much is left.');
  });

  it('are never milestones, and never work that is merely under way', () => {
    expect(ids(state).some((id) => id?.endsWith('.alpha') || id === 'proj.delivery')).toBe(false);
    expect(ids(state)).not.toContain('m5.dev'); // started on Wed 14 Oct, not finished
  });

  it('do not change the forecast: the flag is advice, the schedule is unaffected', () => {
    expect(schedule(state.plan, '2026-10-14').delivery.finish).toBe(20);
  });

  it('are not flagged at all before the forecast has finished anything', () => {
    expect(unconfirmed(fresh())).toEqual([]);
  });
});

describe('confirming', () => {
  it('recording a task as finished clears its flag, and only its flag', () => {
    const state = recordEvent(
      fresh(),
      makeEvent('confirm', '2026-10-14', [{ op: 'RECORD_PROGRESS', taskId: 'm1.sb', startedOn: '2026-10-05', finishedOn: '2026-10-06' }]),
    );
    expect(ids(state)).not.toContain('m1.sb');
    expect(ids(state)).toContain('m2.sb');
    expect(unconfirmed(state)).toHaveLength(16);
  });

  it('stays confirmed through later events', () => {
    // By Thu 22 Oct (offset 14) M5 development has been forecast finished (Wed 21 Oct) and nobody said so.
    const state = [
      makeEvent('confirm', '2026-10-14', [{ op: 'RECORD_PROGRESS', taskId: 'm1.sb', finishedOn: '2026-10-06' }]),
      noop('later', '2026-10-22'),
    ].reduce(recordEvent, fresh());
    expect(ids(state)).not.toContain('m1.sb'); // confirmed once, stays confirmed
    expect(ids(state)).toContain('m5.dev'); // newly assumed
  });

  it('a recorded actual that is later than forecast is a confirmation too, and the forecast follows it', () => {
    const state = recordEvent(
      fresh(),
      makeEvent('late', '2026-10-14', [{ op: 'RECORD_PROGRESS', taskId: 'm5.art', finishedOn: '2026-10-14' }]),
    );
    expect(ids(state)).not.toContain('m5.art');
    expect(state.schedule.tasks['m5.dev']?.start).toBe(8); // M5 art finished at offset 8, not 7
  });
});

describe('work someone recorded as started', () => {
  // M5 development is forecast Wed 14 Oct to Wed 21 Oct. Someone records it as started with 4 days left on Thu 15 Oct.
  const recorded = makeEvent('started', '2026-10-15', [{ op: 'RECORD_PROGRESS', taskId: 'm5.dev', startedOn: '2026-10-14', remaining: 4 }]);

  it('is not flagged while it is merely carried on', () => {
    const state = [recorded, noop('mid', '2026-10-19')].reduce(recordEvent, fresh());
    expect(ids(state)).not.toContain('m5.dev');
    expect(state.plan.tasks.find((t) => t.id === 'm5.dev')?.progress?.assumed).toBeUndefined();
  });

  it('is flagged once the forecast finishes it without a recorded finish', () => {
    const state = [recorded, noop('after', '2026-10-22')].reduce(recordEvent, fresh());
    expect(unconfirmed(state).find((a) => a.taskId === 'm5.dev')?.forecastFinish).toBe('2026-10-21');
  });

  it('is not flagged if the finish is recorded', () => {
    const state = [recorded, makeEvent('done', '2026-10-22', [{ op: 'RECORD_PROGRESS', taskId: 'm5.dev', finishedOn: '2026-10-21' }])].reduce(recordEvent, fresh());
    expect(ids(state)).not.toContain('m5.dev');
  });
});
