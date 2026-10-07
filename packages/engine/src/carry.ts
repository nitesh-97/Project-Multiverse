import { EPS, WorkCalendar, snap } from './calendar';
import { CapacityModel } from './capacity';
import type { Schedule } from './schedule';
import type { Plan } from './types';

/**
 * Carries a forecast forward to a later status date (DESIGN.md §3.2).
 *
 * Between events nobody may have recorded progress, so the previous forecast is treated as what happened unless
 * someone says otherwise: tasks it had finished by `toOffset` become finished, tasks it had started become in
 * progress with the effort left over, and everything else is untouched. Recorded actuals can still override this
 * with a RECORD_PROGRESS effect.
 *
 * Everything the engine assumes this way is marked `assumed`, so that a task that was forecast to finish but that
 * nobody has confirmed can be flagged instead of silently trusted. Recording progress clears the mark.
 *
 * Without this, any event with a later status date would silently re-plan every unrecorded task from that date.
 * Carrying a forecast forward with no other change reproduces the same forecast (tested as a property).
 */
export function carryForward(plan: Plan, previous: Schedule, toOffset: number): Plan {
  if (toOffset <= previous.statusOffset + EPS) return plan;

  const calendar = new WorkCalendar(plan.calendar);
  const capacity = new CapacityModel(plan.capacity, calendar);
  const next = structuredClone(plan);

  for (const task of next.tasks) {
    const was = previous.tasks[task.id];
    if (!was || was.state === 'DONE') continue;

    if (was.finish <= toOffset + EPS) {
      // Finishing is always an assumption here: a recorded finish would already have made the task DONE.
      task.progress = { startedAt: was.start, finishedAt: was.finish, assumed: true };
    } else if (task.kind === 'TASK' && was.burnStart < toOffset - EPS) {
      const p = task.progress;
      const alreadyStarted = p !== undefined && (p.startedOn !== undefined || p.startedAt !== undefined);
      // Carrying on with work someone recorded as started keeps its status; starting it is the assumption.
      const assumed = alreadyStarted ? (p?.assumed ?? false) : true;
      const burned = capacity.workBetween(task.teamId, was.burnStart, toOffset);
      task.progress = {
        startedAt: was.start,
        remaining: Math.max(0, snap(was.remainingEffort - burned)),
        ...(assumed ? { assumed: true } : {}),
      };
    }
  }
  return next;
}
