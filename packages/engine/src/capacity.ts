import { EPS, snap } from './calendar';
import type { WorkCalendar } from './calendar';
import { PlanError } from './errors';
import type { CapacityPoint, TeamId } from './types';

const MAX_STEPS = 1_000_000;

interface Step {
  /** 0-based working-day index from which this factor applies. */
  fromDay: number;
  factor: number;
}

/**
 * Converts effort into elapsed working time using each team's capacity factor
 * (headcount / planned headcount, see DESIGN.md §3.4).
 */
export class CapacityModel {
  private readonly steps = new Map<TeamId, Step[]>();

  constructor(capacity: readonly CapacityPoint[], calendar: WorkCalendar) {
    const byTeam = new Map<TeamId, CapacityPoint[]>();
    for (const p of capacity) {
      const list = byTeam.get(p.teamId) ?? [];
      list.push(p);
      byTeam.set(p.teamId, list);
    }
    for (const [teamId, points] of byTeam) {
      const sorted = [...points].sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
      const planned = (sorted[0] as CapacityPoint).headcount;
      if (!(planned > 0)) throw new PlanError(`Team ${teamId} must have a planned headcount above 0`);
      this.steps.set(
        teamId,
        sorted.map((p) => ({ fromDay: calendar.startOffsetClamped(p.from), factor: p.headcount / planned })),
      );
    }
  }

  /** Capacity factor of `teamId` on 0-based working day `day`. */
  factorOnDay(teamId: TeamId, day: number): number {
    const steps = this.steps.get(teamId);
    if (!steps) return 1;
    let factor = (steps[0] as Step).factor;
    for (const s of steps) {
      if (s.fromDay <= day) factor = s.factor;
      else break;
    }
    return factor;
  }

  /**
   * The offset at which `work` effort-days, started at offset `from`, will be complete.
   * Walks day by day so that capacity changes in the middle of a task are honoured.
   */
  timeToComplete(teamId: TeamId, from: number, work: number): number {
    if (work <= EPS) return snap(from);
    const steps = this.steps.get(teamId);
    if (!steps) return snap(from + work);

    const lastChange = (steps[steps.length - 1] as Step).fromDay;
    let t = from;
    let left = work;
    for (let i = 0; i < MAX_STEPS; i++) {
      const day = Math.floor(t + EPS);
      const factor = this.factorOnDay(teamId, day);
      if (factor <= 0) {
        if (day >= lastChange) {
          throw new PlanError(
            `Team ${teamId} has no capacity from working day ${lastChange + 1} onward, so its work can never finish`,
          );
        }
        t = day + 1;
        continue;
      }
      const available = (day + 1 - t) * factor;
      if (left <= available + EPS) return snap(t + left / factor);
      left -= available;
      t = day + 1;
    }
    throw new PlanError(`Team ${teamId}: work did not complete within ${MAX_STEPS} steps`);
  }
}
