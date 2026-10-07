// npm run demo
//
// One command to try the app: starts a demo database from nothing (data/demo.sqlite, never your real data), loads the
// four sample projects, builds the web app and starts the server. Open http://127.0.0.1:4000 (or the PORT you set).
// Press Ctrl+C to stop.
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const demoDb = resolve(root, 'data', 'demo.sqlite');
mkdirSync(dirname(demoDb), { recursive: true });

const run = (label, command, args, env = {}) => {
  console.log(`\n> ${label}`);
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', shell: true, env: { ...process.env, ...env } });
  if (result.status !== 0) {
    console.error(`\n"${label}" did not finish (exit ${result.status}).`);
    process.exit(result.status ?? 1);
  }
};

run('Loading the sample projects into a fresh demo database', 'node', ['--import', 'tsx', 'packages/server/src/demo-cli.ts', `"${demoDb}"`]);
run('Building the web app', 'npm', ['run', 'build', '-w', '@multiverse/web']);
console.log(`\n> Starting the server on http://127.0.0.1:${process.env.PORT ?? 4000} (Ctrl+C to stop)\n`);
run('Server', 'npm', ['start', '-w', '@multiverse/server'], { DB_PATH: demoDb });
