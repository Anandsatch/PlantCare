/**
 * `usePlants()` — CRUD for the local `plants` table.
 *
 * V1 storage is local SQLite via `expo-sqlite`; no cloud sync, no ORM, raw
 * parameterized SQL. The hook returns a stable callbacks object (memoized
 * against the empty dep set) so consumers can pass the methods to
 * `useEffect` deps or memoized children without thrash.
 *
 * **Concurrency model.** `openDb()` is itself memoized at the module level
 * (see `db/db.ts`), so calling `usePlants()` from two components yields the
 * same underlying `SQLiteDatabase`. expo-sqlite serializes statements on a
 * single connection per its native module contract, so two simultaneous
 * `create()` calls are race-safe — they queue at the SQLite layer.
 *
 * **Parameterization.** Every value is bound, never interpolated. Column
 * lists in the dynamic UPDATE path come from a closed allow-list
 * (`UPDATE_COLUMNS`); a caller passing an unknown patch key throws before
 * any SQL is built.
 *
 * **Boolean marshalling.** `is_indoor` is `INTEGER 0|1` in SQLite (with a
 * `CHECK` constraint enforcing membership). The hook converts JS booleans
 * to `0|1` on write and back to `boolean` on read so callers never see the
 * numeric form.
 *
 * **Testability.** `createPlantsApi(executor)` is the pure-data surface;
 * tests instantiate it with a `better-sqlite3`-backed `PlantsExecutor`
 * adapter (same shape as the migration tests) and exercise everything
 * without booting Jest's RN environment. The `usePlants()` React hook is
 * a thin wrapper that resolves the executor via `openDb()`.
 */
import { useMemo } from 'react';

import { openDb } from '../db/db';
import type {
  CreatePlantInput,
  Plant,
  PlantRow,
  UpdatePlantPatch,
} from '../db/types';

/**
 * Subset of `expo-sqlite`'s `SQLiteDatabase` that this module needs. Parameter
 * arrays are the variadic-array form (`runAsync(sql, [a, b])`), which both
 * expo-sqlite and our `better-sqlite3` test adapter implement.
 *
 * `string | number | null` covers every column in `plants`. `Uint8Array`
 * isn't needed at this layer — photo bytes live on the filesystem; only the
 * `uri` (string) lives in SQLite.
 */
export type SqlBindValue = string | number | null;

export interface PlantsExecutor {
  runAsync(source: string, params: SqlBindValue[]): Promise<unknown>;
  getFirstAsync<T>(source: string, params: SqlBindValue[]): Promise<T | null>;
  getAllAsync<T>(source: string, params: SqlBindValue[]): Promise<T[]>;
}

const SELECT_COLUMNS =
  'id, species_slug, species_label, nickname, location, identify_confidence, ' +
  'hero_photo_id, added_at, archived_at, is_indoor, override_interval_days';

/**
 * Allow-list of patch keys for `update()`. The dynamic UPDATE statement is
 * built from this list intersected with the patch keys, so a hostile or
 * mistyped key never reaches SQL. `id` and `added_at` are intentionally
 * omitted — created-at is immutable and `id` is the row key, not a patch
 * field. `archived_at` is only flipped via `archive()` / `unarchive()` so
 * the soft-delete state machine has one entry point.
 */
const UPDATE_COLUMNS = [
  'species_slug',
  'species_label',
  'nickname',
  'location',
  'identify_confidence',
  'hero_photo_id',
  'is_indoor',
  'override_interval_days',
] as const;
type UpdateColumn = (typeof UPDATE_COLUMNS)[number];

function isUpdateColumn(key: string): key is UpdateColumn {
  return (UPDATE_COLUMNS as readonly string[]).includes(key);
}

function rowToPlant(row: PlantRow): Plant {
  return {
    id: row.id,
    species_slug: row.species_slug,
    species_label: row.species_label,
    nickname: row.nickname,
    location: row.location,
    identify_confidence: row.identify_confidence,
    hero_photo_id: row.hero_photo_id,
    added_at: row.added_at,
    archived_at: row.archived_at,
    // SQLite has no native bool; marshall the INTEGER 0|1 back. The CHECK
    // constraint guarantees the column is exactly 0 or 1, so `=== 1` is a
    // safe round-trip.
    is_indoor: row.is_indoor === 1,
    override_interval_days: row.override_interval_days,
  };
}

function generateId(): string {
  // Hermes (RN 0.74+) and Node 20+ both expose `crypto.randomUUID`. The hook
  // runs in both contexts (device + better-sqlite3 unit tests) so this is
  // the simplest viable path. If a target without it appears later, swap to
  // `expo-crypto`'s `randomUUID()`.
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (!c?.randomUUID) {
    throw new Error('crypto.randomUUID is unavailable; cannot generate plant id');
  }
  return c.randomUUID();
}

/**
 * Pure-data plants API. Takes a `PlantsExecutor` and returns the same
 * callbacks `usePlants()` exposes. Exported for tests and for any future
 * code that needs to operate on plants outside a React render (drainer
 * tasks, migration scripts).
 */
export function createPlantsApi(executor: PlantsExecutor) {
  async function getById(id: string): Promise<Plant | null> {
    const row = await executor.getFirstAsync<PlantRow>(
      `SELECT ${SELECT_COLUMNS} FROM plants WHERE id = ?`,
      [id],
    );
    return row ? rowToPlant(row) : null;
  }

  async function list(opts?: { includeArchived?: boolean }): Promise<Plant[]> {
    const includeArchived = opts?.includeArchived === true;
    const sql = includeArchived
      ? `SELECT ${SELECT_COLUMNS} FROM plants ORDER BY added_at DESC`
      : `SELECT ${SELECT_COLUMNS} FROM plants WHERE archived_at IS NULL ORDER BY added_at DESC`;
    const rows = await executor.getAllAsync<PlantRow>(sql, []);
    return rows.map(rowToPlant);
  }

  async function create(input: CreatePlantInput): Promise<Plant> {
    if (!input.species_slug || input.species_slug.trim() === '') {
      throw new Error('create: species_slug is required');
    }
    const id = input.id ?? generateId();
    const added_at = Date.now();
    const is_indoor: number = input.is_indoor === false ? 0 : 1;
    // INSERT ... RETURNING returns the inserted row in a single statement,
    // so concurrent callers can't observe each other's row state between
    // write and read. SQLite has supported RETURNING since 3.35; both
    // expo-sqlite (bundled SQLite >= 3.45) and the better-sqlite3 test
    // backend ship newer.
    const row = await executor.getFirstAsync<PlantRow>(
      `INSERT INTO plants (
        id, species_slug, species_label, nickname, location, identify_confidence,
        hero_photo_id, added_at, archived_at, is_indoor, override_interval_days
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING ${SELECT_COLUMNS}`,
      [
        id,
        input.species_slug,
        input.species_label ?? null,
        input.nickname ?? null,
        input.location ?? null,
        input.identify_confidence ?? null,
        input.hero_photo_id ?? null,
        added_at,
        null, // archived_at — never set on create
        is_indoor,
        input.override_interval_days ?? null,
      ],
    );
    if (!row) {
      // Should be impossible: a successful INSERT always returns a row from
      // RETURNING. Surface loudly if it ever happens.
      throw new Error(`create: insert succeeded but RETURNING produced no row for ${id}`);
    }
    return rowToPlant(row);
  }

  async function update(id: string, patch: UpdatePlantPatch): Promise<Plant> {
    const setFragments: string[] = [];
    const params: SqlBindValue[] = [];

    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      if (!isUpdateColumn(key)) {
        // Unknown keys aren't silently dropped — that hides typos. Throw at
        // the boundary so the caller fixes the patch shape.
        throw new Error(`update: unknown patch key "${key}"`);
      }
      setFragments.push(`${key} = ?`);
      if (key === 'is_indoor') {
        params.push(value === true ? 1 : 0);
      } else {
        params.push((value as SqlBindValue) ?? null);
      }
    }

    // Use UPDATE ... RETURNING so the returned row reflects the post-update
    // state in a single atomic statement. A separate UPDATE + SELECT would
    // race against a concurrent update on the same id and return the other
    // caller's row state instead of this caller's. Codex P2 from
    // adversarial review.
    if (setFragments.length === 0) {
      // Empty patch — no-op write. Return current state via a plain SELECT.
      // No write means no race to lose; the SELECT-only path is fine.
      const current = await getById(id);
      if (!current) {
        throw new Error(`update: row ${id} not found`);
      }
      return current;
    }

    params.push(id);
    const row = await executor.getFirstAsync<PlantRow>(
      `UPDATE plants SET ${setFragments.join(', ')} WHERE id = ? RETURNING ${SELECT_COLUMNS}`,
      params,
    );
    if (!row) {
      throw new Error(`update: row ${id} not found`);
    }
    return rowToPlant(row);
  }

  async function archive(id: string): Promise<void> {
    await executor.runAsync(
      'UPDATE plants SET archived_at = ? WHERE id = ?',
      [Date.now(), id],
    );
  }

  async function unarchive(id: string): Promise<void> {
    await executor.runAsync(
      'UPDATE plants SET archived_at = NULL WHERE id = ?',
      [id],
    );
  }

  async function remove(id: string): Promise<void> {
    // Hard delete. FK CASCADE on watering_events / photos / notes /
    // diagnoses fires when `PRAGMA foreign_keys = ON` is set on the
    // connection — `openDb()` does that. The migrations test exercises the
    // CASCADE path against better-sqlite3; this hook's tests verify the same
    // against its in-memory adapter.
    await executor.runAsync('DELETE FROM plants WHERE id = ?', [id]);
  }

  return { list, getById, create, update, archive, unarchive, remove };
}

export type PlantsApi = ReturnType<typeof createPlantsApi>;

/**
 * Lazy executor wrapping `openDb()`. Each method awaits the memoized
 * connection then forwards to expo-sqlite's variadic-array form. The
 * connection is opened once per process; subsequent calls hit the cache.
 */
function createOpenDbExecutor(): PlantsExecutor {
  return {
    async runAsync(source, params) {
      const db = await openDb();
      return db.runAsync(source, params);
    },
    async getFirstAsync<T>(source: string, params: SqlBindValue[]) {
      const db = await openDb();
      return db.getFirstAsync<T>(source, params);
    },
    async getAllAsync<T>(source: string, params: SqlBindValue[]) {
      const db = await openDb();
      return db.getAllAsync<T>(source, params);
    },
  };
}

/**
 * React hook surface. Returns a stable object of CRUD callbacks. The
 * `useMemo` dep array is empty because `openDb()` is module-memoized — the
 * underlying database identity doesn't change across renders or components,
 * so there's nothing to invalidate.
 */
export function usePlants(): PlantsApi {
  return useMemo(() => createPlantsApi(createOpenDbExecutor()), []);
}
