import type { Effect, PlanEditEffect } from '@multiverse/engine';
import { formatDate } from './dates';
import { signedDays, workingDays } from './format';

export interface Names {
  task: (id: string) => string;
  team: (id: string) => string;
  module: (id: string) => string;
}

export const identityNames: Names = { task: (id) => id, team: (id) => id, module: (id) => id };

/** One effect, said the way a person would say it. */
export function describeEffect(effect: Effect | PlanEditEffect, names: Names = identityNames): string {
  switch (effect.op) {
    case 'ADD_TASK': {
      const after = effect.dependsOn.length > 0 ? `, after ${effect.dependsOn.map(names.task).join(' and ')}` : '';
      const before = effect.blocks.length > 0 ? `, before ${effect.blocks.map(names.task).join(' and ')}` : '';
      return `Add “${effect.task.name}” (${workingDays(effect.task.estimate)}) to ${names.module(effect.task.moduleId)}${after}${before}`;
    }
    case 'ADJUST_ESTIMATE':
      return `${names.task(effect.taskId)} ${signedDays(effect.delta)}`;
    case 'REMOVE_TASK':
      return `Remove ${names.task(effect.taskId)}`;
    case 'ADD_DEPENDENCY':
      return `${names.task(effect.successorId)} now waits for ${names.task(effect.predecessorId)}`;
    case 'REMOVE_DEPENDENCY':
      return `${names.task(effect.successorId)} no longer waits for ${names.task(effect.predecessorId)}`;
    case 'BLOCK_UNTIL':
      return effect.date === null ? `${names.task(effect.taskId)} is no longer blocked` : `${names.task(effect.taskId)} can not start before ${formatDate(effect.date)}`;
    case 'SET_CAPACITY':
      return `${names.team(effect.teamId)} has ${effect.headcount} ${effect.headcount === 1 ? 'person' : 'people'} from ${formatDate(effect.from)}`;
    case 'RECORD_PROGRESS': {
      const parts: string[] = [];
      if (effect.startedOn) parts.push(`started ${formatDate(effect.startedOn)}`);
      if (effect.remaining !== undefined && effect.remaining !== null) parts.push(`${workingDays(effect.remaining)} left`);
      if (effect.finishedOn) parts.push(`finished ${formatDate(effect.finishedOn)}`);
      return `${names.task(effect.taskId)}: ${parts.length > 0 ? parts.join(', ') : 'progress recorded'}`;
    }
    case 'TRANSFER_OWNER':
      return `${names.task(effect.taskId)} handed to ${effect.toPersonId}${effect.contextCost ? ` (${workingDays(effect.contextCost)} to catch up)` : ''}`;
    case 'ADD_HOLIDAY':
      return `Holiday on ${formatDate(effect.date)}`;
  }
}
