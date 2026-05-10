/**
 * `useLlmBudget()` — surfaces the daily LLM-call counter that backs the
 * Plants list header meter ("37/50 TODAY") and, in a follow-up ticket
 * (E11-006), the 40+/50+ banner + button-disabling.
 *
 * # Why client-side, not /api/budget
 *
 * The master plan + WORKBACK.md cross-cutting note (line 590) lock the
 * V1 budget to a client-side SQLite counter. There is NO `/api/budget`
 * endpoint and NO KV-backed budget. The hook reads `COUNT(*)` from the
 * `llm_calls` table for rows whose `called_at_ms >= startOfTodayUtcMs(now)`.
 * The `limit` is a constant (`LLM_DAILY_LIMIT = 50`) sourced from
 * `lib/constants.ts`.
 *
 * # Surface (locked)
 *
 *   const { used, limit, status, refresh } = useLlmBudget({ db });
 *
 *   - `used`     — count of `llm_calls` rows in the current UTC day.
 *                  Only meaningful when `status === 'ready'`. While
 *                  `status` is `'idle'` or `'loading'` the value is `0`
 *                  but the UI MUST NOT render "0/50" — it would falsely
 *                  advertise zero usage when the read is still in flight.
 *                  The PlantsList header gates rendering on
 *                  `status === 'ready'` for exactly this reason.
 *   - `limit`    — `LLM_DAILY_LIMIT` (`50`). Re-exported through the hook
 *                  so consumers don't need to import the constant
 *                  separately to render the meter copy.
 *   - `status`   — 'idle' | 'loading' | 'ready'. Lifecycle:
 *                    idle    — pre-mount initial value (one render only).
 *                    loading — first read in flight.
 *                    ready   — at least one read has resolved; subsequent
 *                              refreshes update `used` in place, status
 *                              stays at 'ready' (no flicker back to
 *                              'loading' on AppState resume — the
 *                              previously-rendered meter stays visible
 *                              while the new count flushes).
 *   - `refresh()`— re-query the count. Idempotent; setState only fires
 *                  if the count actually changed (skips re-renders on
 *                  steady-state AppState resumes). Async but the caller
 *                  rarely needs to await.
 *
 * # AppState resume → automatic refresh
 *
 * The hook subscribes to `AppState` and re-queries on a transition to
 * `'active'`. This covers the "user backgrounded the app at 11:55pm UTC,
 * came back at 12:05am UTC" rollover case — without it, the meter would
 * display yesterday's count until the next manual interaction. Same
 * pattern as `useFailedQueue` (E7-006) and `<PlantsListScreen>`.
 *
 * # Race semantics
 *
 * Same call-counter pattern as `useWeather` and `<PlantsListScreen>`:
 * a `callCounterRef` tags each refresh; a stale resolution that arrives
 * after a newer refresh has started is dropped. Comparing against the
 * latest STARTED call (not the latest committed one) — that closes the
 * brief render-window where a stale count would commit and then be
 * overwritten on the next resolution. This is the codex catch from
 * E6-005's useWeather review and it applies identically here.
 *
 * # Unmount safety
 *
 * `mountedRef` guards setState after unmount. React 18 logs a warning
 * rather than throwing, but the warning is correct and we close the gap.
 *
 * # UTC-day math (NOT calendar walking)
 *
 * `startOfTodayUtcMs(now)` is the floor-divide-by-86_400_000 form. NO
 * date-fns / dayjs / luxon / Temporal — UTC ms only. Same project-wide
 * lock as the watering engine's E4-002 critical regression.
 *
 * # V1 scope locks honored here
 *
 *   - DO NOT call `/api/budget`. There is no such endpoint in V1.
 *   - DO NOT add KV-backed budget. Master plan locks budget to client-
 *     side SQLite.
 *   - DO NOT add date-fns / dayjs / luxon / Temporal. UTC ms only.
 *   - DO NOT add an ORM.
 *   - DO NOT wire any insertion path here. This file ships the read +
 *     surface only. Insertion (`recordLlmCall(endpoint)` from
 *     `useDiagnoseRequest` etc.) is E11-006. Tests insert rows directly
 *     via the schema layer.
 *   - DO NOT add the 40+/50+ banner here. That's E11-006.
 *   - DO NOT add a "reset for the day" surface — the count rolls over
 *     by virtue of the UTC-floor predicate.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, type AppStateStatus } from 'react-native';

import { LLM_DAILY_LIMIT, startOfTodayUtcMs } from '../lib/constants';

/**
 * Subset of `expo-sqlite`'s `SQLiteDatabase` that the hook needs. Mirrors
 * the executor pattern used elsewhere in the project (`PlantsExecutor`,
 * `NotesExecutor`, `QueueExecutor`) so tests can inject a better-sqlite3-
 * backed adapter without booting jest-expo's RN env.
 *
 * The hook only ever runs a single read query — `getFirstAsync<{ count }>`
 * with one numeric parameter — so the executor surface is intentionally
 * narrower than the CRUD executors.
 */
export interface LlmBudgetExecutor {
  getFirstAsync<T>(source: string, params: number[]): Promise<T | null>;
}

export type UseLlmBudgetStatus = 'idle' | 'loading' | 'ready';

export interface UseLlmBudgetConfig {
  /**
   * The SQLite executor. Required at the call site so the hook never
   * reaches into a singleton — same DI shape as the rest of the project.
   * Production: pass `await openDb()` (or wrap it). Tests: pass a
   * better-sqlite3-backed adapter.
   */
  db: LlmBudgetExecutor | (() => Promise<LlmBudgetExecutor>);
  /**
   * Override clock for tests. Defaults to `Date.now`. The hook reads the
   * clock once per refresh and rounds to the start of the UTC day; tests
   * can pin a fixed `now` to assert rollover boundaries deterministically.
   */
  now?: () => number;
}

export interface UseLlmBudgetReturn {
  used: number;
  limit: number;
  status: UseLlmBudgetStatus;
  refresh: () => void;
}

/**
 * Row shape returned by the `COUNT(*)` query. SQLite always returns the
 * count as `count` when aliased; better-sqlite3 + expo-sqlite agree on
 * the shape. The aggregate cell is widened to `unknown` here because
 * better-sqlite3 returns it as a number while expo-sqlite returns it as
 * `number | bigint` on some Android builds (the bigint path activates
 * for COUNTs above 2^31; we won't hit it at 50/day, but the type lock
 * keeps the validator honest).
 */
interface CountRow {
  count: unknown;
}

/**
 * Coerce the COUNT cell into a finite non-negative integer. Defensive
 * against:
 *   - `null` from a missing-row driver (shouldn't happen for COUNT — it
 *     always returns one row even on an empty table — but documented
 *     for the rare expo-sqlite edge case where a re-opened connection
 *     pre-migration hits an empty cell).
 *   - `bigint` from Android builds with the BigInt-flag set on the
 *     native module. We're well below 2^53 so the `Number()` conversion
 *     is lossless at our scale.
 *   - `NaN` / `Infinity` smuggled through a future schema mistake.
 *     `typeof NaN === 'number'` returns true so we MUST use
 *     `Number.isFinite`, not `typeof === 'number'`. Same defensive
 *     pattern as `useWeather`'s `isValidDailyEntry` (codex P2 from
 *     E6-005).
 *
 * Returns `null` when the cell is unparseable; the caller treats `null`
 * as "leave status at 'loading'" so the meter never shows a phantom
 * value.
 */
function coerceCount(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'bigint') {
    // Lossless at our scale; clamp to non-negative.
    const asNum = Number(raw);
    return Number.isFinite(asNum) && asNum >= 0 ? Math.floor(asNum) : null;
  }
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) {
    return null;
  }
  return Math.floor(raw);
}

/**
 * Resolve the executor — accepts either a ready instance or a factory.
 * The factory form lets the screen pass `() => openDb()` so the
 * connection lazily initializes on first refresh, rather than blocking
 * the screen mount on the await.
 */
async function resolveExecutor(
  db: LlmBudgetExecutor | (() => Promise<LlmBudgetExecutor>),
): Promise<LlmBudgetExecutor> {
  if (typeof db === 'function') {
    return db();
  }
  return db;
}

/** SQL is a constant — no string interpolation, parameter is bound. */
const COUNT_SQL =
  'SELECT COUNT(*) AS count FROM llm_calls WHERE called_at_ms >= ?';

export function useLlmBudget(config: UseLlmBudgetConfig): UseLlmBudgetReturn {
  const { db, now = Date.now } = config;

  const [used, setUsed] = useState(0);
  const [status, setStatus] = useState<UseLlmBudgetStatus>('idle');

  const mountedRef = useRef(true);
  // Monotonic counter — see file header. Tags each refresh so a stale
  // resolution can't commit after a newer refresh has started.
  const callCounterRef = useRef(0);
  // Last-committed value, used to skip setState when an AppState resume
  // refresh resolves to the same count (steady state — no re-render).
  const lastCommittedRef = useRef<number | null>(null);

  // Cache the resolved executor across refreshes so a factory form
  // (`() => openDb()`) doesn't pay the resolve cost on every refresh.
  // Holds a Promise so concurrent first-refreshes share one resolve.
  const executorPromiseRef = useRef<Promise<LlmBudgetExecutor> | null>(null);

  // Latest-config refs. Callers commonly pass inline functions for `db`
  // (`() => openDb()`) and `now` — those allocate a new identity on
  // every render. Routing them through refs means `refresh` (and the
  // mount + AppState effects that depend on it) stay referentially
  // stable across re-renders, so we don't re-subscribe to AppState
  // every render and we don't kick off duplicate refreshes when the
  // parent re-renders for an unrelated reason. Codex P3 from review.
  const dbRef = useRef(db);
  const nowRef = useRef(now);
  useEffect(() => {
    // If the caller swaps the db identity (e.g. test seam → production),
    // drop the cached executor so the next refresh resolves fresh.
    if (dbRef.current !== db) {
      executorPromiseRef.current = null;
      dbRef.current = db;
    }
    nowRef.current = now;
  }, [db, now]);

  const refresh = useCallback((): void => {
    const callId = ++callCounterRef.current;

    // Only flip to 'loading' on the very first read. Subsequent reads
    // (AppState resume, manual refresh, etc.) keep the previously-
    // rendered meter visible while the new count flushes — no flicker.
    if (mountedRef.current && lastCommittedRef.current === null) {
      setStatus('loading');
    }

    void (async () => {
      try {
        if (executorPromiseRef.current === null) {
          executorPromiseRef.current = resolveExecutor(dbRef.current);
        }
        const executor = await executorPromiseRef.current;
        const todayStart = startOfTodayUtcMs(nowRef.current());
        const row = await executor.getFirstAsync<CountRow>(COUNT_SQL, [
          todayStart,
        ]);

        // Stale-call guard: if a newer refresh has started since this one
        // was issued, drop our result silently.
        if (callId !== callCounterRef.current) return;
        if (!mountedRef.current) return;

        const next = coerceCount(row?.count);
        if (next === null) {
          // Unparseable cell — leave the meter in its previous state
          // rather than committing a phantom value. If we never had a
          // committed value, status stays at 'loading' so the UI keeps
          // the null-state branch (no "0/50" lie).
          return;
        }

        if (lastCommittedRef.current === next) {
          // Steady state — same count as last commit. Still flip status
          // to 'ready' if it hasn't been already (covers the rare case
          // where the very first read returns 0 and the cached
          // lastCommittedRef matches; the initial null sentinel ensures
          // this branch only fires on subsequent reads).
          if (mountedRef.current) {
            setStatus('ready');
          }
          return;
        }

        lastCommittedRef.current = next;
        setUsed(next);
        setStatus('ready');
      } catch {
        // Read failure: keep the previously-rendered meter visible if
        // we had one; otherwise leave the UI in its null-state branch.
        // We deliberately do NOT bubble the error — the meter is a
        // dashboard surface, not a load-bearing path. If we never had
        // a committed read, drop the executor cache so the next refresh
        // attempts a fresh resolve (covers the openDb-failed-on-mount
        // case where a retry would succeed).
        if (lastCommittedRef.current === null) {
          executorPromiseRef.current = null;
        }
      }
    })();
    // Empty dep set — refresh is stable across renders. Inputs (`db`
    // and `now`) are routed through refs above so an inline factory or
    // clock from the caller doesn't churn this callback's identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Mount: kick off the first refresh.
  useEffect(() => {
    mountedRef.current = true;
    refresh();
    return () => {
      mountedRef.current = false;
      // Bump the call counter on unmount so any still-in-flight read
      // can't commit after teardown.
      callCounterRef.current += 1;
    };
  }, [refresh]);

  // AppState 'active' transition: re-query so a UTC-midnight rollover
  // surfaces without a remount. The single-flight semantics live inside
  // refresh (the call-counter ref); we don't need a debounce here.
  useEffect(() => {
    const sub = AppState.addEventListener(
      'change',
      (next: AppStateStatus) => {
        if (next === 'active') {
          refresh();
        }
      },
    ) as { remove?: () => void } | undefined;
    return () => {
      if (sub && typeof sub.remove === 'function') {
        sub.remove();
      }
    };
  }, [refresh]);

  return {
    used,
    limit: LLM_DAILY_LIMIT,
    status,
    refresh,
  };
}
