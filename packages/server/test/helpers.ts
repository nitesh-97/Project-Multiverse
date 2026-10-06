import { buildApp } from '../src/app';
import { openDatabase } from '../src/db/database';
import { seedThriveni } from '../src/seed';

export interface Reply {
  status: number;
  // The shape depends on the endpoint; tests assert on what they need.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

/** A fresh app on an in-memory database (or a file), with a deterministic clock: one second per call. */
export function makeApp(path = ':memory:') {
  const db = openDatabase(path);
  let tick = 0;
  const now = () => new Date(Date.UTC(2026, 9, 1, 9, 0, tick++)).toISOString();
  const { server, service } = buildApp({ db, now });

  async function call(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown): Promise<Reply> {
    const res = await server.inject({ method, url, ...(payload !== undefined ? { payload: payload as object } : {}) });
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
  }

  let closed = false;
  return {
    db,
    server,
    service,
    call,
    get: (url: string) => call('GET', url),
    post: (url: string, body?: unknown) => call('POST', url, body ?? {}),
    put: (url: string, body: unknown) => call('PUT', url, body),
    patch: (url: string, body: unknown) => call('PATCH', url, body),
    del: (url: string) => call('DELETE', url),
    /** Safe to call more than once. */
    close: async () => {
      if (closed) return;
      closed = true;
      await server.close();
      db.close();
    },
  };
}

export type TestApp = ReturnType<typeof makeApp>;

/** An app with the Thriveni project created and fully locked. Revision 0 exists. */
export function makeSeededApp(): TestApp {
  const app = makeApp();
  seedThriveni(app.service);
  return app;
}

export const P = '/projects/thriveni';

// ---- events as they would arrive over HTTP -------------------------------------------------------------------

const base = { category: 'General', createdBy: 'tester', phase: 'DEVELOPMENT' };

/** M2 Dev +3: absorbed by float (delivery stays 30 Oct). */
export const t2 = () => ({ ...base, id: 't2', type: 'TASK_DELAY', title: 'M2 dev +3', occurredAt: '2026-10-13', effects: [{ op: 'ADJUST_ESTIMATE', taskId: 'm2.dev', delta: 3 }] });
/** M5 Dev +1: critical, delivery moves to Mon 2 Nov. */
export const t3 = () => ({ ...base, id: 't3', type: 'DEPENDENCY_DELAY', title: 'M5 dev +1', occurredAt: '2026-10-14', effects: [{ op: 'ADJUST_ESTIMATE', taskId: 'm5.dev', delta: 1 }] });
/** M3 Dev +3: delivery moves to Tue 3 Nov and the critical path switches to M3. */
export const t4 = () => ({ ...base, id: 't4', type: 'TASK_DELAY', title: 'M3 dev +3', occurredAt: '2026-10-14', effects: [{ op: 'ADJUST_ESTIMATE', taskId: 'm3.dev', delta: 3 }] });

export const extinguisherEffects = () =>
  [1, 2, 3, 4, 5, 6, 7].map((n) => ({
    op: 'ADD_TASK',
    task: { id: `m${n}.ext`, moduleId: `m${n}`, teamId: 'dev', kind: 'TASK', name: `m${n} extinguisher`, estimate: 2 },
    dependsOn: [`m${n}.dev`],
    blocks: [`m${n}.alpha`],
  }));
/** The late extinguisher: 14 effort-days, +2 schedule days, delivery Tue 3 Nov. */
export const hs = () => ({
  ...base,
  id: 'hs',
  type: 'SCOPE_CHANGE',
  title: 'Extinguisher in every module',
  occurredAt: '2026-10-14',
  effects: extinguisherEffects(),
});
