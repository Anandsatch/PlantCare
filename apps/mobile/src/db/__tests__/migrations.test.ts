/**
 * Migration runner tests.
 *
 * expo-sqlite is a native module — it doesn't load in Jest's Node environment.
 * Instead, we drive `runMigrations` against a `SqlExecutor` adapter backed by
 * `better-sqlite3` (synchronous SQLite for Node, broadly available across
 * runtime versions including the Node 20 baseline GitHub Actions ships with).
 * The adapter implements the same async surface the real expo-sqlite
 * `SQLiteDatabase` exposes (`execAsync` / `getFirstAsync` /
 * `withTransactionAsync`), so the migration code under test runs identical
 * bytes against both backends.
 *
 * Why not `node:sqlite`? It's Node 22.5+ only and CI runs on Node 20.
 *
 * What we don't test here: the actual `openDb()` call into expo-sqlite (a
 * thin wrapper that adds memoization and `PRAGMA foreign_keys = ON`). What
 * we do test: the SQL itself, the migration runner's idempotence and
 * transactional behavior, and the FK + index contract in `schema.ts`.
 */
import Database from 'better-sqlite3';
type DatabaseSync = Database.Database;

import {
  MIGRATIONS,
  runMigrations,
  targetUserVersion,
  type Migration,
  type SqlExecutor,
} from '../migrations';
import { SCHEMA_V1_SQL, V1_INDEXES, V1_TABLES, V2_INDEXES, V2_TABLES } from '../schema';

void MIGRATIONS;

/**
 * Minimal `SqlExecutor` over `better-sqlite3`'s synchronous API. Each call is
 * still async because that's what the real adapter promises — wrapping in
 * `Promise.resolve` keeps the contract honest.
 */
function makeAdapter(db: DatabaseSync): SqlExecutor {
  return {
    async execAsync(source: string) {
      db.exec(source);
    },
    async getFirstAsync<T>(source: string): Promise<T | null> {
      const row = db.prepare(source).get() as T | undefined;
      return row ?? null;
    },
    async withTransactionAsync(task) {
      db.exec('BEGIN');
      try {
        await task();
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
  };
}

function freshDb(): { adapter: SqlExecutor; raw: DatabaseSync } {
  const raw = new Database(':memory:');
  raw.exec('PRAGMA foreign_keys = ON');
  const adapter = makeAdapter(raw);
  return { adapter, raw };
}

function listTables(raw: DatabaseSync): string[] {
  return (
    raw
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as { name: string }[]
  ).map((r) => r.name);
}

function listIndexes(raw: DatabaseSync): string[] {
  return (
    raw
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as { name: string }[]
  ).map((r) => r.name);
}

function getUserVersion(raw: DatabaseSync): number {
  return (raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
}

describe('runMigrations - V1 + V2 schema', () => {
  it('creates every table from both V1 and V2 on a fresh DB', async () => {
    const { adapter, raw } = freshDb();
    await runMigrations(adapter);

    const tables = listTables(raw);
    expect(tables).toEqual([...V1_TABLES, ...V2_TABLES].sort());
  });

  it('creates every explicit index from both V1 and V2', async () => {
    const { adapter, raw } = freshDb();
    await runMigrations(adapter);

    const indexes = listIndexes(raw);
    expect(indexes).toEqual([...V1_INDEXES, ...V2_INDEXES].sort());
  });

  it('advances user_version to the target (V2)', async () => {
    const { adapter, raw } = freshDb();
    expect(getUserVersion(raw)).toBe(0);

    await runMigrations(adapter);
    expect(getUserVersion(raw)).toBe(targetUserVersion());
    expect(getUserVersion(raw)).toBe(2);
  });

  it('is a no-op on a fully-migrated DB (re-open does not rerun)', async () => {
    const { adapter, raw } = freshDb();
    await runMigrations(adapter);

    // Spy on execAsync to confirm zero statements run on the second pass.
    let calls = 0;
    const wrapped: SqlExecutor = {
      execAsync: async (source) => {
        calls += 1;
        return adapter.execAsync(source);
      },
      getFirstAsync: adapter.getFirstAsync.bind(adapter),
      withTransactionAsync: adapter.withTransactionAsync.bind(adapter),
    };

    await runMigrations(wrapped);
    expect(calls).toBe(0);
    expect(getUserVersion(raw)).toBe(2);
  });
});

describe('FK constraints', () => {
  it('declares the expected foreign keys on every table that owns one', async () => {
    const { adapter, raw } = freshDb();
    await runMigrations(adapter);

    type FkRow = { table: string; from: string; to: string; on_delete: string };
    const fkOf = (table: string): FkRow[] =>
      raw.prepare(`PRAGMA foreign_key_list('${table}')`).all() as FkRow[];

    expect(fkOf('plants')).toEqual([
      expect.objectContaining({
        table: 'photos',
        from: 'hero_photo_id',
        to: 'id',
        on_delete: 'SET NULL',
      }),
    ]);

    expect(fkOf('watering_events')).toEqual([
      expect.objectContaining({
        table: 'plants',
        from: 'plant_id',
        to: 'id',
        on_delete: 'CASCADE',
      }),
    ]);

    expect(fkOf('photos')).toEqual([
      expect.objectContaining({
        table: 'plants',
        from: 'plant_id',
        to: 'id',
        on_delete: 'CASCADE',
      }),
    ]);

    expect(fkOf('notes')).toEqual([
      expect.objectContaining({
        table: 'plants',
        from: 'plant_id',
        to: 'id',
        on_delete: 'CASCADE',
      }),
    ]);

    const diagnosesFk = fkOf('diagnoses');
    expect(diagnosesFk).toHaveLength(2);
    expect(diagnosesFk).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: 'plants',
          from: 'plant_id',
          on_delete: 'CASCADE',
        }),
        expect.objectContaining({
          table: 'photos',
          from: 'photo_id',
          on_delete: 'CASCADE',
        }),
      ]),
    );

    // sync_queue is intentionally unconstrained (ref_table/ref_id are dynamic).
    expect(fkOf('sync_queue')).toEqual([]);
  });

  it('rejects a watering_event with a non-existent plant_id when foreign_keys is ON', async () => {
    const { adapter, raw } = freshDb();
    await runMigrations(adapter);

    expect(() => {
      raw
        .prepare(
          "INSERT INTO watering_events (id, plant_id, watered_at, source) VALUES ('w1', 'does-not-exist', 1, 'user')",
        )
        .run();
    }).toThrow(/FOREIGN KEY/i);
  });

  it('cascades deletes from photos to diagnoses (uses idx_diagnoses_photo)', async () => {
    const { adapter, raw } = freshDb();
    await runMigrations(adapter);

    raw
      .prepare(
        "INSERT INTO plants (id, species_slug, added_at) VALUES ('p1', 'monstera_deliciosa', 1)",
      )
      .run();
    raw
      .prepare(
        "INSERT INTO photos (id, plant_id, uri, taken_at, kind) VALUES ('ph1', 'p1', 'file://a', 1, 'diagnose_input')",
      )
      .run();
    raw
      .prepare(
        "INSERT INTO diagnoses (id, plant_id, photo_id, run_at, status) VALUES ('d1', 'p1', 'ph1', 1, 'done')",
      )
      .run();

    raw.prepare("DELETE FROM photos WHERE id = 'ph1'").run();
    expect((raw.prepare('SELECT count(*) AS c FROM diagnoses').get() as { c: number }).c).toBe(0);
  });

  it('cascades deletes from plants to watering_events', async () => {
    const { adapter, raw } = freshDb();
    await runMigrations(adapter);

    raw
      .prepare(
        "INSERT INTO plants (id, species_slug, added_at) VALUES ('p1', 'monstera_deliciosa', 1000)",
      )
      .run();
    raw
      .prepare(
        "INSERT INTO watering_events (id, plant_id, watered_at, source) VALUES ('w1', 'p1', 2000, 'user')",
      )
      .run();
    expect(
      (raw.prepare('SELECT count(*) AS c FROM watering_events').get() as { c: number }).c,
    ).toBe(1);

    raw.prepare("DELETE FROM plants WHERE id = 'p1'").run();
    expect(
      (raw.prepare('SELECT count(*) AS c FROM watering_events').get() as { c: number }).c,
    ).toBe(0);
  });
});

describe('plants.is_indoor + override_interval_days (WORKBACK additions)', () => {
  it('defaults is_indoor to 1 (true) when omitted', async () => {
    const { adapter, raw } = freshDb();
    await runMigrations(adapter);

    raw
      .prepare("INSERT INTO plants (id, species_slug, added_at) VALUES ('p1', 'm', 1)")
      .run();
    const row = raw.prepare('SELECT is_indoor, override_interval_days FROM plants').get() as {
      is_indoor: number;
      override_interval_days: number | null;
    };
    expect(row.is_indoor).toBe(1);
    expect(row.override_interval_days).toBeNull();
  });

  it('rejects is_indoor values outside {0, 1} via CHECK constraint', async () => {
    const { adapter, raw } = freshDb();
    await runMigrations(adapter);

    expect(() => {
      raw
        .prepare(
          "INSERT INTO plants (id, species_slug, added_at, is_indoor) VALUES ('p1', 'm', 1, 2)",
        )
        .run();
    }).toThrow(/CHECK/i);
  });
});

describe('idx_plants_active partial index', () => {
  it('uses the partial index for queries that filter on archived_at IS NULL', async () => {
    const { adapter, raw } = freshDb();
    await runMigrations(adapter);

    const plan = raw
      .prepare(
        'EXPLAIN QUERY PLAN SELECT id FROM plants WHERE archived_at IS NULL ORDER BY added_at DESC',
      )
      .all() as { detail: string }[];
    const detail = plan.map((p) => p.detail).join(' | ');
    expect(detail).toMatch(/idx_plants_active/);
  });

  it('does not use the partial index for queries that include archived rows', async () => {
    const { adapter, raw } = freshDb();
    await runMigrations(adapter);

    // A query that doesn't filter on archived_at IS NULL cannot use the
    // partial index because the index doesn't contain those rows.
    const plan = raw
      .prepare('EXPLAIN QUERY PLAN SELECT id FROM plants ORDER BY added_at DESC')
      .all() as { detail: string }[];
    const detail = plan.map((p) => p.detail).join(' | ');
    expect(detail).not.toMatch(/idx_plants_active/);
  });
});

describe('idx_plants_hero_photo partial index', () => {
  it('uses the index for the photo-cascade lookup path', async () => {
    const { adapter, raw } = freshDb();
    await runMigrations(adapter);

    const plan = raw
      .prepare(
        "EXPLAIN QUERY PLAN SELECT id FROM plants WHERE hero_photo_id = 'ph1'",
      )
      .all() as { detail: string }[];
    const detail = plan.map((p) => p.detail).join(' | ');
    expect(detail).toMatch(/idx_plants_hero_photo/);
  });

  it('nulls hero_photo_id when the referenced photo is deleted', async () => {
    const { adapter, raw } = freshDb();
    await runMigrations(adapter);

    raw
      .prepare("INSERT INTO plants (id, species_slug, added_at) VALUES ('p1', 'm', 1)")
      .run();
    raw
      .prepare(
        "INSERT INTO photos (id, plant_id, uri, taken_at, kind) VALUES ('ph1', 'p1', 'file://a', 1, 'hero')",
      )
      .run();
    raw.prepare("UPDATE plants SET hero_photo_id = 'ph1' WHERE id = 'p1'").run();

    raw.prepare("DELETE FROM photos WHERE id = 'ph1'").run();
    const row = raw.prepare("SELECT hero_photo_id FROM plants WHERE id = 'p1'").get() as {
      hero_photo_id: string | null;
    };
    expect(row.hero_photo_id).toBeNull();
  });
});

describe('idx_queue_drainable partial index', () => {
  it('uses the partial index for the drainer query path', async () => {
    const { adapter, raw } = freshDb();
    await runMigrations(adapter);

    const plan = raw
      .prepare(
        "EXPLAIN QUERY PLAN SELECT id FROM sync_queue WHERE status = 'pending' AND next_attempt_at <= 100",
      )
      .all() as { detail: string }[];
    const detail = plan.map((p) => p.detail).join(' | ');
    expect(detail).toMatch(/idx_queue_drainable/);
  });
});

describe('migration validation', () => {
  it('throws on duplicate migration versions', async () => {
    const { adapter } = freshDb();
    const bad: Migration[] = [
      { version: 1, name: 'a', up: async () => undefined },
      { version: 1, name: 'b', up: async () => undefined },
    ];
    await expect(runMigrations(adapter, bad)).rejects.toThrow(/duplicate/);
  });

  it('throws on out-of-order migrations', async () => {
    const { adapter } = freshDb();
    const bad: Migration[] = [
      { version: 2, name: 'a', up: async () => undefined },
      { version: 1, name: 'b', up: async () => undefined },
    ];
    await expect(runMigrations(adapter, bad)).rejects.toThrow(/sorted ascending/);
  });

  it('throws on non-positive versions', async () => {
    const { adapter } = freshDb();
    const bad: Migration[] = [{ version: 0, name: 'a', up: async () => undefined }];
    await expect(runMigrations(adapter, bad)).rejects.toThrow(/invalid version/);
  });
});

describe('V2 — llm_calls table (E11-005 budget meter)', () => {
  it('creates the llm_calls table with the expected columns', async () => {
    const { adapter, raw } = freshDb();
    await runMigrations(adapter);

    const cols = raw.prepare("PRAGMA table_info('llm_calls')").all() as Array<{
      name: string;
      type: string;
      notnull: number;
      pk: number;
    }>;
    const byName = new Map(cols.map((c) => [c.name, c]));
    expect(byName.get('id')).toMatchObject({ type: 'INTEGER', pk: 1 });
    expect(byName.get('endpoint')).toMatchObject({ type: 'TEXT', notnull: 1 });
    expect(byName.get('called_at_ms')).toMatchObject({ type: 'INTEGER', notnull: 1 });
  });

  it('declares id as AUTOINCREMENT (sqlite_sequence row materializes)', async () => {
    const { adapter, raw } = freshDb();
    await runMigrations(adapter);

    raw
      .prepare("INSERT INTO llm_calls (endpoint, called_at_ms) VALUES ('identify', 1000)")
      .run();

    // sqlite_sequence is the canonical AUTOINCREMENT marker; without
    // AUTOINCREMENT, SQLite would use rowid and never populate this table.
    const seq = raw
      .prepare("SELECT name FROM sqlite_sequence WHERE name = 'llm_calls'")
      .get() as { name: string } | undefined;
    expect(seq?.name).toBe('llm_calls');
  });

  it('creates the idx_llm_calls_called_at index', async () => {
    const { adapter, raw } = freshDb();
    await runMigrations(adapter);

    const indexes = listIndexes(raw);
    expect(indexes).toContain('idx_llm_calls_called_at');
  });

  it('upgrades a V1-only DB to V2 without re-running V1', async () => {
    const { adapter, raw } = freshDb();

    // Simulate a V1-shipped device: run only the first migration.
    const v1Only: Migration[] = [
      {
        version: 1,
        name: 'v1',
        up: async (db) => {
          // Run V1's actual SCHEMA_V1_SQL via the public path so the FK
          // contract stays honest.
          await db.execAsync(SCHEMA_V1_SQL);
        },
      },
    ];
    await runMigrations(adapter, v1Only);
    expect(getUserVersion(raw)).toBe(1);
    expect(listTables(raw)).not.toContain('llm_calls');

    // Now run the full migration list. V1 should not re-run; only V2 advances.
    await runMigrations(adapter);
    expect(getUserVersion(raw)).toBe(2);
    expect(listTables(raw)).toContain('llm_calls');
  });

  it('is idempotent — re-running on a V2 DB is a no-op', async () => {
    const { adapter, raw } = freshDb();
    await runMigrations(adapter);
    expect(getUserVersion(raw)).toBe(2);

    // Insert a row, then re-run migrations. Idempotence means the row
    // survives — V2's `up` did not recreate the table.
    raw
      .prepare("INSERT INTO llm_calls (endpoint, called_at_ms) VALUES ('diagnose', 5000)")
      .run();

    await runMigrations(adapter);
    expect(getUserVersion(raw)).toBe(2);
    const count = (
      raw.prepare('SELECT COUNT(*) AS c FROM llm_calls').get() as { c: number }
    ).c;
    expect(count).toBe(1);
  });
});

describe('transactional rollback', () => {
  it('rolls back user_version when the migration up() throws', async () => {
    const { adapter, raw } = freshDb();
    const failing: Migration[] = [
      {
        version: 1,
        name: 'partial',
        up: async (db) => {
          await db.execAsync('CREATE TABLE x (id INTEGER)');
          throw new Error('boom');
        },
      },
    ];

    await expect(runMigrations(adapter, failing)).rejects.toThrow(/boom/);

    // Both the table creation and the user_version bump should be rolled back.
    expect(getUserVersion(raw)).toBe(0);
    expect(listTables(raw)).not.toContain('x');
  });
});
