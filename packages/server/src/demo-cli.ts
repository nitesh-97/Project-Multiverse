import { existsSync, rmSync } from 'node:fs';
import { openDatabase } from './db/database';
import { seedDemoProjects } from './seed';
import { ProjectService } from './service';

/**
 * node --import tsx src/demo-cli.ts <path-to-demo-database>
 *
 * Starts the demo database again from nothing: deletes that one file, then loads the four sample projects. It only ever
 * touches the path it is given, which `npm run demo` sets to data/demo.sqlite, never the real database.
 */
const path = process.argv[2];
if (!path) {
  console.error('Usage: demo-cli <path to the demo database>');
  process.exit(2);
}

try {
  for (const suffix of ['', '-wal', '-shm']) if (existsSync(path + suffix)) rmSync(path + suffix, { force: true });
} catch {
  console.error(`\nThe demo database (${path}) is in use, so it cannot be started again.\nIs the demo from an earlier run still going? Stop it (Ctrl+C in its window) and run "npm run demo" again.`);
  process.exit(1);
}

const db = openDatabase(path);
const svc = new ProjectService(db);
const ids = seedDemoProjects(svc);
for (const id of ids) {
  const f = svc.forecast(id);
  console.log(`  ${id.padEnd(8)} ${svc.requireProject(id).name.padEnd(24)} delivery ${f.forecastDelivery.date} (${f.variance >= 0 ? '+' : ''}${f.variance} working days against the plan)`);
}
db.close();
