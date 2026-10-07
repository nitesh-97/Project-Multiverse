import {
  buildMilestones,
  buildModuleView,
  buildTimeline,
  explainSnapshot,
  previewEvent,
  previewPlanEdit,
  recordEvent,
  recordPlanEdit,
  slackToTarget,
  voidEvent,
} from '@multiverse/engine';
import type { Event, EventLogItem, PhaseModel, PlanEdit, PlanEditLogItem, ProjectState } from '@multiverse/engine';
import { vi } from 'vitest';
import { TARGET_DATE, controlRoomView, currentTasksOf, detailOf, modulesOf, retroView, stateWith } from './fixtures';

/**
 * A small in-memory stand-in for the API, run by the real engine, so the screens are exercised against exactly the
 * shapes and numbers the real server would send. It records every request so tests can assert on what was sent.
 */
export interface FakeServer {
  fetch: ReturnType<typeof vi.fn>;
  calls: Array<{ method: string; path: string; body: unknown }>;
  state: () => ProjectState;
  /** Make the next requests to this path (a substring) fail. */
  failing: Set<string>;
}

export interface FakeOptions {
  id?: string;
  name?: string;
  events?: readonly Event[];
  planEdits?: readonly PlanEdit[];
  unlocked?: readonly string[];
  targetDate?: string | null;
  /** A project that has not started: only the blueprint exists. */
  notStarted?: boolean;
  /** The project's own phases. Left out, it has the legacy ones, as Thriveni does. */
  phases?: PhaseModel;
  /** Tasks already flagged as project milestones. */
  flagged?: readonly string[];
}

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const err = (status: number, error: string, message: string): Response => json(status, { error, message });

export function fakeServer(options: FakeOptions = {}): FakeServer {
  const id = options.id ?? 'thriveni';
  const targetDate = options.targetDate === undefined ? TARGET_DATE : options.targetDate;
  let state = stateWith(options.events ?? [], options.planEdits ?? [], options.phases);
  const flags: string[] = [...(options.flagged ?? [])];
  const allModules = state.origin.modules.map((m) => m.id);
  // A project has started once any module is locked, as on the real server.
  const unlocked = new Set(options.notStarted ? allModules : (options.unlocked ?? []));
  const isStarted = (): boolean => unlocked.size < allModules.length;
  let seq = 0;
  const events: EventLogItem[] = (options.events ?? []).map((e) => ({ ...e, seq: ++seq, recordedAt: '2026-10-01T09:00:00.000Z', status: 'ACTIVE', voidedBy: null }));
  const planEdits: PlanEditLogItem[] = (options.planEdits ?? []).map((p) => ({ ...p, seq: ++seq, recordedAt: '2026-10-01T09:00:00.000Z' }));
  const calls: FakeServer['calls'] = [];
  const failing = new Set<string>();
  let counter = 0;

  const detail = () => {
    return { ...detailOf(state, [...unlocked], targetDate), started: isStarted() };
  };

  const handle = (method: string, path: string, body: unknown): Response => {
    const [, , pid, a, b, c] = path.split('/');
    if (path === '/projects') return json(200, [detail().project]);
    if (pid !== id) return err(404, 'NOT_FOUND', `Project "${pid}" was not found`);
    if (!a) return json(200, detail());
    if (a === 'modules' && b && path.endsWith('/lock')) {
      if (!unlocked.has(b)) return err(409, 'ALREADY_LOCKED', `Module "${b}" is already locked`);
      unlocked.delete(b);
      return json(200, { id: b, lockedAt: '2026-10-07T09:00:00.000Z' });
    }
    if (!isStarted()) return err(409, 'NOT_STARTED', 'The project has not started.');

    const last = state.snapshots[state.snapshots.length - 1]!;
    switch (a) {
      case 'forecast':
        return json(200, { ...last, target: targetDate ? { date: targetDate, daysToSpare: slackToTarget(last.calendar ?? state.origin.calendar, last.forecastDelivery.offset, targetDate) } : null });
      case 'timeline':
        return json(200, { ...buildTimeline(state), milestones: buildMilestones(state, { flaggedTaskIds: flags }), flaggedTaskIds: flags });
      case 'modules':
        if (c === 'timeline') {
          if (!state.plan.modules.some((m) => m.id === b)) return err(404, 'NOT_FOUND', `Module "${b}" was not found`);
          return json(200, buildModuleView(state, b as string));
        }
        return err(404, 'NOT_FOUND', `No route for ${method} ${path}`);
      case 'milestone-flags':
        if (method === 'GET') return json(200, flags);
        if (method === 'PUT') {
          if (!state.plan.tasks.some((t) => t.id === b)) return err(404, 'NOT_FOUND', `Task "${b}" was not found`);
          if (!flags.includes(b as string)) flags.push(b as string);
        } else if (method === 'DELETE') {
          const i = flags.indexOf(b as string);
          if (i >= 0) flags.splice(i, 1);
        }
        return json(200, flags);
      case 'control-room':
        return json(200, controlRoomView(state, [...unlocked], targetDate));
      case 'retro':
        return json(200, retroView(state, targetDate));
      case 'current-tasks':
        return json(200, currentTasksOf(state, modulesOf(state, [...unlocked])));
      case 'snapshots': {
        const n = Number(b);
        const snapshot = state.snapshots[n];
        if (!snapshot) return err(404, 'NOT_FOUND', `Snapshot ${b} was not found`);
        return json(200, { snapshot, explanation: n > 0 ? explainSnapshot(state.snapshots[n - 1]!, snapshot) : null });
      }
      case 'events': {
        if (method === 'GET') return json(200, events);
        if (b === 'preview') {
          const event = { ...(body as Event), id: 'preview' };
          try {
            return json(200, { event, explanation: previewEvent(state, event) });
          } catch (e) {
            return err(422, 'EFFECT_REJECTED', e instanceof Error ? e.message : String(e));
          }
        }
        if (path.endsWith('/void')) {
          const void_ = body as { asOf: string; reason?: string };
          state = voidEvent(state, { kind: 'VOID', id: `void-${++counter}`, eventId: b as string, asOf: void_.asOf, ...(void_.reason ? { reason: void_.reason } : {}) });
          const target = events.find((e) => e.id === b);
          if (target) {
            target.status = 'VOIDED';
            target.voidedBy = `void-${counter}`;
          }
          ++seq;
          return json(201, { event: target, snapshot: state.snapshots[state.snapshots.length - 1], explanation: explainSnapshot(state.snapshots[state.snapshots.length - 2]!, state.snapshots[state.snapshots.length - 1]!) });
        }
        const event: Event = { ...(body as Event), id: `evt-${++counter}` };
        try {
          state = recordEvent(state, event);
        } catch (e) {
          return err(422, 'EFFECT_REJECTED', e instanceof Error ? e.message : String(e));
        }
        const item: EventLogItem = { ...event, seq: ++seq, recordedAt: '2026-10-07T09:00:00.000Z', status: 'ACTIVE', voidedBy: null };
        events.push(item);
        return json(201, { event: item, snapshot: state.snapshots[state.snapshots.length - 1], explanation: explainSnapshot(state.snapshots[state.snapshots.length - 2]!, state.snapshots[state.snapshots.length - 1]!) });
      }
      case 'plan-edits': {
        if (method === 'GET') return json(200, planEdits);
        const edit = { ...(body as PlanEdit), id: b === 'preview' ? 'preview' : `plan-${++counter}` };
        try {
          if (b === 'preview') return json(200, { planEdit: edit, explanation: previewPlanEdit(state, edit) });
          state = recordPlanEdit(state, edit);
        } catch (e) {
          return err(422, 'EFFECT_REJECTED', e instanceof Error ? e.message : String(e));
        }
        const item: PlanEditLogItem = { ...edit, seq: ++seq, recordedAt: '2026-10-07T09:00:00.000Z' };
        planEdits.push(item);
        return json(201, { planEdit: item, snapshot: state.snapshots[state.snapshots.length - 1], explanation: explainSnapshot(state.snapshots[state.snapshots.length - 2]!, state.snapshots[state.snapshots.length - 1]!) });
      }
    }
    return err(404, 'NOT_FOUND', `No route for ${method} ${path}`);
  };

  const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const path = String(input).replace(/^https?:\/\/[^/]+/, '');
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    calls.push({ method, path, body });
    for (const f of failing) if (path.includes(f)) return err(500, 'BOOM', 'The server fell over.');
    return handle(method, path, body);
  });

  return { fetch: fetchFn, calls, state: () => state, failing };
}
