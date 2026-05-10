import { SCHEMA_V1_SQL, SCHEMA_V2_SQL } from './schema';

/**
 * Minimal subset of `expo-sqlite`'s `SQLiteDatabase` that the migration runner
 * needs. Declared as a structural interface so tests can supply a thin
 * `node:sqlite` (or any other) adapter without dragging the native module
 * into Jest's Node environment.
 *
 * The expo-sqlite `SQLiteDatabase` class is structurally compatible with this
 * interface — no cast required at the call site.
 */
export interface SqlExecutor {
  /** Execute one or more semicolon-separated statements. No params, no result. */
  execAsync(source: string): Promise<void>;
  /** Run a single statement returning at most one row. */
  getFirstAsync<T>(source: string): Promise<T | null>;
  /**
   * Wrap `task` in a transaction. Commits on resolve, rolls back on reject.
   * The migration runner uses this so a partial failure leaves the DB
   * unchanged — `user_version` only advances after every statement in the
   * migration succeeded.
   */
  withTransactionAsync(task: () => Promise<void>): Promise<void>;
}

export interface Migration {
  /** Strictly increasing positive integer. V1 ships at version 1. */
  version: number;
  /** Human-readable label. Surfaces in error messages only. */
  name: string;
  /** Schema mutation. Runs inside a transaction; throw to roll back. */
  up: (db: SqlExecutor) => Promise<void>;
}

/**
 * The full migration list. Append-only — never rewrite history. To change
 * the schema in V2, add `{ version: 2, name: 'add_xyz', up: ... }` and ship.
 *
 * V1 is a single statement-batch that creates all six tables and all
 * indexes in one transaction.
 */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial_schema',
    up: async (db) => {
      await db.execAsync(SCHEMA_V1_SQL);
    },
  },
  {
    // V2: client-side LLM daily-budget counter table (E11-005). Strictly
    // additive — a fresh DB hits V1 then V2 in order; an upgraded DB
    // already-at-V1 advances to V2 by running just this `up`.
    version: 2,
    name: 'llm_calls',
    up: async (db) => {
      await db.execAsync(SCHEMA_V2_SQL);
    },
  },
];

/** Highest version this build of the app knows how to run. */
export function targetUserVersion(migrations: Migration[] = MIGRATIONS): number {
  return migrations.reduce((max, m) => (m.version > max ? m.version : max), 0);
}

async function getUserVersion(db: SqlExecutor): Promise<number> {
  const row = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  return row?.user_version ?? 0;
}

/**
 * Run every migration whose `version` is greater than the DB's current
 * `user_version`, in order. Each migration runs inside its own transaction;
 * after the transaction commits, `user_version` is bumped to that
 * migration's version.
 *
 * Idempotent: re-opening a fully-migrated DB is a no-op (no transactions
 * are opened, no statements run).
 *
 * The caller is responsible for ensuring `PRAGMA foreign_keys = ON` is set
 * on the connection. Migrations must not assume FK enforcement during
 * `up` — SQLite's FK enforcement is a per-connection setting and the
 * migration runner does not flip it.
 *
 * Throws if migrations are non-monotonic (version <= 0, duplicate
 * versions, or out-of-order list) — those would corrupt the upgrade
 * graph silently otherwise.
 */
export async function runMigrations(
  db: SqlExecutor,
  migrations: Migration[] = MIGRATIONS,
): Promise<void> {
  validateMigrations(migrations);

  const current = await getUserVersion(db);
  const pending = migrations.filter((m) => m.version > current);
  if (pending.length === 0) {
    return;
  }

  for (const migration of pending) {
    await db.withTransactionAsync(async () => {
      await migration.up(db);
      // PRAGMA user_version doesn't accept bound params; the version is a
      // validated integer, so direct interpolation is safe.
      await db.execAsync(`PRAGMA user_version = ${migration.version}`);
    });
  }
}

function validateMigrations(migrations: Migration[]): void {
  let last = 0;
  const seen = new Set<number>();
  for (const m of migrations) {
    if (!Number.isInteger(m.version) || m.version <= 0) {
      throw new Error(
        `migration "${m.name}" has invalid version ${m.version}; must be a positive integer`,
      );
    }
    if (seen.has(m.version)) {
      throw new Error(`duplicate migration version ${m.version}`);
    }
    if (m.version <= last) {
      throw new Error(
        `migrations must be sorted ascending; saw ${m.version} after ${last}`,
      );
    }
    seen.add(m.version);
    last = m.version;
  }
}
