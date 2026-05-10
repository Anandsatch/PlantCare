/**
 * useLlmBudgetGate tests — E11-006.
 *
 * Coverage targets (locked semantics from the hook header):
 *   - disabled = true  iff status='ready' AND used >= 50
 *   - disabled = false on idle / loading
 *   - remaining = max(0, LIMIT - used) on ready; LIMIT on loading
 *   - refresh forwards to the underlying useLlmBudget
 *   - boundary: used=49 (approaching, NOT disabled), used=50 (disabled),
 *     used=51 (still disabled — `>=`, not `===`; codex risk #2 lock)
 *   - day-rollover: a TODAY_START boundary row drops out at midnight
 *     when the clock is advanced past TOMORROW_START on AppState resume
 *     (millisecond math, NOT calendar-day — DST/IDL survival).
 */
import { describe, expect, it, jest } from '@jest/globals';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import Database from 'better-sqlite3';
import { AppState, type AppStateStatus } from 'react-native';
type DatabaseSync = Database.Database;

import { runMigrations, type SqlExecutor } from '../../db/migrations';
import {
  LLM_BUDGET_HARD_THRESHOLD,
  LLM_BUDGET_LOW_THRESHOLD,
  LLM_DAILY_LIMIT,
  ONE_UTC_DAY_MS,
  startOfTodayUtcMs,
} from '../../lib/constants';
import { useLlmBudgetGate } from '../useLlmBudgetGate';
import type { LlmBudgetExecutor } from '../useLlmBudget';

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

function insertCalls(raw: DatabaseSync, count: number, atMs: number): void {
  const stmt = raw.prepare(
    'INSERT INTO llm_calls (endpoint, called_at_ms) VALUES (?, ?)',
  );
  for (let i = 0; i < count; i += 1) {
    stmt.run('identify', atMs + i);
  }
}

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

const NOW = 1_778_587_200_000; // 2026-05-09T12:00:00Z
const TODAY_START = startOfTodayUtcMs(NOW);
const TOMORROW_START = TODAY_START + ONE_UTC_DAY_MS;

describe('useLlmBudgetGate', () => {
  it('exposes the limit + status + used pass-through', async () => {
    const { restore } = captureAppState();
    const { raw, budgetDb } = await freshDb();
    insertCalls(raw, 7, TODAY_START + 1);

    const { result } = renderHook(() =>
      useLlmBudgetGate({ db: budgetDb, now: () => NOW }),
    );

    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });
    expect(result.current.used).toBe(7);
    expect(result.current.limit).toBe(LLM_DAILY_LIMIT);
    expect(result.current.disabled).toBe(false);
    expect(result.current.remaining).toBe(LLM_DAILY_LIMIT - 7);
    restore();
  });

  it('disabled=false while loading (default-enabled is the locked stance)', async () => {
    const { restore } = captureAppState();

    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const slow: LlmBudgetExecutor = {
      async getFirstAsync<T>(_sql: string, _params: number[]): Promise<T | null> {
        await gate;
        return { count: 99 } as T;
      },
    };

    const { result } = renderHook(() =>
      useLlmBudgetGate({ db: slow, now: () => NOW }),
    );

    await waitFor(() => {
      expect(result.current.status).toBe('loading');
    });
    expect(result.current.disabled).toBe(false);
    expect(result.current.remaining).toBe(LLM_DAILY_LIMIT);

    await act(async () => {
      release();
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });
    expect(result.current.disabled).toBe(true);
    expect(result.current.remaining).toBe(0);
    restore();
  });

  it('returns disabled=false at the LOW threshold (approaching, NOT disabled)', async () => {
    const { restore } = captureAppState();
    const { raw, budgetDb } = await freshDb();
    insertCalls(raw, LLM_BUDGET_LOW_THRESHOLD, TODAY_START + 1);

    const { result } = renderHook(() =>
      useLlmBudgetGate({ db: budgetDb, now: () => NOW }),
    );

    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });
    expect(result.current.used).toBe(LLM_BUDGET_LOW_THRESHOLD);
    expect(result.current.disabled).toBe(false);
    expect(result.current.remaining).toBe(
      LLM_DAILY_LIMIT - LLM_BUDGET_LOW_THRESHOLD,
    );
    restore();
  });

  it('returns disabled=false at used = HARD - 1 (49) — last call before gate', async () => {
    const { restore } = captureAppState();
    const { raw, budgetDb } = await freshDb();
    insertCalls(raw, LLM_BUDGET_HARD_THRESHOLD - 1, TODAY_START + 1);

    const { result } = renderHook(() =>
      useLlmBudgetGate({ db: budgetDb, now: () => NOW }),
    );

    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });
    expect(result.current.disabled).toBe(false);
    expect(result.current.remaining).toBe(1);
    restore();
  });

  it('returns disabled=true at the HARD threshold (50)', async () => {
    const { restore } = captureAppState();
    const { raw, budgetDb } = await freshDb();
    insertCalls(raw, LLM_BUDGET_HARD_THRESHOLD, TODAY_START + 1);

    const { result } = renderHook(() =>
      useLlmBudgetGate({ db: budgetDb, now: () => NOW }),
    );

    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });
    expect(result.current.disabled).toBe(true);
    expect(result.current.remaining).toBe(0);
    restore();
  });

  it('returns disabled=true at HARD + 1 (51) — `>=` not `===` lock', async () => {
    const { restore } = captureAppState();
    const { raw, budgetDb } = await freshDb();
    insertCalls(raw, LLM_BUDGET_HARD_THRESHOLD + 1, TODAY_START + 1);

    const { result } = renderHook(() =>
      useLlmBudgetGate({ db: budgetDb, now: () => NOW }),
    );

    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });
    expect(result.current.disabled).toBe(true);
    expect(result.current.remaining).toBe(0);
    restore();
  });

  it('refresh forwards to useLlmBudget and re-queries the count', async () => {
    const { restore } = captureAppState();
    const { raw, budgetDb } = await freshDb();
    insertCalls(raw, 10, TODAY_START + 1);

    const { result } = renderHook(() =>
      useLlmBudgetGate({ db: budgetDb, now: () => NOW }),
    );

    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });
    expect(result.current.used).toBe(10);

    insertCalls(raw, 5, TODAY_START + 2_000);
    expect(result.current.used).toBe(10);

    await act(async () => {
      result.current.refresh();
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(result.current.used).toBe(15);
    });
    restore();
  });

  it('day-rollover: count drops to 0 when the clock advances past midnight UTC', async () => {
    const { listeners, restore } = captureAppState();
    const { raw, budgetDb } = await freshDb();

    insertCalls(raw, LLM_BUDGET_HARD_THRESHOLD, TODAY_START + 1);

    let now = NOW;
    const { result } = renderHook(() =>
      useLlmBudgetGate({ db: budgetDb, now: () => now }),
    );

    await waitFor(() => {
      expect(result.current.disabled).toBe(true);
    });

    now = TOMORROW_START + 12 * 60 * 60_000;
    expect(listeners.length).toBeGreaterThan(0);
    await act(async () => {
      for (const listener of listeners) {
        listener('active');
      }
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(result.current.used).toBe(0);
    });
    expect(result.current.disabled).toBe(false);
    expect(result.current.remaining).toBe(LLM_DAILY_LIMIT);
    restore();
  });

  it('uses millisecond math, NOT calendar-day math (DST/IDL survival lock)', async () => {
    const { restore } = captureAppState();
    const { raw, budgetDb } = await freshDb();

    insertCalls(raw, 1, TODAY_START); // exact boundary — INCLUDED today
    insertCalls(raw, 1, TODAY_START - 1); // 1ms before today — EXCLUDED

    const { result } = renderHook(() =>
      useLlmBudgetGate({ db: budgetDb, now: () => NOW }),
    );

    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });
    expect(result.current.used).toBe(1);
    restore();
  });
});
