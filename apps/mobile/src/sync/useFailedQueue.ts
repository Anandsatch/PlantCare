/**
 * `useFailedQueue` — surfaces sync_queue rows in `status='failed'` to the
 * UI and drives the E7-006 "Tap to retry" flow.
 *
 * Composes the E7-001 CRUD layer (`selectFailedRows`, `resetForRetry`)
 * with the E7-002 drainer (`drainNow()`). The hook knows nothing about
 * the toast-banner shape — that's `QueueRetryBanner`. The hook knows
 * nothing about how the banner is mounted or where in the screen tree
 * it lives — that's a future ticket (E7-004 or a follow-up wires this
 * into the app shell). This file ships the pure data layer so it can be
 * consumed wherever it ends up rendering.
 *
 * ─── Surface (locked) ──────────────────────────────────────────────────
 *
 *   const { failedRows, retryAll, retryOne, refresh, status } =
 *     useFailedQueue({ db, drainer });
 *
 *   - `failedRows`    — read-only snapshot of failed rows, ordered by
 *                       created_at ASC (oldest first). Refreshed on
 *                       mount, on AppState 'active' transition, and
 *                       after retryAll / retryOne resolve.
 *   - `retryAll()`    — single exclusive transaction resets every
 *                       currently-listed failed row to pending, then
 *                       fires `drainer.drainNow()`.
 *   - `retryOne(id)`  — same path for one id. Safe no-op if the id is
 *                       no longer in `failed` state (the row was already
 *                       reclassified — we don't fight the drainer).
 *   - `refresh()`     — re-query failed rows. Idempotent; setState only
 *                       fires if the row set changed (by id list).
 *   - `status`        — 'idle' | 'retrying'. Flips to 'retrying' the
 *                       moment retryOne / retryAll start the reset
 *                       transaction; flips back to 'idle' after the
 *                       drainer.drainNow() promise resolves AND the
 *                       post-retry refresh completes.
 *
 * ─── AppState resume ──────────────────────────────────────────────────
 *
 * On AppState 'active' transition, the hook re-queries failed rows. A
 * user who backgrounded the app and came back hours later may have
 * accumulated more failures (the drainer kept running until the OS
 * suspended the process), or may have had failures cleared by an
 * external retry surface (future tickets).
 *
 * Single-flight guard: if a refresh is already in flight when 'active'
 * fires, the second refresh is dropped — the in-flight one will pick
 * up whatever the latest table state is at its read time. Two parallel
 * SELECTs would race to setState and the loser's snapshot could
 * overwrite the winner's. Codex P2 from adversarial review.
 *
 * ─── retry safety: in_flight rows are NEVER reset ──────────────────────
 *
 * The CRUD layer's `resetForRetry` enforces the state guard
 * (status='failed' only). The drainer owns in_flight lifecycle; resetting
 * an in_flight row would race the drainer's terminal mutator and could
 * cause duplicate API calls. The hook surfaces only failed rows in
 * `failedRows`, so the user can't tap a CTA that targets an in_flight
 * row in the first place — but defense-in-depth at the CRUD edge means
 * even a stale `retryOne(id)` against a since-reclassified id is safe.
 *
 * ─── status transitions ───────────────────────────────────────────────
 *
 *      retryAll/retryOne called
 *   idle ─────────────────────────▶ retrying
 *                                       │
 *                       drainer.drainNow() resolves
 *                                       │
 *                                refresh() completes
 *                                       ▼
 *                                      idle
 *
 * If retryAll is called while status is 'retrying', the second call is a
 * no-op (we don't queue retries; the in-flight retry path is itself
 * driving the drainer, which will pick up any rows the second click
 * would have targeted on its next pass anyway). This matches the
 * idempotency contract of `drainer.drainNow()` itself (concurrent calls
 * share one promise reference).
 *
 * ─── React 18 strict-mode double-mount ─────────────────────────────────
 *
 * Strict mode mounts every effect twice in dev. The mount-effect just
 * fires `refresh()`, which is idempotent (setState with the same
 * snapshot is a React no-op via Object.is on the array reference, and
 * we de-duplicate by id list). The AppState subscription cleanup runs
 * on the first unmount and re-subscribes on remount; modern RN's
 * `addEventListener` returns a `{remove()}` subscription handle so the
 * cleanup is a one-liner.
 *
 * ─── V1 scope locks ────────────────────────────────────────────────────
 *
 *   - DO NOT mount the banner in the app shell here. That's a future
 *     ticket. This hook + its companion banner ship today; wiring lives
 *     in E7-004 or a follow-up.
 *   - DO NOT add a job-runner library. The retry path is "reset the rows,
 *     fire drainNow()" — three lines.
 *   - DO NOT touch in_flight rows. CRUD enforces.
 *   - DO NOT auto-retry on AppState resume. The user explicitly tapped
 *     a CTA to opt in; auto-retry would surprise users who left a row
 *     failed deliberately (e.g. to wait until they're on wifi).
 *   - DO NOT add a "retry with custom delay" surface. The retry button
 *     is "drain now"; if the user wants to wait, they don't tap it.
 *
 * ─── UTC ms only ───────────────────────────────────────────────────────
 *
 * Same E4-002 critical-regression contract as the CRUD + drainer. The
 * hook reads `Date.now()` (or an injected `now`) and passes the value
 * to `resetForRetry`'s `nowMs` field; no calendar math.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, type AppStateStatus } from 'react-native';

import {
  resetForRetry,
  selectFailedRows,
  type QueueExecutor,
  type QueueRow,
} from './queueCrud';
import type { SyncDrainer } from './SyncDrainer';

/** Read-only failed-row snapshot. Same shape as `QueueRow` from the CRUD. */
export type FailedRow = QueueRow;

export type UseFailedQueueStatus = 'idle' | 'retrying';

export interface UseFailedQueueConfig {
  /** The sync_queue executor (production: openDb(); tests: better-sqlite3 adapter). */
  db: QueueExecutor;
  /**
   * The SyncDrainer instance whose `drainNow()` we call after a reset.
   * Single-instance-per-app convention applies (E7-003 wires it; this
   * hook accepts it via injection so tests can supply a mock).
   */
  drainer: Pick<SyncDrainer, 'drainNow'>;
  /** Override clock for tests; defaults to `Date.now`. */
  now?: () => number;
}

export interface UseFailedQueueReturn {
  failedRows: FailedRow[];
  retryAll: () => Promise<void>;
  retryOne: (id: string) => Promise<void>;
  refresh: () => Promise<void>;
  status: UseFailedQueueStatus;
}

/**
 * Compare two failed-row snapshots by id list. Same length + same ids in
 * the same order → snapshots are equivalent. Used to skip setState when
 * a refresh sees no change, so the banner doesn't re-render on every
 * AppState resume in the steady state.
 */
function sameIdList(a: readonly QueueRow[], b: readonly QueueRow[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i].id !== b[i].id) return false;
  }
  return true;
}

export function useFailedQueue(
  config: UseFailedQueueConfig,
): UseFailedQueueReturn {
  const { db, drainer, now = Date.now } = config;

  const [failedRows, setFailedRows] = useState<FailedRow[]>([]);
  const [status, setStatus] = useState<UseFailedQueueStatus>('idle');

  // Mount tracking: setState after unmount is a React warning we want to
  // avoid. The async refresh + retry paths await a network/DB resolve
  // before writing state, so an unmount mid-flight is realistic.
  const mountedRef = useRef(true);
  // Single-flight guard for refresh — see file header. Two callers
  // (manual `refresh()`, AppState 'active', mount, post-retry) all share
  // one in-flight promise. If a refresh is requested while another is
  // already running, we coalesce by chaining a follow-up read after the
  // in-flight one completes — not by dropping the second call.
  //
  // Why coalesce instead of drop: codex P2. If retry's post-retry
  // refresh hits a refresh-in-flight that started BEFORE the reset
  // transaction, the in-flight one returns the pre-retry snapshot and
  // setState is skipped (sameIdList match against the stale snapshot ref).
  // The banner stays visible with stale rows. Coalescing guarantees that
  // a refresh requested after a write always observes the post-write state.
  const refreshInFlightRef = useRef<Promise<void> | null>(null);
  const refreshPendingRef = useRef(false);
  // Single-flight guard for retry — second click while retrying is a no-op.
  const retryInFlightRef = useRef(false);
  // Snapshot of the latest failedRows we wrote, used by sameIdList to
  // skip identical setState.
  const lastSnapshotRef = useRef<FailedRow[]>([]);

  const refresh = useCallback(async (): Promise<void> => {
    if (refreshInFlightRef.current) {
      // Mark that another read is needed AFTER the in-flight one — its
      // snapshot may already be stale by the time we awaited it (e.g.
      // a reset transaction committed between its SELECT and now).
      refreshPendingRef.current = true;
      // Wait for the in-flight one to finish, then chain our follow-up.
      // Note: returning the in-flight promise alone would let the caller
      // observe a stale read; we explicitly chain so the caller's await
      // resolves AFTER the follow-up read commits state.
      await refreshInFlightRef.current;
      // Loop: if our follow-up was itself coalesced into another caller's
      // pending flag, wait for that to drain. The flag is cleared by the
      // caller that does the actual SELECT below.
      while (refreshPendingRef.current && refreshInFlightRef.current) {
        await refreshInFlightRef.current;
      }
      // If after the wait there's no in-flight read but the pending flag
      // is set, fall through to do the SELECT ourselves. Otherwise the
      // pending flag was already serviced by another caller and we're done.
      if (!refreshPendingRef.current) {
        return;
      }
    }
    const run = (async () => {
      // Clear the pending flag now: we're committing to do the SELECT.
      // Any further refresh() call during this read will set the flag
      // again and trigger another follow-up.
      refreshPendingRef.current = false;
      const rows = await selectFailedRows(db);
      if (!mountedRef.current) return;
      if (!sameIdList(lastSnapshotRef.current, rows)) {
        lastSnapshotRef.current = rows;
        setFailedRows(rows);
      }
    })();
    refreshInFlightRef.current = run.finally(() => {
      refreshInFlightRef.current = null;
    });
    await refreshInFlightRef.current;
    // If a sibling caller flipped the pending flag while we were
    // SELECTing, run another pass so post-write reads always observe
    // the latest state.
    if (refreshPendingRef.current) {
      await refresh();
    }
  }, [db]);

  const runRetry = useCallback(
    async (ids: string[]): Promise<void> => {
      if (retryInFlightRef.current) {
        return;
      }
      if (ids.length === 0) {
        return;
      }
      retryInFlightRef.current = true;
      if (mountedRef.current) {
        setStatus('retrying');
      }
      try {
        await resetForRetry(db, ids, { nowMs: now() });
        // Drain immediately so the user sees forward motion. drainer.drainNow
        // is idempotent (concurrent callers share one promise) so it's safe
        // to fire without checking isDraining first.
        await drainer.drainNow();
        // Re-query so the banner reflects post-drain state. A successful
        // drain transitions rows out of 'failed'; a re-failure keeps them
        // in 'failed' and the banner re-appears with the new attempt
        // count surfaced via last_error.
        await refresh();
      } finally {
        retryInFlightRef.current = false;
        if (mountedRef.current) {
          setStatus('idle');
        }
      }
    },
    [db, drainer, now, refresh],
  );

  const retryAll = useCallback(async () => {
    // Snapshot ids at call time. If a sibling drainer's pass moved a row
    // between the click and this read, resetForRetry's state guard
    // silently drops it from the reset set — the row's already drainable
    // or already done.
    const ids = lastSnapshotRef.current.map((row) => row.id);
    await runRetry(ids);
  }, [runRetry]);

  const retryOne = useCallback(
    async (id: string) => {
      await runRetry([id]);
    },
    [runRetry],
  );

  // Mount: initial refresh.
  useEffect(() => {
    mountedRef.current = true;
    void refresh();
    return () => {
      mountedRef.current = false;
    };
  }, [refresh]);

  // AppState resume: re-query failed rows. The single-flight guard inside
  // refresh handles the case where a manual refresh + AppState resume
  // race.
  useEffect(() => {
    const sub = AppState.addEventListener(
      'change',
      (next: AppStateStatus) => {
        if (next === 'active') {
          void refresh();
        }
      },
    );
    return () => sub.remove();
  }, [refresh]);

  return { failedRows, retryAll, retryOne, refresh, status };
}
