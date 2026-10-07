import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app';
import { openDatabase } from './db/database';

// Local by default: nothing else on the network can reach it unless HOST is changed.
const port = Number(process.env.PORT ?? 4000);
const host = process.env.HOST ?? '127.0.0.1';
const dbPath = process.env.DB_PATH ?? 'data/multiverse.sqlite';

// The built web app, if there is one. `npm run build -w @multiverse/web` makes it.
const webRoot = process.env.WEB_ROOT ?? fileURLToPath(new URL('../../web/dist', import.meta.url));
const serveWeb = existsSync(join(webRoot, 'index.html'));

const db = openDatabase(dbPath);
const { server } = buildApp({ db, logger: true, webRoot: serveWeb ? webRoot : undefined });

const shutdown = async (signal: string) => {
  server.log.info(`${signal} received, shutting down`);
  await server.close();
  db.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

server
  .listen({ port, host })
  .then(() => {
    server.log.info(`Project Multiverse API on http://${host}:${port} (database: ${dbPath})`);
    server.log.info(serveWeb ? `Web app at http://${host}:${port}/` : 'Web app not built: run "npm run build -w @multiverse/web" to serve it here, or "npm run dev -w @multiverse/web" while developing.');
  })
  .catch((e) => {
    server.log.error(e);
    process.exit(1);
  });
