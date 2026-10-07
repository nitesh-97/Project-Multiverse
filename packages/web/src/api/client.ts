import type {
  ControlRoomView,
  CurrentTask,
  EventLogItem,
  EventPreview,
  ForecastView,
  PlanEditLogItem,
  ModuleView,
  PlanEditPreview,
  ProjectDetail,
  ProjectInfo,
  ProjectTimelineView,
  RecordedEventView,
  RecordedPlanEditView,
  RetroView,
  SnapshotView,
} from '@multiverse/engine';
import type { EventDraft, PlanEditDraft } from '../lib/templates';

/** An error answer from the API: the status, the machine-readable code, and a message a person can read. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Where the API is. Empty means "the same place as this page" (the dev server proxies, the real server serves both). */
const BASE: string = import.meta.env.VITE_API_BASE ?? '';

async function request<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(BASE + path, {
      method,
      ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
      ...(signal ? { signal } : {}),
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    throw new ApiError(0, 'UNREACHABLE', 'Could not reach the Multiverse server. Is it running?');
  }
  const raw = await res.text();
  let data: unknown = null;
  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch {
      throw new ApiError(res.status, 'NOT_JSON', `The server answered with something that is not JSON (${res.status}).`);
    }
  }
  if (!res.ok) {
    const err = (data ?? {}) as { error?: string; message?: string; details?: unknown };
    throw new ApiError(res.status, err.error ?? 'ERROR', err.message ?? res.statusText, err.details);
  }
  return data as T;
}

const enc = encodeURIComponent;
const get = <T>(path: string, signal?: AbortSignal): Promise<T> => request<T>('GET', path, undefined, signal);
const post = <T>(path: string, body: unknown): Promise<T> => request<T>('POST', path, body);

export const api = {
  projects: (signal?: AbortSignal) => get<ProjectInfo[]>('/projects', signal),
  project: (id: string, signal?: AbortSignal) => get<ProjectDetail>(`/projects/${enc(id)}`, signal),
  forecast: (id: string, signal?: AbortSignal) => get<ForecastView>(`/projects/${enc(id)}/forecast`, signal),
  timeline: (id: string, signal?: AbortSignal) => get<ProjectTimelineView>(`/projects/${enc(id)}/timeline`, signal),
  moduleTimeline: (id: string, moduleId: string, signal?: AbortSignal) => get<ModuleView>(`/projects/${enc(id)}/modules/${enc(moduleId)}/timeline`, signal),
  controlRoom: (id: string, signal?: AbortSignal) => get<ControlRoomView>(`/projects/${enc(id)}/control-room`, signal),
  retro: (id: string, signal?: AbortSignal) => get<RetroView>(`/projects/${enc(id)}/retro`, signal),
  currentTasks: (id: string, signal?: AbortSignal) => get<CurrentTask[]>(`/projects/${enc(id)}/current-tasks`, signal),
  events: (id: string, signal?: AbortSignal) => get<EventLogItem[]>(`/projects/${enc(id)}/events`, signal),
  planEdits: (id: string, signal?: AbortSignal) => get<PlanEditLogItem[]>(`/projects/${enc(id)}/plan-edits`, signal),
  snapshot: (id: string, revision: number, signal?: AbortSignal) => get<SnapshotView>(`/projects/${enc(id)}/snapshots/${revision}`, signal),

  /** Flags a task as a project milestone (an extra dot on the project view), or takes the flag off. Returns the flagged ids. */
  setMilestoneFlag: (id: string, taskId: string, flagged: boolean) =>
    request<string[]>(flagged ? 'PUT' : 'DELETE', `/projects/${enc(id)}/milestone-flags/${enc(taskId)}`, flagged ? {} : undefined),

  previewEvent: (id: string, draft: EventDraft) => post<EventPreview>(`/projects/${enc(id)}/events/preview`, draft),
  recordEvent: (id: string, draft: EventDraft) => post<RecordedEventView>(`/projects/${enc(id)}/events`, draft),
  previewPlanEdit: (id: string, draft: PlanEditDraft) => post<PlanEditPreview>(`/projects/${enc(id)}/plan-edits/preview`, draft),
  recordPlanEdit: (id: string, draft: PlanEditDraft) => post<RecordedPlanEditView>(`/projects/${enc(id)}/plan-edits`, draft),
  voidEvent: (id: string, eventId: string, body: { asOf: string; reason?: string }) => post<RecordedEventView>(`/projects/${enc(id)}/events/${enc(eventId)}/void`, body),
  lockModule: (id: string, moduleId: string) => post<{ id: string; lockedAt: string | null }>(`/projects/${enc(id)}/modules/${enc(moduleId)}/lock`, {}),
};

/** A message for an error, whatever it is. */
export function describeError(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error) return e.message;
  return 'Something went wrong.';
}
