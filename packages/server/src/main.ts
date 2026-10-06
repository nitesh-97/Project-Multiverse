import { buildApp } from './app';
import { openDatabase } from './db/database';

// Local by default: nothing else on the network can reach it unless HOST is changed.
const port = Number(process.env.PORT ?? 4000);
const host = process.env.HOST ?? '127.0.0.1';
const dbPath = process.env.DB_PATH ?? 'data/multiverse.sqlite';

const db = openDatabase(dbPath);
const { server } = buildApp({ db, logger: true });

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
  .then(() => server.log.info(`Project Multiverse API on http://${host}:${port} (database: ${dbPath})`))
  .catch((e) => {
    server.log.error(e);
    process.exit(1);
  });
