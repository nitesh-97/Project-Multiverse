import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { openDatabase } from '../src/db/database';

let root: string;
let secret: string;

beforeAll(() => {
  const base = mkdtempSync(join(tmpdir(), 'mv-web-'));
  root = join(base, 'dist');
  mkdirSync(join(root, 'assets'), { recursive: true });
  writeFileSync(join(root, 'index.html'), '<!doctype html><title>Project Multiverse</title><div id="root"></div>');
  writeFileSync(join(root, 'assets', 'app-3f9a1c.js'), 'console.log("hello")');
  secret = join(base, 'secret.txt');
  writeFileSync(secret, 'not for the web');
});
afterAll(() => rmSync(join(root, '..'), { recursive: true, force: true }));

async function withWeb<T>(webRoot: string | undefined, run: (get: (url: string, method?: 'GET' | 'POST') => Promise<{ status: number; headers: Record<string, unknown>; body: string }>) => Promise<T>): Promise<T> {
  const db = openDatabase(':memory:');
  const { server } = buildApp({ db, webRoot });
  try {
    return await run(async (url, method = 'GET') => {
      const res = await server.inject({ method, url });
      return { status: res.statusCode, headers: res.headers, body: res.body };
    });
  } finally {
    await server.close();
    db.close();
  }
}

describe('serving the built web app', () => {
  it('serves the page at / with a policy that lets it load only its own files', async () => {
    await withWeb(root, async (get) => {
      const res = await get('/');
      expect(res.status).toBe(200);
      expect(String(res.headers['content-type'])).toContain('text/html');
      expect(res.body).toContain('Project Multiverse');
      const policy = String(res.headers['content-security-policy']);
      expect(policy).toContain("default-src 'self'");
      expect(policy).toContain("script-src 'self'");
      expect(policy).toContain("connect-src 'self'");
      expect(policy).toContain("frame-ancestors 'none'");
      expect(res.headers['cache-control']).toBe('no-cache');
    });
  });

  it('serves built files, which are named by their contents, to be kept for good', async () => {
    await withWeb(root, async (get) => {
      const res = await get('/assets/app-3f9a1c.js');
      expect(res.status).toBe(200);
      expect(res.body).toBe('console.log("hello")');
      expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
      expect(res.headers['content-security-policy']).toBeUndefined();
    });
  });

  it('leaves the API where it was', async () => {
    await withWeb(root, async (get) => {
      const health = await get('/health');
      expect(health.status).toBe(200);
      expect(JSON.parse(health.body)).toMatchObject({ status: 'ok' });
      expect(JSON.parse((await get('/projects')).body)).toEqual([]);
    });
  });

  it('still answers an unknown path with the API’s JSON 404, not the page', async () => {
    await withWeb(root, async (get) => {
      for (const url of ['/nope', '/assets/missing.js', '/projects/none/forecast']) {
        const res = await get(url);
        expect(res.status, url).toBe(404);
        expect(JSON.parse(res.body), url).toMatchObject({ error: 'NOT_FOUND' });
      }
    });
  });

  it('does not serve anything outside the built folder', async () => {
    await withWeb(root, async (get) => {
      for (const url of ['/../secret.txt', '/%2e%2e/secret.txt', '/assets/%2e%2e/%2e%2e/secret.txt', '/..%2fsecret.txt']) {
        const res = await get(url);
        expect(res.status, url).toBeGreaterThanOrEqual(400);
        expect(res.body, url).not.toContain('not for the web');
      }
      expect(secret).toContain('secret.txt');
    });
  });

  it('only serves files to a GET', async () => {
    await withWeb(root, async (get) => {
      expect((await get('/', 'POST')).status).toBe(404);
    });
  });

  it('serves nothing at / when there is no built app: the API alone, as before', async () => {
    await withWeb(undefined, async (get) => {
      const res = await get('/');
      expect(res.status).toBe(404);
      expect(JSON.parse(res.body)).toMatchObject({ error: 'NOT_FOUND' });
      expect((await get('/health')).status).toBe(200);
    });
  });
});
