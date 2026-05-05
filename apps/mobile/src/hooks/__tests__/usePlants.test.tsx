/**
 * `usePlants()` tests — drive the pure data API (`createPlantsApi`) against
 * a `better-sqlite3`-backed `PlantsExecutor` adapter. Same pattern as
 * `db/__tests__/migrations.test.ts`: native expo-sqlite doesn't load in
 * Jest's Node environment, but every SQL byte we ship is identical between
 * the two backends, so the SQL contract is what gets tested here.
 *
 * The React hook (`usePlants`) is a one-line `useMemo` over `createPlantsApi`
 * + an `openDb()`-backed executor. It carries no logic that the data API
 * doesn't already exercise, so the tests target `createPlantsApi` directly.
 */
import Database from 'better-sqlite3';
type DatabaseSync = Database.Database;

import { runMigrations } from '../../db/migrations';
import type { PlantRow } from '../../db/types';
import { createPlantsApi, type PlantsExecutor, type SqlBindValue } from '../usePlants';

/**
 * Map our async / variadic-array `PlantsExecutor` to better-sqlite3's
 * synchronous prepare-and-bind API. `runAsync(sql, [a, b])` becomes
 * `db.prepare(sql).run(a, b)`. Spreading the params array reproduces
 * expo-sqlite's variadic semantics exactly.
 */
function makePlantsAdapter(db: DatabaseSync): PlantsExecutor {
  return {
    async runAsync(source: string, params: SqlBindValue[]) {
      db.prepare(source).run(...params);
    },
    async getFirstAsync<T>(source: string, params: SqlBindValue[]): Promise<T | null> {
      const row = db.prepare(source).get(...params) as T | undefined;
      return row ?? null;
    },
    async getAllAsync<T>(source: string, params: SqlBindValue[]): Promise<T[]> {
      return db.prepare(source).all(...params) as T[];
    },
  };
}

/**
 * `runMigrations` takes the migration-runner-shaped `SqlExecutor` (no params).
 * Reuse the same adapter shape from `migrations.test.ts`.
 */
function makeMigrationAdapter(db: DatabaseSync) {
  return {
    async execAsync(source: string) {
      db.exec(source);
    },
    async getFirstAsync<T>(source: string): Promise<T | null> {
      const row = db.prepare(source).get() as T | undefined;
      return row ?? null;
    },
    async withTransactionAsync(task: () => Promise<void>) {
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

async function setupDb(): Promise<{ raw: DatabaseSync; api: ReturnType<typeof createPlantsApi> }> {
  const raw = new Database(':memory:');
  raw.exec('PRAGMA foreign_keys = ON');
  await runMigrations(makeMigrationAdapter(raw));
  const api = createPlantsApi(makePlantsAdapter(raw));
  return { raw, api };
}

describe('usePlants - create', () => {
  it('round-trips: returned Plant matches the row in the DB', async () => {
    const { raw, api } = await setupDb();
    const before = Date.now();
    const plant = await api.create({
      species_slug: 'monstera_deliciosa',
      species_label: 'Monstera Deliciosa',
      nickname: 'Steve',
      location: 'Living room',
      identify_confidence: 91,
    });
    const after = Date.now();

    const row = raw
      .prepare('SELECT id, species_slug, nickname, is_indoor, added_at FROM plants WHERE id = ?')
      .get(plant.id) as { id: string; species_slug: string; nickname: string | null; is_indoor: number; added_at: number };

    expect(row).toEqual({
      id: plant.id,
      species_slug: 'monstera_deliciosa',
      nickname: 'Steve',
      is_indoor: 1,
      added_at: plant.added_at,
    });
    expect(plant.added_at).toBeGreaterThanOrEqual(before);
    expect(plant.added_at).toBeLessThanOrEqual(after);
    expect(plant.archived_at).toBeNull();
    expect(plant.species_label).toBe('Monstera Deliciosa');
    expect(plant.identify_confidence).toBe(91);
  });

  it('defaults is_indoor to true (1) when omitted', async () => {
    const { raw, api } = await setupDb();
    const plant = await api.create({ species_slug: 'pothos' });

    expect(plant.is_indoor).toBe(true);
    const row = raw.prepare('SELECT is_indoor FROM plants WHERE id = ?').get(plant.id) as {
      is_indoor: number;
    };
    expect(row.is_indoor).toBe(1);
  });

  it('persists is_indoor=false as INTEGER 0 and reads back as boolean false', async () => {
    const { raw, api } = await setupDb();
    const plant = await api.create({ species_slug: 'olive_tree', is_indoor: false });

    expect(plant.is_indoor).toBe(false);
    const row = raw.prepare('SELECT is_indoor FROM plants WHERE id = ?').get(plant.id) as {
      is_indoor: number;
    };
    expect(row.is_indoor).toBe(0);

    const refetched = await api.getById(plant.id);
    expect(refetched?.is_indoor).toBe(false);
  });

  it('persists override_interval_days when provided; null when omitted', async () => {
    const { api } = await setupDb();
    const withOverride = await api.create({ species_slug: 'cactus', override_interval_days: 14 });
    const withoutOverride = await api.create({ species_slug: 'fern' });

    expect(withOverride.override_interval_days).toBe(14);
    expect(withoutOverride.override_interval_days).toBeNull();
  });

  it('auto-generates a UUID id when omitted; honors a caller-supplied id', async () => {
    const { api } = await setupDb();
    const auto = await api.create({ species_slug: 'fiddle_leaf' });
    expect(auto.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

    const custom = await api.create({ id: 'plant_custom_42', species_slug: 'snake_plant' });
    expect(custom.id).toBe('plant_custom_42');
  });

  it('rejects empty / whitespace-only species_slug', async () => {
    const { api } = await setupDb();
    await expect(api.create({ species_slug: '' })).rejects.toThrow(/species_slug/);
    await expect(api.create({ species_slug: '   ' })).rejects.toThrow(/species_slug/);
  });
});

describe('usePlants - list', () => {
  it('excludes archived rows by default', async () => {
    const { api } = await setupDb();
    const a = await api.create({ species_slug: 'a' });
    const b = await api.create({ species_slug: 'b' });
    await api.archive(b.id);

    const visible = await api.list();
    expect(visible.map((p) => p.id)).toEqual([a.id]);
  });

  it('includes archived rows when includeArchived: true', async () => {
    const { api } = await setupDb();
    const a = await api.create({ species_slug: 'a' });
    const b = await api.create({ species_slug: 'b' });
    await api.archive(b.id);

    const all = await api.list({ includeArchived: true });
    expect(all.map((p) => p.id).sort()).toEqual([a.id, b.id].sort());
  });

  it('orders by added_at DESC (most recent first)', async () => {
    const { raw, api } = await setupDb();
    raw
      .prepare(
        "INSERT INTO plants (id, species_slug, added_at, is_indoor) VALUES ('p1', 's1', 1000, 1)",
      )
      .run();
    raw
      .prepare(
        "INSERT INTO plants (id, species_slug, added_at, is_indoor) VALUES ('p2', 's2', 3000, 1)",
      )
      .run();
    raw
      .prepare(
        "INSERT INTO plants (id, species_slug, added_at, is_indoor) VALUES ('p3', 's3', 2000, 1)",
      )
      .run();

    const result = await api.list();
    expect(result.map((p) => p.id)).toEqual(['p2', 'p3', 'p1']);
  });
});

describe('usePlants - getById', () => {
  it('returns null for a missing id', async () => {
    const { api } = await setupDb();
    const row = await api.getById('does-not-exist');
    expect(row).toBeNull();
  });

  it('returns the row when present (round-trip from create)', async () => {
    const { api } = await setupDb();
    const plant = await api.create({ species_slug: 'monstera_deliciosa', nickname: 'Steve' });
    const fetched = await api.getById(plant.id);
    expect(fetched).toEqual(plant);
  });
});

describe('usePlants - update', () => {
  it('returns the updated row reflecting the patched fields', async () => {
    const { raw, api } = await setupDb();
    const plant = await api.create({ species_slug: 'pothos', nickname: 'Old' });

    const updated = await api.update(plant.id, {
      nickname: 'New',
      override_interval_days: 10,
    });

    expect(updated.id).toBe(plant.id);
    expect(updated.nickname).toBe('New');
    expect(updated.override_interval_days).toBe(10);
    expect(updated.species_slug).toBe('pothos');
    expect(updated.added_at).toBe(plant.added_at);

    const row = raw
      .prepare('SELECT nickname, override_interval_days FROM plants WHERE id = ?')
      .get(plant.id) as { nickname: string; override_interval_days: number };
    expect(row.nickname).toBe('New');
    expect(row.override_interval_days).toBe(10);
  });

  it('toggles is_indoor with correct INTEGER marshalling', async () => {
    const { raw, api } = await setupDb();
    const plant = await api.create({ species_slug: 'olive_tree', is_indoor: true });

    const toFalse = await api.update(plant.id, { is_indoor: false });
    expect(toFalse.is_indoor).toBe(false);
    expect(
      (raw.prepare('SELECT is_indoor FROM plants WHERE id = ?').get(plant.id) as {
        is_indoor: number;
      }).is_indoor,
    ).toBe(0);

    const toTrue = await api.update(plant.id, { is_indoor: true });
    expect(toTrue.is_indoor).toBe(true);
    expect(
      (raw.prepare('SELECT is_indoor FROM plants WHERE id = ?').get(plant.id) as {
        is_indoor: number;
      }).is_indoor,
    ).toBe(1);
  });

  it('throws on unknown patch keys (defends against typos and hostile input)', async () => {
    const { api } = await setupDb();
    const plant = await api.create({ species_slug: 'pothos' });
    await expect(
      api.update(plant.id, { foo_bar: 1 } as unknown as Parameters<typeof api.update>[1]),
    ).rejects.toThrow(/unknown patch key/);
  });

  it('throws when the target row is missing', async () => {
    const { api } = await setupDb();
    await expect(api.update('missing-id', { nickname: 'x' })).rejects.toThrow(/not found/);
  });

  it('treats empty patch as a no-op re-read (returns current state)', async () => {
    const { api } = await setupDb();
    const plant = await api.create({ species_slug: 'pothos', nickname: 'Steve' });
    const result = await api.update(plant.id, {});
    expect(result).toEqual(plant);
  });

  it('returns the row produced by this UPDATE atomically, not a later SELECT (race-safe)', async () => {
    // Codex P2 from adversarial review: an UPDATE-then-SELECT can return
    // another caller's row state if a concurrent update lands between the
    // two statements. Today the implementation uses UPDATE ... RETURNING,
    // so the returned row is by-definition the row produced by THIS write.
    // Simulate the race by interleaving a second write between this write's
    // statement and any subsequent read (via a wrapping executor that fires
    // a hostile UPDATE right after each runAsync). If the implementation
    // ever regresses to UPDATE-then-SELECT, the assertion below will fail.
    const { raw, api: baseApi } = await setupDb();
    const plant = await baseApi.create({ species_slug: 'pothos', nickname: 'A' });

    let interceptedOnce = false;
    const racingExecutor: PlantsExecutor = {
      async runAsync(source, params) {
        return makePlantsAdapter(raw).runAsync(source, params);
      },
      async getFirstAsync<T>(source: string, params: SqlBindValue[]) {
        const result = await makePlantsAdapter(raw).getFirstAsync<T>(source, params);
        // After the FIRST statement that returns a row, fire a hostile
        // overwrite. If update() ran a second SELECT it would now read this
        // hostile value; if it used RETURNING it already has its answer.
        if (!interceptedOnce && /^UPDATE plants SET/.test(source)) {
          interceptedOnce = true;
          raw.prepare("UPDATE plants SET nickname = 'HOSTILE' WHERE id = ?").run(plant.id);
        }
        return result;
      },
      async getAllAsync<T>(source: string, params: SqlBindValue[]) {
        return makePlantsAdapter(raw).getAllAsync<T>(source, params);
      },
    };
    const racingApi = createPlantsApi(racingExecutor);

    const updated = await racingApi.update(plant.id, { nickname: 'B' });
    // The returned row must reflect THIS update's intent (B), not the
    // hostile interleaved write (HOSTILE).
    expect(updated.nickname).toBe('B');
    // The hostile write did happen — verify the DB state reflects it so
    // we know the harness is working.
    const finalRow = raw
      .prepare('SELECT nickname FROM plants WHERE id = ?')
      .get(plant.id) as { nickname: string };
    expect(finalRow.nickname).toBe('HOSTILE');
  });
});

describe('usePlants - archive / unarchive', () => {
  it('archive() sets archived_at, list() then excludes the row', async () => {
    const { raw, api } = await setupDb();
    const plant = await api.create({ species_slug: 'pothos' });
    const before = Date.now();
    await api.archive(plant.id);
    const after = Date.now();

    const row = raw
      .prepare('SELECT archived_at FROM plants WHERE id = ?')
      .get(plant.id) as { archived_at: number | null };
    expect(row.archived_at).not.toBeNull();
    expect(row.archived_at).toBeGreaterThanOrEqual(before);
    expect(row.archived_at).toBeLessThanOrEqual(after);

    const visible = await api.list();
    expect(visible).toEqual([]);
  });

  it('unarchive() clears archived_at back to NULL; row reappears in list()', async () => {
    const { raw, api } = await setupDb();
    const plant = await api.create({ species_slug: 'pothos' });
    await api.archive(plant.id);
    await api.unarchive(plant.id);

    const row = raw
      .prepare('SELECT archived_at FROM plants WHERE id = ?')
      .get(plant.id) as { archived_at: number | null };
    expect(row.archived_at).toBeNull();

    const visible = await api.list();
    expect(visible.map((p) => p.id)).toEqual([plant.id]);
  });
});

describe('usePlants - remove (FK CASCADE)', () => {
  it('hard-deletes the plant and cascades to watering_events', async () => {
    const { raw, api } = await setupDb();
    const plant = await api.create({ species_slug: 'pothos' });

    raw
      .prepare(
        "INSERT INTO watering_events (id, plant_id, watered_at, source) VALUES ('w1', ?, 1000, 'user')",
      )
      .run(plant.id);
    raw
      .prepare(
        "INSERT INTO watering_events (id, plant_id, watered_at, source) VALUES ('w2', ?, 2000, 'user')",
      )
      .run(plant.id);
    expect(
      (raw.prepare('SELECT count(*) AS c FROM watering_events').get() as { c: number }).c,
    ).toBe(2);

    await api.remove(plant.id);

    expect(await api.getById(plant.id)).toBeNull();
    expect(
      (raw.prepare('SELECT count(*) AS c FROM watering_events').get() as { c: number }).c,
    ).toBe(0);
  });

  it('parameterizes the id (no SQL injection via id strings)', async () => {
    const { raw, api } = await setupDb();
    const plant = await api.create({ species_slug: 'pothos' });
    const other = await api.create({ species_slug: 'monstera' });

    // A hostile id that, if interpolated, would delete every row. Bound
    // parameters reduce this to "row with id = literal-string"; no row
    // matches, nothing happens.
    await api.remove("' OR '1'='1");

    expect(await api.getById(plant.id)).not.toBeNull();
    expect(await api.getById(other.id)).not.toBeNull();
    expect(
      (raw.prepare('SELECT count(*) AS c FROM plants').get() as { c: number }).c,
    ).toBe(2);
  });
});

describe('usePlants - boolean marshalling round-trip', () => {
  it('is_indoor true <-> 1 and false <-> 0 across create/update/list/getById', async () => {
    const { raw, api } = await setupDb();
    const indoorPlant = await api.create({ species_slug: 'pothos', is_indoor: true });
    const outdoorPlant = await api.create({ species_slug: 'olive', is_indoor: false });

    const rows = raw
      .prepare('SELECT id, is_indoor FROM plants ORDER BY id')
      .all() as { id: string; is_indoor: number }[];
    const rowMap = new Map(rows.map((r) => [r.id, r.is_indoor]));
    expect(rowMap.get(indoorPlant.id)).toBe(1);
    expect(rowMap.get(outdoorPlant.id)).toBe(0);

    const visibleAll = await api.list();
    const apiMap = new Map(visibleAll.map((p) => [p.id, p.is_indoor]));
    expect(apiMap.get(indoorPlant.id)).toBe(true);
    expect(apiMap.get(outdoorPlant.id)).toBe(false);

    const firstFetch = await api.getById(indoorPlant.id);
    expect(firstFetch?.is_indoor).toStrictEqual(true);
    const secondFetch = await api.getById(outdoorPlant.id);
    expect(secondFetch?.is_indoor).toStrictEqual(false);
  });

  it('PlantRow type matches what better-sqlite3 returns: is_indoor as number', async () => {
    const { raw, api } = await setupDb();
    await api.create({ species_slug: 'pothos', is_indoor: true });

    const row = raw
      .prepare('SELECT id, species_slug, species_label, nickname, location, identify_confidence, hero_photo_id, added_at, archived_at, is_indoor, override_interval_days FROM plants')
      .get() as PlantRow;
    expect(typeof row.is_indoor).toBe('number');
    expect(row.is_indoor).toBe(1);
  });
});
