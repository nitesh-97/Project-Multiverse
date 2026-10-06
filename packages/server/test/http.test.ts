import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeApp, makeSeededApp, P } from './helpers';
import type { TestApp } from './helpers';

let app: TestApp;
afterEach(async () => app.close());

describe('the HTTP surface', () => {
  it('reports health and the engine version', async () => {
    app = makeApp();
    const r = await app.get('/health');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'ok', engineVersion: expect.any(String) });
  });

  it('answers an unknown route with a JSON 404', async () => {
    app = makeApp();
    const r = await app.get('/nothing/here');
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: 'NOT_FOUND', message: 'No route for GET /nothing/here' });
  });

  it('answers malformed JSON with a 400, not a stack trace', async () => {
    app = makeApp();
    const res = await app.server.inject({ method: 'POST', url: '/projects', headers: { 'content-type': 'application/json' }, payload: '{not json' });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('BAD_REQUEST');
  });

  it('rejects ids that could cause trouble, with the path of the problem', async () => {
    app = makeApp();
    const r = await app.post('/projects', { id: '../etc', name: 'x', startDate: '2026-10-05' });
    expect(r.status).toBe(400);
    expect(r.body.details).toEqual([{ path: 'id', message: expect.stringMatching(/letters, digits/) }]);
  });

  it('rejects impossible dates', async () => {
    app = makeApp();
    const r = await app.post('/projects', { name: 'x', startDate: '2026-02-30' });
    expect(r.status).toBe(400);
    expect(r.body.details[0].path).toBe('startDate');
  });

  it('never leaks internals on an unexpected error', async () => {
    app = makeSeededApp();
    vi.spyOn(app.service.store, 'listTasks').mockImplementation(() => {
      throw new Error('disk on fire: C:\\secret\\path.sqlite');
    });
    const r = await app.get(P);
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ error: 'INTERNAL', message: 'Unexpected error' });
  });

  it('listens on loopback only by default', async () => {
    app = makeApp();
    await app.server.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.server.address();
    expect(typeof address === 'object' && address?.address).toBe('127.0.0.1');
  });
});
