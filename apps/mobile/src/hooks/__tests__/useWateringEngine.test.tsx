/**
 * useWateringEngine bus-subscription tests (E4-006).
 *
 * The hook performs a SQLite read for the most recent watering_events row
 * and subscribes to wateringEventsBus. When an `optimistic` event arrives,
 * the hook flips its derived status synchronously without waiting for a
 * SQLite re-read. When `commit` or `rollback` arrives, the hook re-reads
 * for the canonical state.
 */
import { act, renderHook, waitFor } from '@testing-library/react-native';
import Database from 'better-sqlite3';
type DatabaseSync = Database.Database;

import { runMigrations } from '../../db/migrations';
import { wateringEventsBus } from '../../db/wateringEvents';
import { createPlantsApi } from '../usePlants';
import type { PlantsExecutor, SqlBindValue } from '../usePlants';
import { useWateringEngine } from '../useWateringEngine';

let mockActiveDb: DatabaseSync | null = null;
jest.mock('../../db/db', () => ({
  openDb: jest.fn(async () => {
    if (!mockActiveDb) throw new Error('test db not initialized');
    return {
      runAsync: async (sql: string, params: SqlBindValue[]) => {
        mockActiveDb!.prepare(sql).run(...params);
      },
      getFirstAsync: async <T,>(sql: string, params: SqlBindValue[] | SqlBindValue) => {
        const arr = Array.isArray(params) ? params : [params];
        return (mockActiveDb!.prepare(sql).get(...arr) as T | undefined) ?? null;
      },
      getAllAsync: async <T,>(sql: string, params: SqlBindValue[]) => {
        return mockActiveDb!.prepare(sql).all(...params) as T[];
      },
    };
  }),
}));

function makePlantsAdapter(db: DatabaseSync): PlantsExecutor {
  return {
    async runAsync(source: string, params: SqlBindValue[]) {
      db.prepare(source).run(...params);
    },
    async getFirstAsync<T>(source: string, params: SqlBindValue[]): Promise<T | null> {
      return (db.prepare(source).get(...params) as T | undefined) ?? null;
    },
    async getAllAsync<T>(source: string, params: SqlBindValue[]): Promise<T[]> {
      return db.prepare(source).all(...params) as T[];
    },
  };
}

function makeMigrationAdapter(db: DatabaseSync) {
  return {
    async execAsync(source: string) {
      db.exec(source);
    },
    async getFirstAsync<T>(source: string): Promise<T | null> {
      return (db.prepare(source).get() as T | undefined) ?? null;
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

async function setup(): Promise<{ raw: DatabaseSync }> {
  const raw = new Database(':memory:');
  raw.exec('PRAGMA foreign_keys = ON');
  await runMigrations(makeMigrationAdapter(raw));
  const adapter = makePlantsAdapter(raw);
  const plantsApi = createPlantsApi(adapter);
  await plantsApi.create({
    id: 'plant-1',
    species_slug: 'monstera_deliciosa',
    species_label: 'Monstera deliciosa',
  });
  mockActiveDb = raw;
  return { raw };
}

beforeEach(() => {
  wateringEventsBus._resetForTests();
});

afterEach(() => {
  mockActiveDb = null;
});

describe('useWateringEngine bus subscription', () => {
  it('returns "check_soil" before the initial SQLite read resolves', () => {
    void setup();
    const { result } = renderHook(() =>
      useWateringEngine({
        id: 'plant-1',
        species_slug: 'monstera_deliciosa',
        override_interval_days: null,
      }),
    );
    expect(result.current).toBe('check_soil');
  });

  it('re-derives after an optimistic event without a SQLite re-read', async () => {
    await setup();
    const { result } = renderHook(() =>
      useWateringEngine({
        id: 'plant-1',
        species_slug: 'monstera_deliciosa',
        override_interval_days: null,
      }),
    );
    await waitFor(() => {
      expect(result.current).toBe('check_soil');
    });
    act(() => {
      wateringEventsBus.emitOptimistic('plant-1', Date.now());
    });
    expect(result.current).toBe('skip');
  });

  it('ignores events for a different plantId', async () => {
    await setup();
    const { result } = renderHook(() =>
      useWateringEngine({
        id: 'plant-1',
        species_slug: 'monstera_deliciosa',
        override_interval_days: null,
      }),
    );
    await waitFor(() => {
      expect(result.current).toBe('check_soil');
    });
    act(() => {
      wateringEventsBus.emitOptimistic('plant-2', Date.now());
    });
    expect(result.current).toBe('check_soil');
  });

  it('on commit, re-reads SQLite for the canonical state', async () => {
    const { raw } = await setup();
    const { result } = renderHook(() =>
      useWateringEngine({
        id: 'plant-1',
        species_slug: 'monstera_deliciosa',
        override_interval_days: null,
      }),
    );
    await waitFor(() => {
      expect(result.current).toBe('check_soil');
    });
    raw.prepare(
      "INSERT INTO watering_events (id, plant_id, watered_at, source) VALUES ('w1', 'plant-1', ?, 'user')",
    ).run(Date.now());
    await act(async () => {
      wateringEventsBus.emitCommit('plant-1');
    });
    await waitFor(() => {
      expect(result.current).toBe('skip');
    });
  });

  it('on rollback, re-reads SQLite (returns to pre-mutation state)', async () => {
    const { raw } = await setup();
    void raw;
    const { result } = renderHook(() =>
      useWateringEngine({
        id: 'plant-1',
        species_slug: 'monstera_deliciosa',
        override_interval_days: null,
      }),
    );
    await waitFor(() => {
      expect(result.current).toBe('check_soil');
    });
    act(() => {
      wateringEventsBus.emitOptimistic('plant-1', Date.now());
    });
    expect(result.current).toBe('skip');
    await act(async () => {
      wateringEventsBus.emitRollback('plant-1');
    });
    await waitFor(() => {
      expect(result.current).toBe('check_soil');
    });
  });

  it('unsubscribes on unmount (no leaks across hook lifetimes)', async () => {
    await setup();
    const { result, unmount } = renderHook(() =>
      useWateringEngine({
        id: 'plant-1',
        species_slug: 'monstera_deliciosa',
        override_interval_days: null,
      }),
    );
    await waitFor(() => {
      expect(result.current).toBe('check_soil');
    });
    unmount();
    expect(() => {
      wateringEventsBus.emitOptimistic('plant-1', Date.now());
    }).not.toThrow();
  });
});
