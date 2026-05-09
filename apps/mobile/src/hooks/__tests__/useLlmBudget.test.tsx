/**
 * useLlmBudget tests (E11-005).
 *
 * Drive the hook against a real in-memory SQLite (better-sqlite3) so the
 * UTC-day math + COUNT predicate are exercised end-to-end. The fake
 * AppState capture mirrors the pattern from `useFailedQueue.test.tsx`.
 */
import { describe, expect, it, jest } from '@jest/globals';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import Database from 'better-sqlite3';
import { AppState, type AppStateStatus } from 'react-native';
type DatabaseSync = Database.Database;

import { runMigrations, type SqlExecutor } from '../../db/migrations';
import { LLM_DAILY_LIMIT, ONE_UTC_DAY_MS, startOfTodayUtcMs } from '../../lib/constants';
import { useLlmBudget, type LlmBudgetExecutor } from '../useLlmBudget';

// ─── Adapters ───────────────────────────────────────────────────────────

function makeMigrationAdapter(db: DatabaseSync): SqlExecutor {
  return {
    async execAsync(source: string) {
      db.exec(source);
    },
    async getFirstAsync<T>(source: string): Promise<T | null> {
      const r = db.prepare(source).get() as T | undefined;
      return r ?? null;
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

function makeBudgetExecutor(db: DatabaseSync): LlmBudgetExecutor {
  return {
    async getFirstAsync<T>(source: string, params: number[]): Promise<T | null> {
      const r = db.prepare(source).get(...params) as T | undefined;
      return r ?? null;
    },
  };
}

async function freshDb(): Promise<{ raw: DatabaseSync; budgetDb: LlmBudgetExecutor }> {
  const raw = new Database(':memory:');
  raw.exec('PRAGMA foreign_keys = ON');
  await runMigrations(makeMigrationAdapter(raw));
  return { raw, budgetDb: makeBudgetExecutor(raw) };
}

function insertCall(raw: DatabaseSync, endpoint: string, calledAtMs: number): void {
  raw
    .prepare('INSERT INTO llm_calls (endpoint, called_at_ms) VALUES (?, ?)')
    .run(endpoint, calledAtMs);
}

// AppState capture — same pattern as useFailedQueue.test.tsx.
type AppStateListener = (next: AppStateStatus) => void;

function captureAppState(): { listeners: AppStateListener[]; restore: () => void } {
  const listeners: AppStateListener[] = [];
  const spy = jest
    .spyOn(AppState, 'addEventListener')
    .mockImplementation(((event: string, listener: AppStateListener) => {
      if (event === 'change') {
        listeners.push(listener);
      }
      return {
        remove: () => {
          const idx = listeners.indexOf(listener);
          if (idx >= 0) listeners.splice(idx, 1);
        },
      };
    }) as never);
  return {
    listeners,
    restore: () => {
      spy.mockRestore();
    },
  };
}

// ─── Test fixtures ───────────────────────────────────────────────────────

// Fixed "now" inside a tidy UTC day (2026-05-09T12:00:00Z).
const NOW = 1_778_587_200_000;
const TODAY_START = startOfTodayUtcMs(NOW);
const YESTERDAY_START = TODAY_START - ONE_UTC_DAY_MS;
const TOMORROW_START = TODAY_START + ONE_UTC_DAY_MS;

// ─── Tests ──────────────────────────────────────────────────────────────

describe('useLlmBudget', () => {
  it('exposes LLM_DAILY_LIMIT (50) as the limit', async () => {
    const { restore } = captureAppState();
    const { budgetDb } = await freshDb();

    const { result } = renderHook(() =>
      useLlmBudget({ db: budgetDb, now: () => NOW }),
    );
    expect(result.current.limit).toBe(LLM_DAILY_LIMIT);
    expect(result.current.limit).toBe(50);
    restore();
  });

  it('counts only rows whose called_at_ms >= start of today UTC', async () => {
    const { restore } = captureAppState();
    const { raw, budgetDb } = await freshDb();

    insertCall(raw, 'identify', YESTERDAY_START + 60_000); // before today
    insertCall(raw, 'diagnose', TODAY_START); // exact boundary — INCLUDED
    insertCall(raw, 'consult', TODAY_START + 1); // later today
    insertCall(raw, 'review', NOW); // later today

    const { result } = renderHook(() =>
      useLlmBudget({ db: budgetDb, now: () => NOW }),
    );

    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });
    expect(result.current.used).toBe(3);
    restore();
  });

  it('does NOT count rows whose called_at_ms is < TODAY_START even by 1ms', async () => {
    const { restore } = captureAppState();
    const { raw, budgetDb } = await freshDb();

    insertCall(raw, 'identify', TODAY_START - 1);
    insertCall(raw, 'identify', TODAY_START);

    const { result } = renderHook(() =>
      useLlmBudget({ db: budgetDb, now: () => NOW }),
    );

    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });
    expect(result.current.used).toBe(1);
    restore();
  });

  it('returns used=0 ready when the table is empty', async () => {
    const { restore } = captureAppState();
    const { budgetDb } = await freshDb();

    const { result } = renderHook(() =>
      useLlmBudget({ db: budgetDb, now: () => NOW }),
    );

    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });
    expect(result.current.used).toBe(0);
    restore();
  });

  it('flips status idle -> loading -> ready as the first read resolves', async () => {
    const { restore } = captureAppState();
    const { raw, budgetDb } = await freshDb();
    insertCall(raw, 'diagnose', TODAY_START + 1);

    // Hold the first read open and observe the loading state.
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const slow: LlmBudgetExecutor = {
      async getFirstAsync(sql, params) {
        await gate;
        return budgetDb.getFirstAsync(sql, params);
      },
    };

    const { result } = renderHook(() => useLlmBudget({ db: slow, now: () => NOW }));

    await waitFor(() => {
      expect(result.current.status).toBe('loading');
    });
    expect(result.current.used).toBe(0);

    await act(async () => {
      release();
    });
    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });
    expect(result.current.used).toBe(1);
    restore();
  });

  it('rolls over at UTC midnight via AppState active (no remount needed)', async () => {
    const { listeners, restore } = captureAppState();
    const { raw, budgetDb } = await freshDb();

    // Two rows at "yesterday" and "today" relative to the initial NOW.
    // After AppState 'active' fires with `nowValue` advanced past
    // midnight, the new TODAY_START becomes TOMORROW_START (relative to
    // the original NOW), and BOTH rows now sit in yesterday/old-day
    // territory and drop out of the count. We then add a row in the
    // new day window and assert the count flips to 1.
    insertCall(raw, 'identify', YESTERDAY_START + 60_000);
    insertCall(raw, 'consult', TODAY_START + 60_000);

    let nowValue = NOW;
    const { result } = renderHook(() =>
      useLlmBudget({ db: budgetDb, now: () => nowValue }),
    );

    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });
    // Initial window [TODAY_START, ∞): the YESTERDAY row drops out, the
    // TODAY row counts.
    expect(result.current.used).toBe(1);

    // Advance past UTC midnight. New window: [TOMORROW_START, ∞). Both
    // existing rows are now BEFORE the new boundary and drop out.
    nowValue = TOMORROW_START + 1;
    await act(async () => {
      listeners.forEach((l) => l('active'));
    });
    await waitFor(() => {
      expect(result.current.used).toBe(0);
    });

    // Insert a row in the new day window — count flips to 1.
    insertCall(raw, 'review', TOMORROW_START + 120_000);
    await act(async () => {
      listeners.forEach((l) => l('active'));
    });
    await waitFor(() => {
      expect(result.current.used).toBe(1);
    });
    restore();
  });

  it('AppState active triggers refresh; non-active transitions do not', async () => {
    const { listeners, restore } = captureAppState();
    const { raw, budgetDb } = await freshDb();

    let calls = 0;
    const counting: LlmBudgetExecutor = {
      async getFirstAsync(sql, params) {
        calls += 1;
        return budgetDb.getFirstAsync(sql, params);
      },
    };

    const { result } = renderHook(() => useLlmBudget({ db: counting, now: () => NOW }));
    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });
    const initial = calls;
    expect(initial).toBeGreaterThanOrEqual(1);

    await act(async () => {
      listeners.forEach((l) => l('background' as AppStateStatus));
      listeners.forEach((l) => l('inactive' as AppStateStatus));
    });
    expect(calls).toBe(initial);

    insertCall(raw, 'identify', TODAY_START + 1);

    await act(async () => {
      listeners.forEach((l) => l('active'));
    });
    await waitFor(() => {
      expect(result.current.used).toBe(1);
    });
    expect(calls).toBeGreaterThan(initial);
    restore();
  });

  it('manual refresh re-queries and updates used in place; status stays ready', async () => {
    const { restore } = captureAppState();
    const { raw, budgetDb } = await freshDb();

    const { result } = renderHook(() =>
      useLlmBudget({ db: budgetDb, now: () => NOW }),
    );
    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });
    expect(result.current.used).toBe(0);

    insertCall(raw, 'consult', TODAY_START + 1);
    await act(async () => {
      result.current.refresh();
    });
    await waitFor(() => {
      expect(result.current.used).toBe(1);
    });
    expect(result.current.status).toBe('ready');
    restore();
  });

  it('drops a stale older refresh that resolves after a newer refresh', async () => {
    const { restore } = captureAppState();
    const { raw, budgetDb } = await freshDb();

    insertCall(raw, 'identify', TODAY_START + 1);

    // Each getFirstAsync call gets its own gate. We resolve them in a
    // controlled (out-of-order) sequence to drive the race the
    // call-counter ref guards against.
    const gates: Array<{ release: () => void; promise: Promise<void> }> = [];
    function makeGate() {
      let release!: () => void;
      const promise = new Promise<void>((r) => {
        release = r;
      });
      const g = { release, promise };
      gates.push(g);
      return g;
    }
    const ordered: LlmBudgetExecutor = {
      async getFirstAsync(sql, params) {
        const g = makeGate();
        await g.promise;
        return budgetDb.getFirstAsync(sql, params);
      },
    };

    const { result } = renderHook(() => useLlmBudget({ db: ordered, now: () => NOW }));
    // Trigger a second refresh while the mount-effect's first read is still gated.
    await act(async () => {
      result.current.refresh();
    });

    // Now there must be at least 2 gates (the mount read + the manual
    // refresh). The mount effect under StrictMode may double-mount in
    // dev, but the cleanup bumps callCounterRef so any earlier reads
    // are already invalidated. We resolve the LAST gate first (newest
    // started call) and the FIRST gate last (oldest stale call).
    expect(gates.length).toBeGreaterThanOrEqual(2);

    insertCall(raw, 'diagnose', TODAY_START + 2);

    // Resolve in REVERSE order: newest first (commits count=2), then
    // older ones (must be dropped by the stale-call guard).
    await act(async () => {
      gates[gates.length - 1].release();
      await Promise.resolve();
    });
    for (let i = gates.length - 2; i >= 0; i -= 1) {
      const j = i;
      await act(async () => {
        gates[j].release();
      });
    }

    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });
    expect(result.current.used).toBe(2);
    restore();
  });

  it('coerces a bigint count cell (Android edge case) into a finite number', async () => {
    const { restore } = captureAppState();
    const bigIntDb: LlmBudgetExecutor = {
      async getFirstAsync<T>() {
        return ({ count: 7n } as unknown) as T;
      },
    };

    const { result } = renderHook(() =>
      useLlmBudget({ db: bigIntDb, now: () => NOW }),
    );
    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });
    expect(result.current.used).toBe(7);
    restore();
  });

  it('keeps status at loading and used at 0 when the count cell is unparseable (NaN)', async () => {
    const { restore } = captureAppState();
    const nanDb: LlmBudgetExecutor = {
      async getFirstAsync<T>() {
        return ({ count: Number.NaN } as unknown) as T;
      },
    };

    const { result } = renderHook(() =>
      useLlmBudget({ db: nanDb, now: () => NOW }),
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.status).toBe('loading');
    expect(result.current.used).toBe(0);
    restore();
  });

  it('survives an executor throw on first read; a follow-up refresh succeeds', async () => {
    const { restore } = captureAppState();
    const { raw, budgetDb } = await freshDb();
    insertCall(raw, 'review', TODAY_START + 1);

    // Throw on every call until we flip the gate. React 18+ StrictMode
    // double-mount in dev means the mount-effect's first refresh may
    // fire twice; both should observe the throw, leaving status at
    // 'loading' (no phantom 'ready'). We then flip the gate and call
    // refresh manually; that one succeeds.
    let throwGate = true;
    const flaky: LlmBudgetExecutor = {
      async getFirstAsync(sql, params) {
        if (throwGate) {
          throw new Error('db boom');
        }
        return budgetDb.getFirstAsync(sql, params);
      },
    };

    const { result } = renderHook(() => useLlmBudget({ db: flaky, now: () => NOW }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.status).toBe('loading');
    expect(result.current.used).toBe(0);

    throwGate = false;
    await act(async () => {
      result.current.refresh();
    });
    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });
    expect(result.current.used).toBe(1);
    restore();
  });

  it('does not re-run the read on a parent re-render that swaps inline db/now identities (codex P3)', async () => {
    const { restore } = captureAppState();
    const { budgetDb } = await freshDb();

    let calls = 0;
    const counting: LlmBudgetExecutor = {
      async getFirstAsync(sql, params) {
        calls += 1;
        return budgetDb.getFirstAsync(sql, params);
      },
    };

    // Use rerender + a fresh inline closure each time to simulate the
    // PlantsListScreen passing `() => openDb()` and `() => nowMs` from
    // a re-render. Without ref-stabilization the hook would re-issue
    // the COUNT on every parent render.
    const { result, rerender } = renderHook(
      () =>
        useLlmBudget({
          db: counting,
          now: () => NOW,
        }),
    );

    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });
    const initialCalls = calls;
    expect(initialCalls).toBeGreaterThanOrEqual(1);

    // Re-render with new inline closures — same effective values.
    rerender({});
    rerender({});
    rerender({});

    await act(async () => {
      await Promise.resolve();
    });

    // The COUNT must NOT re-fire on these unrelated re-renders.
    expect(calls).toBe(initialCalls);
    restore();
  });

  it('accepts a factory db (() => Promise<Executor>) and resolves it once', async () => {
    const { restore } = captureAppState();
    const { budgetDb } = await freshDb();

    let resolveCount = 0;
    const factory = async () => {
      resolveCount += 1;
      return budgetDb;
    };

    const { result } = renderHook(() => useLlmBudget({ db: factory, now: () => NOW }));
    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });

    await act(async () => {
      result.current.refresh();
    });
    await act(async () => {
      result.current.refresh();
    });

    expect(resolveCount).toBe(1);
    restore();
  });
});
