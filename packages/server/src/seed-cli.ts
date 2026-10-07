import { openDatabase } from './db/database';
import { COMMUNITY_CENTRE_ID, seedCommunityCentre, seedCommunityCentreEvents, seedDemoEvents, seedThriveni, THRIVENI_ID } from './seed';
import { ProjectService } from './service';

/**
 * npm run seed -w @multiverse/server -- [--sample thriveni|community-centre] [--db <path>] [--id <projectId>]
 *                                         [--unlocked m7,m6] [--events]
 *
 *   --sample     which sample project: "thriveni" (a VR training, the default) or "community-centre" (a building)
 *   --id         project id (default "thriveni", or "centre"); seed several projects into one database
 *   --unlocked   modules to leave unlocked, so they can still be edited after the project has started
 *   --events     also record three demo events so there is history to explore straight away
 *
 * Creates a sample project. Refuses to touch a project id that already exists.
 */
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const valueOf = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const dbPath = valueOf('--db') ?? process.env.DB_PATH ?? 'data/multiverse.sqlite';
const sample = valueOf('--sample') ?? 'thriveni';
if (sample !== 'thriveni' && sample !== 'community-centre') {
  console.error(`Unknown --sample "${sample}". Use thriveni or community-centre.`);
  process.exit(2);
}
const centre = sample === 'community-centre';
const id = valueOf('--id') ?? (centre ? COMMUNITY_CENTRE_ID : THRIVENI_ID);
const unlocked = (valueOf('--unlocked') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
if (args.includes('--db') && !valueOf('--db')) {
  console.error('--db needs a path');
  process.exit(2);
}

const db = openDatabase(dbPath);
const svc = new ProjectService(db);

if (svc.store.getProject(id)) {
  console.error(`Project "${id}" already exists in ${dbPath}. Delete the database file to start again, or pick another --id.`);
  db.close();
  process.exit(1);
}

try {
  if (centre) seedCommunityCentre(svc, id, { leaveUnlocked: unlocked });
  else seedThriveni(svc, id, { leaveUnlocked: unlocked });
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  db.close();
  process.exit(2);
}
const lockedNote = unlocked.length > 0 ? `, module(s) left unlocked: ${unlocked.join(', ')}` : ', all modules locked';
const original = svc.forecast(id);
console.log(`Seeded project "${id}" in ${dbPath}: ${svc.projectView(id).modules.length} modules, original delivery ${original.forecastDelivery.date}${lockedNote}.`);

if (flag('--events')) {
  if (centre) seedCommunityCentreEvents(svc, id);
  else seedDemoEvents(svc, id);
  const forecast = svc.forecast(id);
  console.log(`Recorded 3 demo events. Forecast delivery is now ${forecast.forecastDelivery.date} (${forecast.variance >= 0 ? '+' : ''}${forecast.variance} working days).`);
}
db.close();
