import { openDatabaseAsync, type SQLiteDatabase } from 'expo-sqlite';

import { MIGRATIONS, runMigrations } from './migrations';

/**
 * Filename of the on-device SQLite database. expo-sqlite places it under
 * `<documentDirectory>/SQLite/plantcare.db` on both iOS and Android.
 */
export const DATABASE_NAME = 'plantcare.db';

let cached: Promise<SQLiteDatabase> | null = null;

/**
 * Open the PlantCare database and run pending migrations.
 *
 * Memoized: subsequent calls return the same `SQLiteDatabase` instance, so
 * repeated `openDb()` calls during app navigation don't reopen connections
 * or re-check `user_version`. Migrations only run on the first call after
 * a process start.
 *
 * Sets `PRAGMA foreign_keys = ON` on the connection before running
 * migrations. SQLite defaults to OFF — without this, the FK constraints in
 * `schema.ts` are inert, and a hostile insert (e.g. a `watering_event` with
 * a non-existent `plant_id`) would corrupt the local store silently.
 */
export async function openDb(): Promise<SQLiteDatabase> {
  if (cached) return cached;

  cached = (async () => {
    const db = await openDatabaseAsync(DATABASE_NAME);
    // Per-connection setting; must run before migrations so FK violations in
    // any migration `up` would surface immediately.
    await db.execAsync('PRAGMA foreign_keys = ON');
    await runMigrations(db, MIGRATIONS);
    return db;
  })();

  try {
    return await cached;
  } catch (err) {
    // If open or migration failed, drop the cache so the next call retries
    // with a fresh attempt instead of permanently returning the rejected
    // promise.
    cached = null;
    throw err;
  }
}

/**
 * Test-only escape hatch. Resets the memoized connection so a fresh
 * `openDb()` will reopen and re-migrate. Not exported from `index.ts`.
 */
export function _resetDbCacheForTests(): void {
  cached = null;
}
