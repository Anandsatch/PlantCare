/**
 * useMarkWatered tests (E4-006).
 *
 * Drives the pure-data API (createMarkWateredApi) against a
 * better-sqlite3-backed PlantsExecutor adapter. Same pattern as
 * usePlants.test.tsx and migrations.test.ts.
 *
 * The React hook (useMarkWatered) is exercised via renderHook for the
 * status state-machine, debounce, and unmount-safety contracts. The
 * hook's internal openDb wrapper is mocked to delegate into the same
 * better-sqlite3 adapter, so the hook tests cover the full mutate path
 * end-to-end.
 *
 * Each test resets the bus via _resetForTests() so listener state does
 * not leak between cases.
 */
import Database from 'better-sqlite3';
type DatabaseSync = Database.Database;
import { act, renderHook, waitFor } from '@testing-library/react-native';

import { runMigrations } from '../../db/migrations';
import { wateringEventsBus, type WateringBusEvent } from '../../db/wateringEvents';
import {
  createMarkWateredApi,
  MARK_WATERED_DEBOUNCE_MS,
  useMarkWatered,
} from '../useMarkWatered';
import type { PlantsExecutor, SqlBindValue } from '../usePlants';
import { createPlantsApi } from '../usePlants';

let mockActiveDb: DatabaseSync | null = null;
jest.mock('../../db/db', () => ({
  openDb: jest.fn(async () => {
    if (!mockActiveDb) {
      throw new Error('test db not initialized');
    }
    return {
      runAsync: async (sql: string, params: SqlBindValue[]) => {
        mockActiveDb!.prepare(sql).run(...params);
      },
      getFirstAsync: async <T,>(sql: string, params: SqlBindValue[]) => {
        return (mockActiveDb!.prepare(sql).get(...params) as T | undefined) ?? null;
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
      const row = db.prepare(source).get(...params) as T | undefined;
      return row ?? null;
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

async function setupDb(): Promise<{
  raw: DatabaseSync;
  api: ReturnType<typeof createMarkWateredApi>;
  plantsApi: ReturnType<typeof createPlantsApi>;
}> {
  const raw = new Database(':memory:');
  raw.pragma('foreign_keys = ON');
  await runMigrations(makeMigrationAdapter(raw));
  // Belt-and-braces no-op (see notes.test.ts setupDb for the real story —
  // v0.1.73.0 CHANGELOG. The actual flake was Jest's dual-realm Error
  // breaking `.rejects.toThrow()` on the SqliteError, not PRAGMA state.).
  raw.pragma('foreign_keys = ON');
  const adapter = makePlantsAdapter(raw);
  const api = createMarkWateredApi(adapter);
  const plantsApi = createPlantsApi(adapter);
  await plantsApi.create({
    id: 'plant-1',
    species_slug: 'monstera_deliciosa',
    species_label: 'Monstera deliciosa',
  });
  mockActiveDb = raw;
  return { raw, api, plantsApi };
}

beforeEach(() => {
  wateringEventsBus._resetForTests();
});

afterEach(() => {
  mockActiveDb = null;
});

describe('createMarkWateredApi', () => {
  it('insert writes a row with the right plant_id + watered_at + source', async () => {
    const { raw, api } = await setupDb();
    const fixedNow = 1_700_000_000_000;
    const apiNow = createMarkWateredApi(makePlantsAdapter(raw), () => fixedNow);
    const row = await apiNow.insert('plant-1', 'user');
    expect(row.plant_id).toBe('plant-1');
    expect(row.watered_at).toBe(fixedNow);
    expect(row.source).toBe('user');
    const persisted = raw
      .prepare('SELECT plant_id, watered_at, source FROM watering_events WHERE id = ?')
      .get(row.id) as { plant_id: string; watered_at: number; source: string };
    expect(persisted).toEqual({
      plant_id: 'plant-1',
      watered_at: fixedNow,
      source: 'user',
    });
  });

  it('INSERT RETURNING returns the full inserted row in one statement', async () => {
    const { api } = await setupDb();
    const row = await api.insert('plant-1', 'user');
    expect(row).toEqual({
      id: expect.any(String),
      plant_id: 'plant-1',
      watered_at: expect.any(Number),
      source: 'user',
      note: null,
    });
  });

  it('source is passed through literally at the data layer (caller picks user vs rules_confirmed)', async () => {
    const { api } = await setupDb();
    const row = await api.insert('plant-1', 'rules_confirmed');
    expect(row.source).toBe('rules_confirmed');
  });

  it('throws on FK violation when plant_id does not exist (and emits rollback)', async () => {
    const { api } = await setupDb();
    const events: WateringBusEvent[] = [];
    wateringEventsBus.subscribe((e) => events.push(e));
    // SqliteError from the native better-sqlite3 binding fails Jest's
    // cross-realm `instanceof Error` check under parallel-worker load, which
    // causes `.rejects.toThrow()` to flake with "did not throw". Catch + assert
    // on `.message` directly. (See notes.test.ts FK test + v0.1.73.0 CHANGELOG.)
    let caught: { message?: string } | undefined;
    try {
      await api.insert('does-not-exist', 'user');
    } catch (e) {
      caught = e as { message?: string };
    }
    expect(caught).toBeDefined();
    expect(caught?.message).toMatch(/FOREIGN KEY/i);
    expect(events.map((e) => e.kind)).toEqual(['optimistic', 'rollback']);
  });

  it('emits optimistic BEFORE the write resolves and commit AFTER (ordering)', async () => {
    const { api } = await setupDb();
    const events: WateringBusEvent[] = [];
    wateringEventsBus.subscribe((e) => events.push(e));
    const promise = api.insert('plant-1', 'user');
    expect(events.map((e) => e.kind)).toEqual(['optimistic']);
    await promise;
    expect(events.map((e) => e.kind)).toEqual(['optimistic', 'commit']);
  });

  it('emits optimistic with the same wateredAtMs that lands in the DB', async () => {
    const { raw } = await setupDb();
    const fixedNow = 1_700_000_001_234;
    const apiNow = createMarkWateredApi(makePlantsAdapter(raw), () => fixedNow);
    const events: WateringBusEvent[] = [];
    wateringEventsBus.subscribe((e) => events.push(e));
    const row = await apiNow.insert('plant-1', 'user');
    const optimistic = events.find((e) => e.kind === 'optimistic');
    if (optimistic?.kind !== 'optimistic') throw new Error('no optimistic event');
    expect(optimistic.wateredAtMs).toBe(fixedNow);
    expect(optimistic.wateredAtMs).toBe(row.watered_at);
  });

  it('plantId required — empty string throws before any SQL or events', async () => {
    const { api } = await setupDb();
    const events: WateringBusEvent[] = [];
    wateringEventsBus.subscribe((e) => events.push(e));
    await expect(api.insert('', 'user')).rejects.toThrow(/plantId is required/);
    expect(events).toEqual([]);
  });

  it('multiple successive inserts each land their own row', async () => {
    const { raw, api } = await setupDb();
    await api.insert('plant-1', 'user');
    await api.insert('plant-1', 'user');
    await api.insert('plant-1', 'rules_confirmed');
    const count = raw
      .prepare('SELECT COUNT(*) as c FROM watering_events WHERE plant_id = ?')
      .get('plant-1') as { c: number };
    expect(count.c).toBe(3);
  });

  it('watered_at is a UTC ms integer — no calendar math, no ISO strings', async () => {
    const { api } = await setupDb();
    const before = Date.now();
    const row = await api.insert('plant-1', 'user');
    const after = Date.now();
    expect(typeof row.watered_at).toBe('number');
    expect(Number.isInteger(row.watered_at)).toBe(true);
    expect(row.watered_at).toBeGreaterThanOrEqual(before);
    expect(row.watered_at).toBeLessThanOrEqual(after);
    expect(row.watered_at).toBeGreaterThan(1_600_000_000_000);
    expect(row.watered_at).toBeLessThan(10_000_000_000_000);
  });

  it('every row has a fresh UUID id (no collisions across rapid inserts)', async () => {
    const { api } = await setupDb();
    const ids = new Set<string>();
    for (let i = 0; i < 10; i += 1) {
      const row = await api.insert('plant-1', 'user');
      ids.add(row.id);
    }
    expect(ids.size).toBe(10);
  });
});

describe('useMarkWatered hook', () => {
  it('status transitions to ok on a successful mutate', async () => {
    await setupDb();
    const { result } = renderHook(() => useMarkWatered('plant-1'));
    expect(result.current.status).toBe('idle');
    await act(async () => {
      await result.current.mutate({ source: 'user' });
    });
    await waitFor(() => {
      expect(result.current.status).toBe('ok');
    });
  });

  it('status transitions to error on FK violation', async () => {
    await setupDb();
    const { result } = renderHook(() => useMarkWatered('does-not-exist'));
    await act(async () => {
      const r = await result.current.mutate({ source: 'user' });
      expect(r.ok).toBe(false);
      if (r.ok === false && r.kind === 'error') {
        expect(r.error).toBeInstanceOf(Error);
      }
    });
    expect(result.current.status).toBe('error');
    expect(result.current.error).toBeInstanceOf(Error);
  });

  it('mutate defaults source to "user" when called with no args', async () => {
    const { raw } = await setupDb();
    const { result } = renderHook(() => useMarkWatered('plant-1'));
    await act(async () => {
      const r = await result.current.mutate();
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.row.source).toBe('user');
      }
    });
    const sources = raw
      .prepare('SELECT source FROM watering_events WHERE plant_id = ?')
      .all('plant-1') as { source: string }[];
    expect(sources).toEqual([{ source: 'user' }]);
  });

  it('mutate preserves explicit source="rules_confirmed"', async () => {
    await setupDb();
    const { result } = renderHook(() => useMarkWatered('plant-1'));
    await act(async () => {
      const r = await result.current.mutate({ source: 'rules_confirmed' });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.row.source).toBe('rules_confirmed');
    });
  });

  it('double-tap within 1s debounces to one INSERT (second returns kind: "debounced")', async () => {
    const { raw } = await setupDb();
    const { result } = renderHook(() => useMarkWatered('plant-1'));
    let secondResult: Awaited<ReturnType<typeof result.current.mutate>> | undefined;
    await act(async () => {
      const first = result.current.mutate({ source: 'user' });
      const second = result.current.mutate({ source: 'user' });
      const [r1, r2] = await Promise.all([first, second]);
      expect(r1.ok).toBe(true);
      secondResult = r2;
    });
    expect(secondResult?.ok).toBe(false);
    if (secondResult?.ok === false) {
      expect(secondResult.kind).toBe('debounced');
    }
    const count = raw
      .prepare('SELECT COUNT(*) as c FROM watering_events WHERE plant_id = ?')
      .get('plant-1') as { c: number };
    expect(count.c).toBe(1);
  });

  it('successive mutates >1s apart both succeed (debounce window does not extend)', async () => {
    const { raw } = await setupDb();
    const { result } = renderHook(() => useMarkWatered('plant-1'));
    const realNow = Date.now;
    let t = 1_700_000_000_000;
    Date.now = jest.fn(() => t);
    try {
      await act(async () => {
        const r1 = await result.current.mutate({ source: 'user' });
        expect(r1.ok).toBe(true);
      });
      t += MARK_WATERED_DEBOUNCE_MS + 1;
      await act(async () => {
        const r2 = await result.current.mutate({ source: 'user' });
        expect(r2.ok).toBe(true);
      });
      const count = raw
        .prepare('SELECT COUNT(*) as c FROM watering_events WHERE plant_id = ?')
        .get('plant-1') as { c: number };
      expect(count.c).toBe(2);
    } finally {
      Date.now = realNow;
    }
  });

  it('emits optimistic synchronously (subscribers see it before mutate resolves)', async () => {
    await setupDb();
    const events: WateringBusEvent[] = [];
    wateringEventsBus.subscribe((e) => events.push(e));
    const { result } = renderHook(() => useMarkWatered('plant-1'));
    await act(async () => {
      const promise = result.current.mutate({ source: 'user' });
      expect(events.map((e) => e.kind)).toContain('optimistic');
      await promise;
    });
    expect(events.map((e) => e.kind)).toEqual(['optimistic', 'commit']);
  });

  it('rollback fires when the INSERT throws (FK violation), not commit', async () => {
    await setupDb();
    const events: WateringBusEvent[] = [];
    wateringEventsBus.subscribe((e) => events.push(e));
    const { result } = renderHook(() => useMarkWatered('does-not-exist'));
    await act(async () => {
      await result.current.mutate({ source: 'user' });
    });
    expect(events.map((e) => e.kind)).toEqual(['optimistic', 'rollback']);
  });

  it('mutate is referentially stable across re-renders (same plantId)', async () => {
    await setupDb();
    const { result, rerender } = renderHook(({ id }: { id: string }) =>
      useMarkWatered(id),
      { initialProps: { id: 'plant-1' } },
    );
    const first = result.current.mutate;
    rerender({ id: 'plant-1' });
    expect(result.current.mutate).toBe(first);
  });

  it('changing plantId returns a new mutate (scoped per plant)', async () => {
    await setupDb();
    const { result, rerender } = renderHook(({ id }: { id: string }) =>
      useMarkWatered(id),
      { initialProps: { id: 'plant-1' } },
    );
    const first = result.current.mutate;
    rerender({ id: 'plant-2' });
    expect(result.current.mutate).not.toBe(first);
  });

  it('successful mutate resolves with the inserted row (full shape)', async () => {
    await setupDb();
    const { result } = renderHook(() => useMarkWatered('plant-1'));
    await act(async () => {
      const r = await result.current.mutate({ source: 'user' });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.row).toEqual({
          id: expect.any(String),
          plant_id: 'plant-1',
          watered_at: expect.any(Number),
          source: 'user',
          note: null,
        });
      }
    });
  });

  it('error path can recover: a fresh mutate after an error transitions back to ok', async () => {
    const { raw, plantsApi } = await setupDb();
    void raw;
    void plantsApi;
    const { result, rerender } = renderHook(({ id }: { id: string }) =>
      useMarkWatered(id),
      { initialProps: { id: 'does-not-exist' } },
    );
    await act(async () => {
      await result.current.mutate({ source: 'user' });
    });
    expect(result.current.status).toBe('error');
    rerender({ id: 'plant-1' });
    const realNow = Date.now;
    Date.now = jest.fn(() => realNow() + MARK_WATERED_DEBOUNCE_MS + 1);
    try {
      await act(async () => {
        const r = await result.current.mutate({ source: 'user' });
        expect(r.ok).toBe(true);
      });
    } finally {
      Date.now = realNow;
    }
    expect(result.current.status).toBe('ok');
    expect(result.current.error).toBeNull();
  });

  it('regression: watered_at uses Date.now() (UTC ms), not a calendar-day floor', async () => {
    await setupDb();
    const { result } = renderHook(() => useMarkWatered('plant-1'));
    const before = Date.now();
    await act(async () => {
      const r = await result.current.mutate({ source: 'user' });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const after = Date.now();
        expect(r.row.watered_at).toBeGreaterThanOrEqual(before);
        expect(r.row.watered_at).toBeLessThanOrEqual(after);
        const midnight = new Date(
          new Date().getFullYear(),
          new Date().getMonth(),
          new Date().getDate(),
        ).getTime();
        expect(r.row.watered_at).toBeGreaterThan(midnight);
      }
    });
  });
});
