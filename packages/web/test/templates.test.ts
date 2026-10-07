import { describe, expect, it } from 'vitest';
import {
  TEMPLATES,
  initialCommon,
  initialValues,
  modulesFor,
  newTaskId,
  parseNumber,
  taskName,
  tasksFor,
  templateById,
  whyUnavailable,
} from '../src/lib/templates';
import type { Built, Common, Template, Values } from '../src/lib/templates';
import { event, formContext, stateWith } from './fixtures';

// Nothing reported yet, M7 not locked: M7's plan can still be refined, everything else is under way.
const ctx = formContext(stateWith(), ['m7'], '2026-10-14');
const common = (over: Partial<Common> = {}): Common => ({ ...initialCommon(ctx, 'Asha'), ...over });
const tpl = (id: string): Template => {
  const t = templateById(id);
  if (!t) throw new Error(`no template ${id}`);
  return t;
};
const build = (id: string, values: Values, over: Partial<Common> = {}): Built => tpl(id).build(values, common(over), ctx);
const ok = (b: Built) => {
  if (!b.ok) throw new Error(`expected a payload, got: ${b.problems.join(' | ')}`);
  return b;
};
const problems = (b: Built): string[] => (b.ok ? [] : b.problems);

describe('every template', () => {
  it('has a title, an example and a way to start', () => {
    for (const t of TEMPLATES) {
      expect(t.title.length).toBeGreaterThan(5);
      expect(t.example.length).toBeGreaterThan(5);
      expect(t.fields.length).toBeGreaterThan(0);
      expect(Object.keys(initialValues(t, ctx))).toEqual(t.fields.map((f) => f.id));
    }
  });

  it('has a unique id', () => {
    expect(new Set(TEMPLATES.map((t) => t.id)).size).toBe(TEMPLATES.length);
  });

  it('refuses an empty form, saying what is missing rather than sending nonsense', () => {
    for (const t of TEMPLATES) {
      const result = t.build(initialValues(t, { ...ctx, today: '' }), { ...common(), when: '', createdBy: '', title: '' }, ctx);
      expect(result.ok, t.id).toBe(false);
      expect(problems(result).length, t.id).toBeGreaterThan(0);
    }
  });

  it('asks who is recording it, and when it happened', () => {
    expect(problems(build('holiday', { date: '2026-10-28' }, { createdBy: ' ' }))).toEqual(['Say who is recording this.']);
    expect(problems(build('holiday', { date: '2026-10-28' }, { when: '14/10/2026' }))).toEqual(['Pick the date this happened.']);
  });
});

describe('a task takes longer or shorter', () => {
  it('becomes an estimate adjustment on that task, dated and attributed', () => {
    const b = ok(build('reestimate', { task: 'm5.dev', days: '1' }, { phase: 'DEVELOPMENT' }));
    expect(b.route).toBe('event');
    expect(b.draft).toEqual({
      type: 'TASK_DELAY',
      category: 'Schedule',
      title: 'm5 development takes 1 working day longer',
      description: '',
      phase: 'DEVELOPMENT',
      moduleId: 'm5',
      taskId: 'm5.dev',
      createdBy: 'Asha',
      occurredAt: '2026-10-14',
      asOf: '2026-10-14',
      effects: [{ op: 'ADJUST_ESTIMATE', taskId: 'm5.dev', delta: 1 }],
    });
    expect(b.summary).toBe('m5 development takes 1 working day longer');
  });

  it('takes a negative number for work that turned out quicker', () => {
    const b = ok(build('reestimate', { task: 'm5.dev', days: '−2' }));
    expect(b.draft).toMatchObject({ effects: [{ op: 'ADJUST_ESTIMATE', delta: -2 }], title: 'm5 development takes 2 working days less' });
  });

  it('uses the title and description the person wrote, and notes that it could have been found earlier', () => {
    const b = ok(build('reestimate', { task: 'm5.dev', days: '1' }, { title: ' Scenes were heavier ', description: 'More props than planned', couldHaveBeenEarlier: true }));
    expect(b.draft).toMatchObject({ title: 'Scenes were heavier', description: 'More props than planned', couldHaveBeenEarlier: true });
  });

  it('says what is wrong instead of guessing', () => {
    expect(problems(build('reestimate', { task: '', days: '1' }))).toEqual(['Pick the task.']);
    expect(problems(build('reestimate', { task: 'm5.dev', days: '0' }))).toEqual(['Say how many days longer or shorter (not zero).']);
    expect(problems(build('reestimate', { task: 'm5.dev', days: 'a lot' }))).toEqual(['Say how many days longer or shorter (not zero).']);
  });
});

describe('the other things that happen', () => {
  it('records a finished task', () => {
    const b = ok(build('finished', { task: 'm5.art', finishedOn: '2026-10-13' }));
    expect(b.draft).toMatchObject({ type: 'TASK_COMPLETION', taskId: 'm5.art', effects: [{ op: 'RECORD_PROGRESS', taskId: 'm5.art', finishedOn: '2026-10-13' }] });
    expect(b.summary).toBe('m5 art finished on Tue 13 Oct');
  });

  it('records progress, with an optional start date', () => {
    const plain = ok(build('progress', { task: 'm5.dev', startedOn: '', remaining: '3' }));
    expect(plain.draft).toMatchObject({ effects: [{ op: 'RECORD_PROGRESS', taskId: 'm5.dev', remaining: 3 }] });
    expect((plain.draft as { effects: Array<Record<string, unknown>> }).effects[0]).not.toHaveProperty('startedOn');
    const dated = ok(build('progress', { task: 'm5.dev', startedOn: '2026-10-14', remaining: '0' }));
    expect(dated.draft).toMatchObject({ effects: [{ startedOn: '2026-10-14', remaining: 0 }] });
    expect(problems(build('progress', { task: 'm5.dev', startedOn: '', remaining: '' }))).toEqual(['Say how much effort is left (0 or more).']);
  });

  it('records a block until a date', () => {
    const b = ok(build('blocked', { task: 'proj.qa', until: '2026-10-30' }));
    expect(b.draft).toMatchObject({ type: 'BLOCKER', effects: [{ op: 'BLOCK_UNTIL', taskId: 'proj.qa', date: '2026-10-30' }] });
  });

  it('records a team changing size', () => {
    const b = ok(build('capacity', { team: 'dev', from: '2026-10-19', headcount: '2' }));
    expect(b.draft).toMatchObject({ type: 'RESOURCE_CHANGE', sourceTeamId: 'dev', effects: [{ op: 'SET_CAPACITY', teamId: 'dev', from: '2026-10-19', headcount: 2 }] });
    expect(b.summary).toBe('Development has 2 people from Mon 19 Oct');
    expect(ok(build('capacity', { team: 'dev', from: '2026-10-19', headcount: '1' })).summary).toBe('Development has 1 person from Mon 19 Oct');
    expect(problems(build('capacity', { team: 'dev', from: '2026-10-19', headcount: '-1' }))).toEqual(['Say how many people (0 or more).']);
  });

  it('records a holiday', () => {
    const b = ok(build('holiday', { date: '2026-10-28' }));
    expect(b.draft).toMatchObject({ type: 'RESOURCE_CHANGE', effects: [{ op: 'ADD_HOLIDAY', date: '2026-10-28' }], title: 'Holiday on Wed 28 Oct' });
  });

  it('records a hand-over, adding catch-up time only when there is some', () => {
    const free = ok(build('handover', { task: 'm3.dev', person: 'Ravi', cost: '0' }));
    expect(free.draft).toMatchObject({ type: 'OWNERSHIP_TRANSFER', effects: [{ op: 'TRANSFER_OWNER', taskId: 'm3.dev', toPersonId: 'Ravi' }] });
    expect((free.draft as { effects: Array<Record<string, unknown>> }).effects[0]).not.toHaveProperty('contextCost');
    const costly = ok(build('handover', { task: 'm3.dev', person: 'Ravi', cost: '0.5' }));
    expect(costly.draft).toMatchObject({ effects: [{ contextCost: 0.5 }] });
    expect(problems(build('handover', { task: 'm3.dev', person: '', cost: '0' }))).toEqual(['Say who takes it.']);
  });

  it('records feedback with no schedule effect, from the client or from inside', () => {
    const client = ok(build('feedback', { from: 'CLIENT_FEEDBACK', team: 'lxd' }, { title: 'Alpha review: wording', phase: 'ALPHA', couldHaveBeenEarlier: true }));
    expect(client.draft).toMatchObject({ type: 'CLIENT_FEEDBACK', phase: 'ALPHA', sourceTeamId: 'lxd', effects: [], couldHaveBeenEarlier: true, title: 'Alpha review: wording' });
    expect(ok(build('feedback', { from: 'FEEDBACK', team: '' }, { title: 'Internal' })).draft).toMatchObject({ type: 'FEEDBACK' });
    expect(problems(build('feedback', { from: 'FEEDBACK', team: '' }))).toEqual(['Say what the feedback is about.']);
  });
});

describe('new work', () => {
  const values = (over: Values = {}): Values => ({ name: 'Extinguisher system', effort: '2', module: 'project', team: 'dev', after: ['proj.chg.dev'], before: 'proj.integration', kind: 'SCOPE_CHANGE', feature: 'extinguisher', ...over });

  it('becomes one task between the steps it sits between, linked to the feature', () => {
    const b = ok(build('new-work', values(), { phase: 'DEVELOPMENT' }));
    expect(b.draft).toMatchObject({
      type: 'SCOPE_CHANGE',
      phase: 'DEVELOPMENT',
      moduleId: 'project',
      linkedFeatureId: 'extinguisher',
      effects: [
        {
          op: 'ADD_TASK',
          task: { id: 'new.extinguisher-system', moduleId: 'project', teamId: 'dev', kind: 'TASK', name: 'Extinguisher system', estimate: 2, featureId: 'extinguisher' },
          dependsOn: ['proj.chg.dev'],
          blocks: ['proj.integration'],
        },
      ],
    });
    expect(b.summary).toBe('New work: Extinguisher system (2 working days)');
  });

  it('picks the event type from the kind of change', () => {
    expect(ok(build('new-work', values({ kind: 'REWORK' }))).draft).toMatchObject({ type: 'REWORK' });
    expect(ok(build('new-work', values({ kind: 'DEFECT' }))).draft).toMatchObject({ type: 'DEFECT' });
    expect(ok(build('new-work', values({ kind: 'nonsense' }))).draft).toMatchObject({ type: 'SCOPE_CHANGE' });
  });

  it('leaves out the feature link when there is none', () => {
    const b = ok(build('new-work', values({ feature: '' })));
    expect(b.draft).not.toHaveProperty('linkedFeatureId');
    expect((b.draft as { effects: Array<{ task: Record<string, unknown> }> }).effects[0]?.task).not.toHaveProperty('featureId');
  });

  it('starts straight away when it is not after anything', () => {
    const b = ok(build('new-work', values({ after: [] })));
    expect(b.draft).toMatchObject({ effects: [{ dependsOn: [] }] });
  });

  it('defaults to finishing before delivery, in the delivery part of the plan', () => {
    const v = initialValues(tpl('new-work'), ctx);
    expect(v.before).toBe('proj.delivery');
    expect(v.module).toBe('project');
    expect(v.kind).toBe('SCOPE_CHANGE');
  });

  it('refuses work that has no name, size, home, team or successor, or that waits for itself', () => {
    expect(problems(build('new-work', values({ name: '', effort: '0', module: 'nowhere', team: 'nobody', before: '' }))).sort()).toEqual(
      ['Name the work.', 'Pick the step that has to wait for it.', 'Pick the team that does it.', 'Pick where it belongs.', 'Say how much effort it is (more than 0).'].sort(),
    );
    expect(problems(build('new-work', values({ after: ['proj.integration'] })))).toEqual(['It can not start after the step that waits for it.']);
  });

  it('gives a name that is already taken a fresh id', () => {
    expect(newTaskId('Extinguisher system', [])).toBe('new.extinguisher-system');
    expect(newTaskId('Extinguisher system', ['new.extinguisher-system'])).toBe('new.extinguisher-system-2');
    expect(newTaskId('Extinguisher system', ['new.extinguisher-system', 'new.extinguisher-system-2'])).toBe('new.extinguisher-system-3');
    expect(newTaskId('  !!  ', [])).toBe('new.task');
  });
});

describe('planning changes', () => {
  it('re-estimates a task in a module that has not started', () => {
    const b = ok(build('plan-reestimate', { task: 'm7.dev', days: '3' }));
    expect(b.route).toBe('plan-edit');
    expect(b.draft).toEqual({
      title: 'm7 development re-estimated by +3 working days',
      createdBy: 'Asha',
      asOf: '2026-10-14',
      effects: [{ op: 'ADJUST_ESTIMATE', taskId: 'm7.dev', delta: 3 }],
    });
  });

  it('keeps the person’s reason', () => {
    const b = ok(build('plan-reestimate', { task: 'm7.dev', days: '3' }, { description: 'new scope agreed' }));
    expect(b.draft).toMatchObject({ reason: 'new scope agreed' });
  });

  it('adds and removes work', () => {
    const add = ok(build('plan-add', { name: 'Accessibility pass', effort: '2', module: 'm7', team: 'dev', after: ['m7.dev'], before: 'm7.alpha' }));
    expect(add.route).toBe('plan-edit');
    expect(add.draft).toMatchObject({ effects: [{ op: 'ADD_TASK', task: { id: 'new.accessibility-pass', moduleId: 'm7' }, dependsOn: ['m7.dev'], blocks: ['m7.alpha'] }] });
    const remove = ok(build('plan-remove', { task: 'm7.art' }));
    expect(remove.draft).toMatchObject({ effects: [{ op: 'REMOVE_TASK', taskId: 'm7.art' }], title: 'Plan: remove m7 art' });
  });

  it('will not add planned work to a module that has started: that is an event', () => {
    const b = build('plan-add', { name: 'Extra', effort: '1', module: 'm5', team: 'dev', after: [], before: 'm5.alpha' });
    expect(problems(b)).toEqual([expect.stringContaining('has already started')]);
  });
});

describe('what each form offers', () => {
  it('offers open tasks of started modules for events, and unstarted tasks of unlocked modules for planning', () => {
    const open = tasksFor('open', ctx).map((t) => t.id);
    expect(open).toContain('m5.dev');
    expect(open).not.toContain('m7.dev');
    expect(open.every((id) => !id.endsWith('.alpha') && id !== 'proj.delivery')).toBe(true); // no milestones
    expect(tasksFor('unstarted', ctx).map((t) => t.id).sort()).toEqual(['m7.art', 'm7.dev', 'm7.sb']);
    expect(tasksFor('any', ctx).map((t) => t.id)).toContain('proj.delivery');
    // Before anything is reported nothing has begun, so every task of a started module can be held back.
    expect(tasksFor('waiting', ctx).map((t) => t.id)).toContain('m5.dev');
    // Only a task that has not begun can be made to wait: by 14 Oct M5 development is under way, project QA is not.
    const later = formContext(stateWith([event('noop', '2026-10-14', [])]), ['m7'], '2026-10-14');
    const waiting = tasksFor('waiting', later).map((t) => t.id);
    expect(waiting).toContain('proj.qa');
    expect(waiting).not.toContain('m5.dev');
    expect(waiting).not.toContain('m7.dev'); // its module has not started: that is a planning change
  });

  it('stops offering a task once it is finished', () => {
    const later = formContext(stateWith([event('noop', '2026-10-14', [])]), ['m7'], '2026-10-14');
    expect(tasksFor('open', later).map((t) => t.id)).not.toContain('m5.sb'); // finished by then
    expect(tasksFor('open', later).map((t) => t.id)).toContain('m5.dev');
  });

  it('offers started or unstarted modules', () => {
    expect(modulesFor('started', ctx).map((m) => m.id)).toContain('project');
    expect(modulesFor('started', ctx).map((m) => m.id)).not.toContain('m7');
    expect(modulesFor('unstarted', ctx).map((m) => m.id)).toEqual(['m7']);
  });

  it('names a task so a person recognises it', () => {
    const t = ctx.tasks.find((x) => x.id === 'proj.qa');
    expect(t && taskName(ctx, t)).toBe('QA');
    const m = ctx.tasks.find((x) => x.id === 'm5.dev');
    expect(m && taskName(ctx, m)).toBe('m5 development');
    const shared = ctx.tasks.find((x) => x.id === 'shared.loc');
    expect(shared && taskName(ctx, shared)).toBe('Localization (Shared systems)');
  });

  it('says why a form can not be used, rather than opening an empty one', () => {
    expect(whyUnavailable(tpl('reestimate'), ctx)).toBeNull();
    expect(whyUnavailable(tpl('plan-reestimate'), ctx)).toBeNull();
    const allStarted = formContext(stateWith(), [], '2026-10-14');
    expect(whyUnavailable(tpl('plan-reestimate'), allStarted)).toMatch(/nothing left to plan/);
    const draft = { ...ctx, modules: ctx.modules.map((m) => ({ ...m, lockedAt: null })) };
    expect(whyUnavailable(tpl('reestimate'), draft)).toMatch(/Lock a module first/);
    expect(whyUnavailable(tpl('capacity'), { ...ctx, teams: [] })).toBe('The project has no teams.');
    const done = { ...ctx, tasks: ctx.tasks.map((t) => ({ ...t, state: 'DONE' as const })) };
    expect(whyUnavailable(tpl('finished'), done)).toBe('There is no unfinished task to choose from.');
  });
});

describe('numbers typed into a form', () => {
  it('reads what a person would type', () => {
    expect(parseNumber('2')).toBe(2);
    expect(parseNumber(' 1.5 ')).toBe(1.5);
    expect(parseNumber('−2')).toBe(-2);
    expect(parseNumber('')).toBeNull();
    expect(parseNumber('two')).toBeNull();
    expect(parseNumber(undefined)).toBeNull();
    expect(parseNumber('Infinity')).toBeNull();
  });
});

describe('what the forms leave to the engine', () => {
  it('does not need the form to know the schedule: the same answers on a later date are the same effects', () => {
    const later = tpl('reestimate').build({ task: 'm5.dev', days: '1' }, { ...common(), when: '2026-10-19' }, ctx);
    const earlier = tpl('reestimate').build({ task: 'm5.dev', days: '1' }, { ...common(), when: '2026-10-14' }, ctx);
    expect(ok(later).draft).toMatchObject({ effects: (ok(earlier).draft as { effects: unknown[] }).effects, asOf: '2026-10-19' });
  });

  it('keeps an event added by another event in the picker', () => {
    const withExt = formContext(
      stateWith([event('ext', '2026-10-14', [{ op: 'ADD_TASK', task: { id: 'proj.ext', moduleId: 'project', teamId: 'dev', kind: 'TASK', name: 'Extinguisher system', estimate: 2 }, dependsOn: ['proj.chg.dev'], blocks: ['proj.integration'] }])]),
      ['m7'],
    );
    expect(tasksFor('open', withExt).map((t) => t.id)).toContain('proj.ext');
  });
});
