import { openDatabase } from './db/database';
import { seedDemoEvents, seedThriveni, THRIVENI_ID } from './seed';
import { ProjectService } from './service';

/**
 * npm run seed -w @multiverse/server -- [--db <path>] [--events]
 *
 * Creates the Thriveni reference project and locks all its modules. With --events it also records three demo
 * events so there is history to explore straight away. Refuses to touch a database that already has the project.
 */
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const dbIndex = args.indexOf('--db');
const dbPath = dbIndex >= 0 ? (args[dbIndex + 1] ?? '') : (process.env.DB_PATH ?? 'data/multiverse.sqlite');
if (!dbPath) {
  console.error('--db needs a path');
  process.exit(2);
}

const db = openDatabase(dbPath);
const svc = new ProjectService(db);

if (svc.store.getProject(THRIVENI_ID)) {
  console.error(`Project "${THRIVENI_ID}" already exists in ${dbPath}. Delete the database file to start again.`);
  db.close();
  process.exit(1);
}

seedThriveni(svc);
console.log(`Seeded project "${THRIVENI_ID}" in ${dbPath}: 7 modules, original delivery Fri 2026-10-30, all modules locked.`);

if (flag('--events')) {
  seedDemoEvents(svc);
  const forecast = svc.forecast(THRIVENI_ID);
  console.log(`Recorded 3 demo events. Forecast delivery is now ${forecast.forecastDelivery.date} (${forecast.variance >= 0 ? '+' : ''}${forecast.variance} working days).`);
}
db.close();
