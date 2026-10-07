import { EVENT_TYPES, PHASES, isISODate } from '@multiverse/engine';
import type { Effect } from '@multiverse/engine';
import { z } from 'zod';

/** Request validation. Objects are strict, so a misspelled field is an error rather than silently ignored. */

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, 'use letters, digits, dot, dash or underscore (max 64)');
const date = z.string().refine(isISODate, 'expected a real calendar date as YYYY-MM-DD');
const days = z.number().finite();
const nonNegative = z.number().finite().min(0);
const text = z.string().trim().min(1);

// ---------------------------------------------------------------------------------------------- projects

export const projectCreate = z.strictObject({
  id: id.optional(),
  name: text,
  startDate: date,
  targetDate: date.optional(),
  weekendDays: z.array(z.number().int().min(0).max(6)).max(6).default([0, 6]),
  holidays: z.array(date).default([]),
});

export const projectPatch = z.strictObject({
  name: text.optional(),
  targetDate: date.nullable().optional(),
  startDate: date.optional(),
  weekendDays: z.array(z.number().int().min(0).max(6)).max(6).optional(),
  holidays: z.array(date).optional(),
});

export const deliveryBody = z.strictObject({ taskId: id });

// ---------------------------------------------------------------------------------------------- blueprint

export const teamBody = z.strictObject({ id, name: text });
export const teamPatch = z.strictObject({ name: text });

export const capacityBody = z.strictObject({ teamId: id, from: date, headcount: nonNegative });

export const moduleBody = z.strictObject({
  id,
  name: text,
  kind: z.enum(['DELIVERABLE', 'SHARED', 'PROJECT']),
  scope: z.record(z.string(), z.unknown()).optional(),
});
export const modulePatch = z.strictObject({ name: text.optional(), scope: z.record(z.string(), z.unknown()).optional() });

export const taskBody = z.strictObject({
  id,
  moduleId: id,
  teamId: id,
  kind: z.enum(['TASK', 'MILESTONE']).default('TASK'),
  name: text,
  estimate: nonNegative.default(0),
  startNoEarlierThan: date.optional(),
  ownerId: z.string().optional(),
  featureId: id.optional(),
});
export const taskPatch = z.strictObject({
  moduleId: id.optional(),
  teamId: id.optional(),
  kind: z.enum(['TASK', 'MILESTONE']).optional(),
  name: text.optional(),
  estimate: nonNegative.optional(),
  startNoEarlierThan: date.nullable().optional(),
  ownerId: z.string().nullable().optional(),
  featureId: id.nullable().optional(),
});

export const dependencyBody = z.strictObject({ predecessorId: id, successorId: id });

export const featureBody = z.strictObject({
  id,
  name: text,
  moduleIds: z.array(id).default([]),
  sharedTaskId: id.optional(),
});
export const featurePatch = z.strictObject({
  name: text.optional(),
  moduleIds: z.array(id).optional(),
  sharedTaskId: id.nullable().optional(),
});

/** The whole blueprint in one go. Replaces any draft; only allowed before the project has started. */
export const blueprintBody = z.strictObject({
  deliveryTaskId: id,
  teams: z.array(teamBody),
  capacity: z.array(capacityBody).default([]),
  modules: z.array(moduleBody),
  tasks: z.array(taskBody),
  dependencies: z.array(dependencyBody).default([]),
  features: z.array(featureBody).default([]),
});

// ---------------------------------------------------------------------------------------------- events

const taskDef = z.strictObject({
  id,
  moduleId: id,
  teamId: id,
  kind: z.enum(['TASK', 'MILESTONE']).default('TASK'),
  name: text,
  estimate: nonNegative,
  startNoEarlierThan: date.optional(),
  ownerId: z.string().optional(),
  featureId: id.optional(),
});

/** The effects a planning change may use: reshaping the plan of work that has not started. */
const addTask = z.strictObject({ op: z.literal('ADD_TASK'), task: taskDef, dependsOn: z.array(id).default([]), blocks: z.array(id).default([]) });
const adjustEstimate = z.strictObject({ op: z.literal('ADJUST_ESTIMATE'), taskId: id, delta: days });
const removeTask = z.strictObject({ op: z.literal('REMOVE_TASK'), taskId: id });
const addDependency = z.strictObject({ op: z.literal('ADD_DEPENDENCY'), predecessorId: id, successorId: id });
const removeDependency = z.strictObject({ op: z.literal('REMOVE_DEPENDENCY'), predecessorId: id, successorId: id });
const blockUntil = z.strictObject({ op: z.literal('BLOCK_UNTIL'), taskId: id, date: date.nullable() });

export const planEffectSchema = z.discriminatedUnion('op', [addTask, adjustEstimate, removeTask, addDependency, removeDependency, blockUntil]);

export const effectSchema = z.discriminatedUnion('op', [
  addTask,
  adjustEstimate,
  removeTask,
  addDependency,
  removeDependency,
  blockUntil,
  z.strictObject({ op: z.literal('ADD_HOLIDAY'), date }),
  z.strictObject({ op: z.literal('SET_CAPACITY'), teamId: id, from: date, headcount: nonNegative }),
  z.strictObject({
    op: z.literal('RECORD_PROGRESS'),
    taskId: id,
    startedOn: date.nullable().optional(),
    remaining: nonNegative.nullable().optional(),
    finishedOn: date.nullable().optional(),
  }),
  z.strictObject({ op: z.literal('TRANSFER_OWNER'), taskId: id, toPersonId: text, contextCost: nonNegative.optional() }),
]);

export const eventBody = z.strictObject({
  id: id.optional(),
  type: z.enum(EVENT_TYPES),
  category: text.default('General'),
  title: text,
  description: z.string().default(''),
  phase: z.enum(PHASES),
  moduleId: id.optional(),
  taskId: id.optional(),
  createdBy: text,
  sourceTeamId: id.optional(),
  affectedTeamId: id.optional(),
  affectedOwnerId: z.string().optional(),
  occurredAt: date,
  /** Status date for the forecast this event triggers. Defaults to occurredAt. */
  asOf: date.optional(),
  couldHaveBeenEarlier: z.boolean().optional(),
  estimatedEffortImpact: days.optional(),
  estimatedScheduleImpact: days.optional(),
  parentEventId: id.optional(),
  linkedRequirementId: z.string().optional(),
  linkedFeatureId: id.optional(),
  effects: z.array(effectSchema).max(500).default([]),
});

export const voidBody = z.strictObject({ id: id.optional(), asOf: date, reason: z.string().optional() });

/**
 * A planning change to modules that have not started, made after the project started. It is recorded in the log, so
 * history shows what changed, when and why, and it moves the plan as well as the forecast.
 */
export const planEditBody = z.strictObject({
  id: id.optional(),
  title: text,
  reason: z.string().optional(),
  createdBy: text,
  /** Status date for the forecast this edit triggers (end of that working day). Required: there is no clock. */
  asOf: date,
  effects: z.array(planEffectSchema).min(1).max(500),
});

export type EventInput = z.output<typeof eventBody>;
export type PlanEditInput = z.output<typeof planEditBody>;
export const asEffects = (e: EventInput['effects']): Effect[] => e as Effect[];
