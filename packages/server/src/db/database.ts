import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA } from './schema';

export type Db = DatabaseSync;

/** Opens (creating if needed) a SQLite database and applies the schema. Use ':memory:' for tests. */
export function openDatabase(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON');
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  db.exec(SCHEMA);
  return db;
}

const depth = new WeakMap<Db, number>();

/**
 * Runs `fn` atomically. Re-entrant: a nested call joins the outer transaction, so service methods can call each
 * other freely. Any exception rolls the whole thing back and is rethrown unchanged.
 */
export function transaction<T>(db: Db, fn: () => T): T {
  const level = depth.get(db) ?? 0;
  if (level > 0) return fn();

  db.exec('BEGIN IMMEDIATE');
  depth.set(db, 1);
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (e) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // SQLite already rolled back (some errors do that); nothing left to undo.
    }
    throw e;
  } finally {
    depth.set(db, 0);
  }
}
