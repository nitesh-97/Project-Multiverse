/** Thrown when an event or effect cannot be applied to the current plan. */
export class EffectError extends Error {
  readonly eventId: string | null;

  constructor(message: string, eventId: string | null = null) {
    super(message);
    this.name = 'EffectError';
    this.eventId = eventId;
  }
}

/** Thrown when a plan is structurally invalid. Carries every problem found, not just the first. */
export class PlanError extends Error {
  readonly issues: string[];

  constructor(issues: string | string[]) {
    const list = Array.isArray(issues) ? issues : [issues];
    super(list.length === 1 ? (list[0] as string) : `Invalid plan:\n- ${list.join('\n- ')}`);
    this.name = 'PlanError';
    this.issues = list;
  }
}
