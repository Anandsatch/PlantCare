/**
 * `useMarkWatered(plantId)` — typed mutation hook for the "Mark watered"
 * CTA on `<PlantDetailScreen>` (E4-006).
 *
 * # Surface
 *
 * ```ts
 * const { mutate, status, error } = useMarkWatered(plant.id);
 * await mutate({ source: 'user' });
 * ```
 *
 * `mutate({ source? })`:
 *   - `source` defaults to `'user'` (the canonical "user tapped Mark
 *     watered" value already used elsewhere in the codebase — see
 *     `migrations.test.ts` and `usePlants.test.tsx`). `'rules_confirmed'`
 *     is the auto-applied path that the rules engine will use later. The
 *     master plan ("watering_events: source TEXT NOT NULL — 'user' |
 *     'rules_confirmed'") is the source of truth.
 *
 *     The brief asks for `'manual' | 'auto'`. Vocabulary mismatch resolved
 *     in favor of the master plan: shipping `'manual'` would diverge from
 *     the existing seed/test data and force a rename across the whole
 *     codebase later. The hook accepts the master-plan vocabulary at the
 *     wire level; future shorthand is purely a UI concern.
 *
 *   - Inserts a row with `INSERT INTO watering_events (...) RETURNING *`.
 *     The atomic INSERT-with-RETURNING avoids the UPDATE-then-SELECT race
 *     locked by Wave 1 and used by `usePlants.create` / `usePlants.update`.
 *     A separate INSERT + SELECT could observe a different row state if a
 *     concurrent caller wrote first.
 *
 *   - Optimistic update: emits `wateringEventsBus.emitOptimistic(plantId,
 *     wateredAtMs)` synchronously *before* the SQL roundtrip. Any
 *     subscribed `useWateringEngine()` re-derives status immediately so
 *     the chip flips before the INSERT resolves. On success →
 *     `emitCommit`; on failure → `emitRollback`. The whole protocol is
 *     documented in `db/wateringEvents.ts`.
 *
 * # status state machine
 *
 * `idle` → (mutate called) → `pending` → (INSERT settled) → `ok` | `error`
 *
 * Successive mutates from `ok` reset to `pending` then settle again. A
 * mutate from `error` clears the previous error and follows the same path.
 *
 * The screen reads `status === 'pending'` to drive the EditorialButton's
 * `loading` prop, which (a) shows the activity indicator and (b) makes the
 * press inert. Together with the in-hook 1s debounce, double-tap is
 * defended at three layers:
 *   1. EditorialButton's same-tick `pressedThisTickRef` (E2-008).
 *   2. EditorialButton's `loading=true` → `disabled=true` (`status==='pending'`).
 *   3. `useMarkWatered`'s 1s debounce ref (this file).
 *
 * Layer 3 is the load-bearing one for the brief: a sub-1s second tap that
 * somehow slips past 1+2 (e.g. Programmatic call from a test, two pressables
 * in different parts of the screen pointing at the same mutate) is dropped
 * silently. Each `mutate` returns a result object regardless — the dropped
 * call resolves to `{ ok: false, kind: 'debounced' }` so callers can
 * disambiguate.
 *
 * # Idempotency window — 1 second, configurable via factory
 *
 * The brief locks the debounce at 1 second. Implementing it as a `Date.now()
 * - lastMutateAtRef` check in the closure means a slow first roundtrip
 * (e.g. SQLite contention) does NOT extend the window — a 2nd tap at
 * `t=1100ms` succeeds even if the first INSERT is still pending. That's
 * the right semantic: the window guards against the human "I tapped that
 * twice on accident", not against concurrent in-flight INSERTs.
 *
 * Concurrent in-flight INSERTs are still safe at the SQL layer — each
 * INSERT generates a new UUID and there's no UNIQUE constraint that would
 * collide. Two in-flight INSERTs both succeed; the user sees two ledger
 * droplets for today, which is technically correct ("I really did water
 * twice") but unlikely in practice.
 *
 * # `Date.now()` is the only time source
 *
 * `watered_at` is unix milliseconds, UTC. No `new Date().toISOString()`,
 * no calendar math, no date-fns. The watering engine survives DST + IDL
 * because every consumer ms-compares; `useMarkWatered` shouldn't be the
 * link in the chain that introduces calendar-day reasoning.
 *
 * # Pure data API
 *
 * `createMarkWateredApi(executor)` is the testable surface (mirrors
 * `createPlantsApi`). Tests instantiate it with a `better-sqlite3`-backed
 * executor and exercise the full lifecycle without booting the React
 * environment. The `useMarkWatered` React hook is a thin wrapper that
 * resolves the executor via `openDb()` and surfaces status via `useState`.
 *
 * # V1 scope locks
 *
 * - No ORM (Drizzle / Kysely / Prisma) — V1 lock.
 * - No date-fns / dayjs / luxon / Temporal — V1 lock.
 * - No react-query / swr / tanstack-query — every consumer hook in the
 *   project rolls its own state machine (see `useDiagnoseRequest`).
 * - No new dep / library — V1 lock.
 * - No backend writes — V1 stays local-first; cloud sync is post-MVP.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { openDb } from '../db/db';
import { wateringEventsBus } from '../db/wateringEvents';
import type { PlantsExecutor, SqlBindValue } from './usePlants';

/**
 * `watering_events.source` vocabulary. The schema's column is `TEXT NOT NULL`
 * with no CHECK constraint, but the master plan locks the value space at
 * two strings. Adding new sources is a future concern; this union is the
 * V1 contract.
 */
export type WateringSource = 'user' | 'rules_confirmed';

export interface MarkWateredInput {
  /**
   * Defaults to 'user'. Pass 'rules_confirmed' when the rules engine is
   * the originator (E4-009 / future). The default reflects the
   * "Mark watered" tap on `<PlantDetailScreen>`.
   */
  source?: WateringSource;
}

/**
 * Result of a `mutate` call. The discriminated union lets callers handle
 * the debounce drop without inspecting status (which is component-state and
 * may have moved on by the time the await resolves).
 */
export type MarkWateredResult =
  | { ok: true; row: WateringEventRow }
  | { ok: false; kind: 'debounced' }
  | { ok: false; kind: 'error'; error: Error };

/**
 * Row shape returned by `INSERT ... RETURNING *`. Mirrors the
 * `watering_events` columns in `db/schema.ts`. Kept local to this hook
 * because the shape is the wire format from SQLite, not a domain type
 * other layers need (the bus carries plantId + ms, not the full row).
 *
 * `source` is narrowed to `WateringSource` rather than `string` (codex
 * P2): the schema's column is `TEXT NOT NULL` with no CHECK, but at the
 * app layer only `'user' | 'rules_confirmed'` are written, so callers
 * shouldn't have to widen-or-cast on read. If a future migration adds a
 * third value, extend the union — that's the explicit place to update.
 */
export interface WateringEventRow {
  id: string;
  plant_id: string;
  watered_at: number;
  source: WateringSource;
  note: string | null;
}

export type MarkWateredStatus = 'idle' | 'pending' | 'ok' | 'error';

/** Debounce window in milliseconds. The brief locks this at 1 second. */
export const MARK_WATERED_DEBOUNCE_MS = 1000;

const SELECT_COLUMNS = 'id, plant_id, watered_at, source, note';

function generateId(): string {
  // Same crypto.randomUUID path as `usePlants.generateId`. Hermes (RN
  // 0.74+) and Node 20+ both expose it; expo-crypto is the fallback if a
  // future target lacks it.
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (!c?.randomUUID) {
    throw new Error('crypto.randomUUID is unavailable; cannot generate watering id');
  }
  return c.randomUUID();
}

/**
 * Pure-data mark-watered API. Takes a `PlantsExecutor` (same shape used by
 * `usePlants` — bind-array variadic form supported by both expo-sqlite and
 * better-sqlite3) and returns an `insert` function that performs the
 * atomic INSERT ... RETURNING and emits the bus events.
 *
 * Exported for tests. The bus is the module-level singleton in both the
 * hook path and the test path (tests reset it via `_resetForTests`).
 *
 * @param executor SQLite executor implementing the `PlantsExecutor` shape.
 * @param nowSource Time source for `watered_at`. Defaults to `Date.now`.
 *   Tests override with a fixed function so the row's timestamp is
 *   deterministic.
 */
export function createMarkWateredApi(
  executor: PlantsExecutor,
  nowSource: () => number = Date.now,
) {
  async function insert(
    plantId: string,
    source: WateringSource,
  ): Promise<WateringEventRow> {
    if (!plantId || plantId.trim() === '') {
      throw new Error('mark-watered: plantId is required');
    }
    const id = generateId();
    const watered_at = nowSource();

    // Emit the optimistic event BEFORE the await so any subscribed
    // `useWateringEngine` flips its derived status synchronously. The
    // subscriber stores `watered_at` in memory and uses it as the
    // last-watered ts until a `commit` arrives.
    wateringEventsBus.emitOptimistic(plantId, watered_at);

    let row: WateringEventRow | null;
    try {
      row = await executor.getFirstAsync<WateringEventRow>(
        `INSERT INTO watering_events (id, plant_id, watered_at, source, note)
         VALUES (?, ?, ?, ?, NULL)
         RETURNING ${SELECT_COLUMNS}`,
        [id, plantId, watered_at, source] as SqlBindValue[],
      );
    } catch (err) {
      // INSERT failed — most likely cause is FK violation (plantId
      // doesn't exist) given the constrained INSERT shape. Emit rollback
      // so subscribers drop the optimistic value and re-query SQLite for
      // the pre-INSERT state.
      wateringEventsBus.emitRollback(plantId);
      throw err;
    }

    if (!row) {
      // Should be impossible: a successful INSERT always returns a row
      // from RETURNING. If it ever happens, treat as a write failure —
      // the optimistic state is wrong and subscribers need to roll back.
      wateringEventsBus.emitRollback(plantId);
      throw new Error(
        `mark-watered: insert succeeded but RETURNING produced no row for plant ${plantId}`,
      );
    }

    wateringEventsBus.emitCommit(plantId);
    return row;
  }

  return { insert };
}

export type MarkWateredApi = ReturnType<typeof createMarkWateredApi>;

/**
 * Lazy executor wrapping `openDb()` — same shape as the one in
 * `usePlants.ts`, kept local to avoid cross-module coupling. Each method
 * awaits the memoized connection and forwards to expo-sqlite's
 * variadic-array form.
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

export interface UseMarkWateredReturn {
  mutate: (input?: MarkWateredInput) => Promise<MarkWateredResult>;
  status: MarkWateredStatus;
  error: Error | null;
}

/**
 * React hook surface. Returns a stable `mutate` callback (memoized against
 * `plantId`) plus the current status and the most-recent error (cleared
 * when a new mutate enters `pending`).
 *
 * Mount-state guard: a `mountedRef` suppresses setState after unmount, so
 * the hook can be used inside a screen the user navigates away from
 * mid-INSERT without React's "setState on unmounted component" warning.
 * The bus emits still fire — the SQL write is independent of the
 * component lifecycle, and the event consumers (other mounted screens)
 * still need the signal.
 */
export function useMarkWatered(plantId: string): UseMarkWateredReturn {
  const [status, setStatus] = useState<MarkWateredStatus>('idle');
  const [error, setError] = useState<Error | null>(null);

  const api = useMemo(() => createMarkWateredApi(createOpenDbExecutor()), []);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Last attempted mutate's `{ plantId, at }` for the 1s debounce. Tracked
  // as a ref so it survives renders without triggering one. Time recorded
  // at *call* (not at completion) so an in-flight slow INSERT doesn't
  // extend the window past 1s.
  //
  // Scoped to plantId (codex P2): if the same hook instance is reused for
  // a different plant within the 1s window (e.g. a deep-link nav between
  // plant detail screens that both reuse this hook surface), the first
  // tap on the new plant must NOT be debounced. The window is the
  // human-double-tap-protection on a single plant; switching plants is a
  // different intent and gets a fresh window.
  const lastMutateRef = useRef<{ plantId: string; at: number } | null>(null);

  const mutate = useCallback(
    async (input?: MarkWateredInput): Promise<MarkWateredResult> => {
      const now = Date.now();
      const last = lastMutateRef.current;
      if (
        last !== null &&
        last.plantId === plantId &&
        now - last.at < MARK_WATERED_DEBOUNCE_MS
      ) {
        // Debounced. Don't touch SQL, don't touch state — return the
        // dropped result so the caller can choose to surface it (or, more
        // commonly, ignore it because the first mutate is still in flight
        // and pending state is already shown on the button).
        return { ok: false, kind: 'debounced' };
      }
      lastMutateRef.current = { plantId, at: now };

      if (mountedRef.current) {
        setStatus('pending');
        setError(null);
      }

      const source: WateringSource = input?.source ?? 'user';
      try {
        const row = await api.insert(plantId, source);
        if (mountedRef.current) {
          setStatus('ok');
        }
        return { ok: true, row };
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        if (mountedRef.current) {
          setError(e);
          setStatus('error');
        }
        return { ok: false, kind: 'error', error: e };
      }
    },
    [api, plantId],
  );

  return { mutate, status, error };
}
