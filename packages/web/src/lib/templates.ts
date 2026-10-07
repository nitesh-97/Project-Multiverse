import type { CurrentTask, Effect, EventType, Feature, ModuleInfo, Phase, PhaseModel, PlanEditEffect, Team } from '@multiverse/engine';
import { formatDate } from './dates';
import { signedDays, workingDays } from './format';

/**
 * The standard things that happen to a project, each as a short form (DESIGN.md §8: buttons and example text for the
 * usual cases). A template turns a few answers into the exact payload the API expects, so a person never has to know
 * what an "effect" is. Pure: no DOM, no network; the server tests post what these build to the real API.
 */

export type Values = Record<string, string | string[]>;

export type FieldKind = 'task' | 'tasks' | 'team' | 'module' | 'feature' | 'number' | 'date' | 'text' | 'choice';

/** Which tasks a task field offers. */
export type TaskScope =
  /** Unfinished tasks of modules that have started: what an event can change. */
  | 'open'
  /** Tasks of started modules that have not begun: the only ones that can be made to wait. */
  | 'waiting'
  /** Unfinished tasks of modules that have not started: what a planning change can reshape. */
  | 'unstarted'
  /** Anything that can be waited for: every unfinished task and milestone. */
  | 'any';

/** Which modules a module field offers: those whose execution has started (events) or has not (planning changes). */
export type ModuleScope = 'started' | 'unstarted';

export interface Field {
  id: string;
  label: string;
  kind: FieldKind;
  required?: boolean;
  help?: string;
  placeholder?: string;
  /** For `choice`. */
  options?: ReadonlyArray<{ value: string; label: string }>;
  /** For `task` and `tasks`. */
  scope?: TaskScope;
  /** For `module`. */
  moduleScope?: ModuleScope;
  /** For `number`. */
  min?: number;
  step?: number;
  suffix?: string;
  /** What the field starts as, given what the project looks like now. */
  initial?: (ctx: FormContext) => string | string[];
}

export interface FormContext {
  /** The date a form starts on: the later of today and the last status date. */
  today: string;
  tasks: readonly CurrentTask[];
  teams: readonly Team[];
  modules: readonly ModuleInfo[];
  features: readonly Feature[];
  /** The delivery milestone: new work must finish before it. */
  deliveryTaskId: string | null;
  /** The project's own phases. */
  phases: PhaseModel;
}

/** What every form asks, whatever it is about. */
export interface Common {
  /** When it happened, and the status date for the forecast it triggers. */
  when: string;
  phase: Phase;
  /** Left empty, the template's own summary is used. */
  title: string;
  description: string;
  createdBy: string;
  couldHaveBeenEarlier: boolean;
}

export interface EventDraft {
  type: EventType;
  category: string;
  title: string;
  description: string;
  phase: Phase;
  moduleId?: string;
  taskId?: string;
  createdBy: string;
  sourceTeamId?: string;
  occurredAt: string;
  asOf: string;
  couldHaveBeenEarlier?: boolean;
  linkedFeatureId?: string;
  effects: Effect[];
}

export interface PlanEditDraft {
  title: string;
  reason?: string;
  createdBy: string;
  asOf: string;
  effects: PlanEditEffect[];
}

export type Built =
  | { ok: true; route: 'event'; draft: EventDraft; summary: string }
  | { ok: true; route: 'plan-edit'; draft: PlanEditDraft; summary: string }
  | { ok: false; problems: string[] };

export interface Template {
  id: string;
  group: 'What happened' | 'People and calendar' | 'Scope' | 'Feedback' | 'Planning';
  title: string;
  /** One line of example text, shown on the button. */
  example: string;
  /** An event records something that happened to work that has started; a plan edit refines work that has not. */
  route: 'event' | 'plan-edit';
  fields: readonly Field[];
  /** Ask where the project was when this came up? Feedback and scope do; a holiday does not matter. */
  asksPhase: boolean;
  build: (values: Values, common: Common, ctx: FormContext) => Built;
}

// ---------------------------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------------------------

const text = (v: string | string[] | undefined): string => (Array.isArray(v) ? (v[0] ?? '') : (v ?? '')).trim();
const list = (v: string | string[] | undefined): string[] => (Array.isArray(v) ? v : v ? [v] : []).filter((s) => s.trim() !== '');

/** A number typed into a form; empty and nonsense are both `null`. */
export function parseNumber(v: string | string[] | undefined): number | null {
  const s = text(v);
  if (s === '') return null;
  const n = Number(s.replace('−', '-'));
  return Number.isFinite(n) ? n : null;
}

const isDate = (s: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));

const fail = (...problems: string[]): Built => ({ ok: false, problems });

const taskOf = (ctx: FormContext, id: string): CurrentTask | undefined => ctx.tasks.find((t) => t.id === id);
const moduleName = (ctx: FormContext, id: string): string => ctx.modules.find((m) => m.id === id)?.name ?? id;

/**
 * "M5 development" reads better than "m5.dev": the task's own name. The module is added only where it tells a person
 * something: "Localization" alone does not say it belongs to the shared systems, "QA" in the delivery part of the
 * plan needs no explaining.
 */
export function taskName(ctx: Pick<FormContext, 'modules'>, task: Pick<CurrentTask, 'name' | 'moduleId'>): string {
  const mod = ctx.modules.find((m) => m.id === task.moduleId);
  if (!mod || mod.kind === 'PROJECT') return task.name;
  const name = task.name.toLowerCase();
  return name.includes(mod.name.toLowerCase()) || name.startsWith(task.moduleId.toLowerCase()) ? task.name : `${task.name} (${mod.name})`;
}

/** An unused id for a task a person has just named: "new.extinguisher-system", then "-2", "-3". */
export function newTaskId(name: string, existing: readonly string[]): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'task';
  let id = `new.${slug}`;
  for (let n = 2; existing.includes(id); n++) id = `new.${slug}-${n}`;
  return id;
}

/** Which modules a module field offers. */
export function modulesFor(scope: ModuleScope, ctx: FormContext): ModuleInfo[] {
  return ctx.modules.filter((m) => (scope === 'started' ? m.lockedAt !== null : m.lockedAt === null));
}

/** Which tasks a task field offers. */
export function tasksFor(scope: TaskScope, ctx: FormContext): CurrentTask[] {
  switch (scope) {
    case 'open':
      return ctx.tasks.filter((t) => t.kind === 'TASK' && t.state !== 'DONE' && t.moduleLocked);
    case 'waiting':
      return ctx.tasks.filter((t) => t.kind === 'TASK' && t.state === 'NOT_STARTED' && t.moduleLocked);
    case 'unstarted':
      return ctx.tasks.filter((t) => t.kind === 'TASK' && t.state === 'NOT_STARTED' && !t.moduleLocked);
    case 'any':
      return ctx.tasks.filter((t) => t.state !== 'DONE');
  }
}

const eventOf = (
  common: Common,
  base: Pick<EventDraft, 'type' | 'category' | 'effects'> & Partial<EventDraft>,
  summary: string,
): Built => ({
  ok: true,
  route: 'event',
  summary,
  draft: {
    ...base,
    title: common.title.trim() || summary,
    description: common.description.trim(),
    phase: common.phase,
    createdBy: common.createdBy.trim(),
    occurredAt: common.when,
    asOf: common.when,
    ...(common.couldHaveBeenEarlier ? { couldHaveBeenEarlier: true } : {}),
  },
});

function checkCommon(common: Common): string[] {
  const problems: string[] = [];
  if (!isDate(common.when)) problems.push('Pick the date this happened.');
  if (common.createdBy.trim() === '') problems.push('Say who is recording this.');
  return problems;
}

/** A phase's name as the project calls it; an id the project does not have is shown as it is. */
export const phaseName = (model: PhaseModel, id: Phase): string => model.phases.find((p) => p.id === id)?.name ?? id;

/** The choices for a "where was the project?" question, in the project's own order. */
export const phaseOptions = (model: PhaseModel): Array<{ value: string; label: string }> => model.phases.map((p) => ({ value: p.id, label: p.name }));

// ---------------------------------------------------------------------------------------------------------------
// The templates
// ---------------------------------------------------------------------------------------------------------------

const reestimate: Template = {
  id: 'reestimate',
  group: 'What happened',
  title: 'A task takes longer or shorter',
  example: 'The report draft needs 1 more day',
  route: 'event',
  asksPhase: true,
  fields: [
    { id: 'task', label: 'Which task?', kind: 'task', scope: 'open', required: true },
    { id: 'days', label: 'Change in effort', kind: 'number', required: true, step: 0.5, suffix: 'working days', initial: () => '1', help: 'Use a minus for work that turned out quicker.' },
  ],
  build(v, common, ctx) {
    const task = taskOf(ctx, text(v.task));
    const days = parseNumber(v.days);
    const problems = [...checkCommon(common)];
    if (!task) problems.push('Pick the task.');
    if (days === null || days === 0) problems.push('Say how many days longer or shorter (not zero).');
    if (problems.length > 0 || !task || days === null) return fail(...problems);
    return eventOf(
      common,
      { type: 'TASK_DELAY', category: 'Schedule', moduleId: task.moduleId, taskId: task.id, effects: [{ op: 'ADJUST_ESTIMATE', taskId: task.id, delta: days }] },
      `${taskName(ctx, task)} takes ${workingDays(days)} ${days > 0 ? 'longer' : 'less'}`,
    );
  },
};

const finished: Template = {
  id: 'finished',
  group: 'What happened',
  title: 'A task is finished',
  example: 'The site survey was finished on Tuesday',
  route: 'event',
  asksPhase: false,
  fields: [
    { id: 'task', label: 'Which task?', kind: 'task', scope: 'open', required: true },
    { id: 'finishedOn', label: 'Finished on', kind: 'date', required: true, initial: (c) => c.today, help: 'The last day anyone worked on it.' },
  ],
  build(v, common, ctx) {
    const task = taskOf(ctx, text(v.task));
    const on = text(v.finishedOn);
    const problems = [...checkCommon(common)];
    if (!task) problems.push('Pick the task.');
    if (!isDate(on)) problems.push('Pick the day it finished.');
    if (problems.length > 0 || !task) return fail(...problems);
    return eventOf(
      common,
      { type: 'TASK_COMPLETION', category: 'Progress', moduleId: task.moduleId, taskId: task.id, effects: [{ op: 'RECORD_PROGRESS', taskId: task.id, finishedOn: on }] },
      `${taskName(ctx, task)} finished on ${formatDate(on)}`,
    );
  },
};

const progress: Template = {
  id: 'progress',
  group: 'What happened',
  title: 'Report progress on a task',
  example: 'The report draft has 3 days of work left',
  route: 'event',
  asksPhase: false,
  fields: [
    { id: 'task', label: 'Which task?', kind: 'task', scope: 'open', required: true },
    { id: 'startedOn', label: 'Started on', kind: 'date', help: 'Leave empty if you are not changing it.' },
    { id: 'remaining', label: 'Effort still to do', kind: 'number', required: true, min: 0, step: 0.5, suffix: 'working days' },
  ],
  build(v, common, ctx) {
    const task = taskOf(ctx, text(v.task));
    const remaining = parseNumber(v.remaining);
    const started = text(v.startedOn);
    const problems = [...checkCommon(common)];
    if (!task) problems.push('Pick the task.');
    if (remaining === null || remaining < 0) problems.push('Say how much effort is left (0 or more).');
    if (started !== '' && !isDate(started)) problems.push('The start date is not a real date.');
    if (problems.length > 0 || !task || remaining === null) return fail(...problems);
    return eventOf(
      common,
      {
        type: 'TASK_COMPLETION',
        category: 'Progress',
        moduleId: task.moduleId,
        taskId: task.id,
        effects: [{ op: 'RECORD_PROGRESS', taskId: task.id, ...(started !== '' ? { startedOn: started } : {}), remaining }],
      },
      `${taskName(ctx, task)} has ${workingDays(remaining)} left`,
    );
  },
};

const blocked: Template = {
  id: 'blocked',
  group: 'What happened',
  title: 'A task is blocked until a date',
  example: 'Testing can not start until the client signs off on 3 Nov',
  route: 'event',
  asksPhase: true,
  fields: [
    { id: 'task', label: 'Which task can not start yet?', kind: 'task', scope: 'waiting', required: true, help: 'Only tasks that have not begun can be made to wait.' },
    { id: 'until', label: 'It can start on', kind: 'date', required: true },
  ],
  build(v, common, ctx) {
    const task = taskOf(ctx, text(v.task));
    const until = text(v.until);
    const problems = [...checkCommon(common)];
    if (!task) problems.push('Pick the task.');
    if (!isDate(until)) problems.push('Pick the day it can start.');
    if (problems.length > 0 || !task) return fail(...problems);
    return eventOf(
      common,
      { type: 'BLOCKER', category: 'Dependency', moduleId: task.moduleId, taskId: task.id, effects: [{ op: 'BLOCK_UNTIL', taskId: task.id, date: until }] },
      `${taskName(ctx, task)} can not start before ${formatDate(until)}`,
    );
  },
};

const capacity: Template = {
  id: 'capacity',
  group: 'People and calendar',
  title: 'A team changes size',
  example: 'The build team drops to 2 people from Monday',
  route: 'event',
  asksPhase: false,
  fields: [
    { id: 'team', label: 'Which team?', kind: 'team', required: true },
    { id: 'from', label: 'From', kind: 'date', required: true, initial: (c) => c.today },
    { id: 'headcount', label: 'People available', kind: 'number', required: true, min: 0, step: 1, suffix: 'people' },
  ],
  build(v, common, ctx) {
    const team = ctx.teams.find((t) => t.id === text(v.team));
    const from = text(v.from);
    const headcount = parseNumber(v.headcount);
    const problems = [...checkCommon(common)];
    if (!team) problems.push('Pick the team.');
    if (!isDate(from)) problems.push('Pick the first day of the new size.');
    if (headcount === null || headcount < 0) problems.push('Say how many people (0 or more).');
    if (problems.length > 0 || !team || headcount === null) return fail(...problems);
    return eventOf(
      common,
      {
        type: 'RESOURCE_CHANGE',
        category: 'Capacity',
        sourceTeamId: team.id,
        effects: [{ op: 'SET_CAPACITY', teamId: team.id, from, headcount }],
      },
      `${team.name} has ${headcount} ${headcount === 1 ? 'person' : 'people'} from ${formatDate(from)}`,
    );
  },
};

const holiday: Template = {
  id: 'holiday',
  group: 'People and calendar',
  title: 'A public holiday',
  example: 'Wednesday 28 Oct is a holiday',
  route: 'event',
  asksPhase: false,
  fields: [{ id: 'date', label: 'Day off', kind: 'date', required: true }],
  build(v, common) {
    const date = text(v.date);
    const problems = [...checkCommon(common)];
    if (!isDate(date)) problems.push('Pick the day nobody works.');
    if (problems.length > 0) return fail(...problems);
    return eventOf(common, { type: 'RESOURCE_CHANGE', category: 'Calendar', effects: [{ op: 'ADD_HOLIDAY', date }] }, `Holiday on ${formatDate(date)}`);
  },
};

const handover: Template = {
  id: 'handover',
  group: 'People and calendar',
  title: 'A task is handed to someone else',
  example: 'Asha takes over the report draft',
  route: 'event',
  asksPhase: false,
  fields: [
    { id: 'task', label: 'Which task?', kind: 'task', scope: 'open', required: true },
    { id: 'person', label: 'Handed to', kind: 'text', required: true, placeholder: 'Name' },
    { id: 'cost', label: 'Time to get up to speed', kind: 'number', min: 0, step: 0.5, suffix: 'working days', initial: () => '0', help: 'Extra effort the new owner needs. Adds to the task.' },
  ],
  build(v, common, ctx) {
    const task = taskOf(ctx, text(v.task));
    const person = text(v.person);
    const cost = parseNumber(v.cost) ?? 0;
    const problems = [...checkCommon(common)];
    if (!task) problems.push('Pick the task.');
    if (person === '') problems.push('Say who takes it.');
    if (cost < 0) problems.push('The catch-up time can not be negative.');
    if (problems.length > 0 || !task) return fail(...problems);
    return eventOf(
      common,
      {
        type: 'OWNERSHIP_TRANSFER',
        category: 'People',
        moduleId: task.moduleId,
        taskId: task.id,
        effects: [{ op: 'TRANSFER_OWNER', taskId: task.id, toPersonId: person, ...(cost > 0 ? { contextCost: cost } : {}) }],
      },
      `${taskName(ctx, task)} handed to ${person}`,
    );
  },
};

const NEW_WORK_KINDS = [
  { value: 'SCOPE_CHANGE', label: 'Scope change' },
  { value: 'REQUIREMENT_CHANGE', label: 'Requirement change' },
  { value: 'REWORK', label: 'Rework' },
  { value: 'DEFECT', label: 'Defect' },
] as const;

/** The fields for new work, shared by the event (module has started) and the planning change (it has not). */
function newWorkFields(scope: 'event' | 'plan'): Field[] {
  return [
    { id: 'name', label: 'What is the work?', kind: 'text', required: true, placeholder: 'Safety review' },
    { id: 'effort', label: 'Effort', kind: 'number', required: true, min: 0.5, step: 0.5, suffix: 'working days', initial: () => '2' },
    { id: 'module', label: 'Which part of the plan does it belong to?', kind: 'module', required: true, moduleScope: scope === 'event' ? 'started' : 'unstarted', initial: (c) => (scope === 'event' ? (c.modules.find((m) => m.kind === 'PROJECT')?.id ?? '') : (c.modules.find((m) => m.lockedAt === null)?.id ?? '')) },
    { id: 'team', label: 'Which team does it?', kind: 'team', required: true },
    { id: 'after', label: 'It starts after', kind: 'tasks', scope: 'any', help: 'Optional. Leave empty if it can start straight away.' },
    { id: 'before', label: 'It must finish before', kind: 'task', scope: 'any', required: true, initial: (c) => c.deliveryTaskId ?? '', help: 'The step that has to wait for it. Delivery means "before we ship".' },
    ...(scope === 'event'
      ? [
          { id: 'kind', label: 'What kind of change is it?', kind: 'choice' as const, options: NEW_WORK_KINDS, initial: () => 'SCOPE_CHANGE' },
          { id: 'feature', label: 'Is it a feature several modules need?', kind: 'feature' as const, help: 'Linking it lets the retrospective say which features were found late.' },
        ]
      : []),
  ];
}

function newWorkEffect(v: Values, ctx: FormContext): { effect: Extract<PlanEditEffect, { op: 'ADD_TASK' }>; name: string; problems: string[] } {
  const name = text(v.name);
  const effort = parseNumber(v.effort);
  const moduleId = text(v.module);
  const teamId = text(v.team);
  const before = text(v.before);
  const after = list(v.after);
  const featureId = text(v.feature);
  const problems: string[] = [];
  if (name === '') problems.push('Name the work.');
  if (effort === null || effort <= 0) problems.push('Say how much effort it is (more than 0).');
  if (!ctx.modules.some((m) => m.id === moduleId)) problems.push('Pick where it belongs.');
  if (!ctx.teams.some((t) => t.id === teamId)) problems.push('Pick the team that does it.');
  if (!taskOf(ctx, before)) problems.push('Pick the step that has to wait for it.');
  if (after.includes(before)) problems.push('It can not start after the step that waits for it.');
  return {
    name,
    problems,
    effect: {
      op: 'ADD_TASK',
      task: {
        id: newTaskId(name, ctx.tasks.map((t) => t.id)),
        moduleId,
        teamId,
        kind: 'TASK',
        name,
        estimate: effort ?? 0,
        ...(featureId !== '' ? { featureId } : {}),
      },
      dependsOn: after,
      blocks: before === '' ? [] : [before],
    },
  };
}

const newWork: Template = {
  id: 'new-work',
  group: 'Scope',
  title: 'New work turns up',
  example: 'The client wants a safety review: one shared 2-day effort',
  route: 'event',
  asksPhase: true,
  fields: newWorkFields('event'),
  build(v, common, ctx) {
    const { effect, name, problems } = newWorkEffect(v, ctx);
    const all = [...checkCommon(common), ...problems];
    if (all.length > 0) return fail(...all);
    const type = (NEW_WORK_KINDS.find((k) => k.value === text(v.kind))?.value ?? 'SCOPE_CHANGE') as EventType;
    const feature = effect.task.featureId;
    return eventOf(
      common,
      {
        type,
        category: 'Scope',
        moduleId: effect.task.moduleId,
        ...(feature ? { linkedFeatureId: feature } : {}),
        effects: [effect],
      },
      `New work: ${name} (${workingDays(effect.task.estimate)})`,
    );
  },
};

const feedback: Template = {
  id: 'feedback',
  group: 'Feedback',
  title: 'Feedback arrives',
  example: 'The client reviewed the first draft and wants changes',
  route: 'event',
  asksPhase: true,
  fields: [
    {
      id: 'from',
      label: 'From whom?',
      kind: 'choice',
      required: true,
      initial: () => 'CLIENT_FEEDBACK',
      options: [
        { value: 'CLIENT_FEEDBACK', label: 'The client' },
        { value: 'FEEDBACK', label: 'Our own review' },
      ],
    },
    { id: 'team', label: 'Which team does it concern?', kind: 'team' },
  ],
  build(v, common, ctx) {
    const problems = [...checkCommon(common)];
    if (common.title.trim() === '') problems.push('Say what the feedback is about.');
    if (problems.length > 0) return fail(...problems);
    const type = (text(v.from) === 'FEEDBACK' ? 'FEEDBACK' : 'CLIENT_FEEDBACK') as EventType;
    const team = ctx.teams.find((t) => t.id === text(v.team));
    return eventOf(common, { type, category: 'Feedback', ...(team ? { sourceTeamId: team.id } : {}), effects: [] }, common.title.trim());
  },
};

const planReestimate: Template = {
  id: 'plan-reestimate',
  group: 'Planning',
  title: 'Re-estimate work that has not started',
  example: 'The final report is really 8 days, not 5',
  route: 'plan-edit',
  asksPhase: false,
  fields: [
    { id: 'task', label: 'Which task?', kind: 'task', scope: 'unstarted', required: true },
    { id: 'days', label: 'Change in effort', kind: 'number', required: true, step: 0.5, suffix: 'working days', initial: () => '1', help: 'Use a minus for work that is smaller than planned.' },
  ],
  build(v, common, ctx) {
    const task = taskOf(ctx, text(v.task));
    const days = parseNumber(v.days);
    const problems = [...checkCommon(common)];
    if (!task) problems.push('Pick the task.');
    if (days === null || days === 0) problems.push('Say how many days longer or shorter (not zero).');
    if (problems.length > 0 || !task || days === null) return fail(...problems);
    const summary = `${taskName(ctx, task)} re-estimated by ${signedDays(days)}`;
    return {
      ok: true,
      route: 'plan-edit',
      summary,
      draft: {
        title: common.title.trim() || summary,
        ...(common.description.trim() ? { reason: common.description.trim() } : {}),
        createdBy: common.createdBy.trim(),
        asOf: common.when,
        effects: [{ op: 'ADJUST_ESTIMATE', taskId: task.id, delta: days }],
      },
    };
  },
};

const planAdd: Template = {
  id: 'plan-add',
  group: 'Planning',
  title: 'Add work to a module that has not started',
  example: 'Add a 2-day review pass to the final module',
  route: 'plan-edit',
  asksPhase: false,
  fields: newWorkFields('plan'),
  build(v, common, ctx) {
    const { effect, name, problems } = newWorkEffect(v, ctx);
    const all = [...checkCommon(common), ...problems];
    const target = ctx.modules.find((m) => m.id === effect.task.moduleId);
    if (target && target.lockedAt !== null) all.push(`${target.name} has already started, so new work for it is an event, not a planning change.`);
    if (all.length > 0) return fail(...all);
    const summary = `Plan: add ${name} (${workingDays(effect.task.estimate)}) to ${moduleName(ctx, effect.task.moduleId)}`;
    return {
      ok: true,
      route: 'plan-edit',
      summary,
      draft: {
        title: common.title.trim() || summary,
        ...(common.description.trim() ? { reason: common.description.trim() } : {}),
        createdBy: common.createdBy.trim(),
        asOf: common.when,
        effects: [effect],
      },
    };
  },
};

const planRemove: Template = {
  id: 'plan-remove',
  group: 'Planning',
  title: 'Remove work that has not started',
  example: 'Drop the optional extra from the last module',
  route: 'plan-edit',
  asksPhase: false,
  fields: [{ id: 'task', label: 'Which task?', kind: 'task', scope: 'unstarted', required: true }],
  build(v, common, ctx) {
    const task = taskOf(ctx, text(v.task));
    const problems = [...checkCommon(common)];
    if (!task) problems.push('Pick the task.');
    if (problems.length > 0 || !task) return fail(...problems);
    const summary = `Plan: remove ${taskName(ctx, task)}`;
    return {
      ok: true,
      route: 'plan-edit',
      summary,
      draft: {
        title: common.title.trim() || summary,
        ...(common.description.trim() ? { reason: common.description.trim() } : {}),
        createdBy: common.createdBy.trim(),
        asOf: common.when,
        effects: [{ op: 'REMOVE_TASK', taskId: task.id }],
      },
    };
  },
};

export const TEMPLATES: readonly Template[] = [
  reestimate,
  finished,
  progress,
  blocked,
  capacity,
  holiday,
  handover,
  newWork,
  feedback,
  planReestimate,
  planAdd,
  planRemove,
];

export const TEMPLATE_GROUPS: ReadonlyArray<Template['group']> = ['What happened', 'People and calendar', 'Scope', 'Feedback', 'Planning'];

export const templateById = (id: string): Template | undefined => TEMPLATES.find((t) => t.id === id);

/** The common answers a form starts with. */
export function initialCommon(ctx: FormContext, createdBy: string): Common {
  return { when: ctx.today, phase: ctx.phases.buildStarts, title: '', description: '', createdBy, couldHaveBeenEarlier: false };
}

/** The answers each field starts with. */
export function initialValues(template: Template, ctx: FormContext): Values {
  const values: Values = {};
  for (const f of template.fields) {
    const initial = f.initial?.(ctx);
    values[f.id] = initial ?? (f.kind === 'tasks' ? [] : '');
  }
  return values;
}

/** Why a form can not be used right now, or null if it can: so a button can say so instead of opening an empty form. */
export function whyUnavailable(template: Template, ctx: FormContext): string | null {
  if (template.route === 'plan-edit') {
    if (!ctx.modules.some((m) => m.lockedAt === null)) return 'Every module has started, so there is nothing left to plan. Record what happens as events.';
  } else if (!ctx.modules.some((m) => m.lockedAt !== null)) {
    return 'Lock a module first: the project starts when its first module does.';
  }
  for (const f of template.fields) {
    if ((f.kind === 'task' || f.kind === 'tasks') && f.required && f.scope && tasksFor(f.scope, ctx).length === 0) {
      if (f.scope === 'unstarted') return 'No module is waiting to start, so there is no unstarted task to change.';
      return f.scope === 'waiting' ? 'Every task has already begun, so there is nothing left to hold back.' : 'There is no unfinished task to choose from.';
    }
    if (f.kind === 'team' && f.required && ctx.teams.length === 0) return 'The project has no teams.';
  }
  return null;
}
