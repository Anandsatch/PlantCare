/**
 * `SyncDrainer` — drives queued requests through the API client and updates
 * each row's persisted state via the E7-001 CRUD layer.
 *
 * ─── Drain trigger surfaces (this ticket only ships the module) ───────────
 *
 * The drainer is callable but not yet wired. E7-003 will hook it to the
 * NetInfo + AppState listeners (online_active transition, foreground); E7-004
 * will hook the LLM hooks to enqueueRequest + present `kind: 'queued'`;
 * E7-006 will hook the "Tap to retry" surface. This file ships:
 *
 *   - `drainNow()`              — process every ready row serially.
 *   - `runStartupSweep({nowMs})` — TTL + stuck-in_flight recovery, on app launch.
 *   - `stop()`                  — request cancellation; the active row finishes.
 *
 * The wiring intentionally lives outside this module so the drainer is a
 * pure orchestrator over (clock, db, api) inputs. Callers compose; the
 * drainer doesn't subscribe to global state directly.
 *
 * ─── Serial drain — V1 lock ───────────────────────────────────────────────
 *
 * Process rows one at a time. The reasons:
 *
 *   1. Rate-limit fairness. The backend enforces per-device rate limits via
 *      the X-Device-Id header (`apps/backend/src/lib/_rateLimit.ts`).
 *      A parallel drainer of N rows would synthesize a burst that the
 *      backend would 429 immediately; the queue's purpose is to *avoid*
 *      that in the first place.
 *   2. Backoff schedule fidelity. If two rows fail in parallel under a
 *      shared transient outage, scheduling each independently from
 *      Date.now() at COMMIT time gives them subtly-different next-attempt
 *      times that fragment the recovery probe. Serial drain keeps the
 *      schedule monotonic per row.
 *   3. Lost-update defense at the SQL layer. The CRUD's exclusive
 *      transaction (P1 from codex on E7-001) defends against two writers,
 *      but only one drainer is the *intended* writer. Holding the line at
 *      one in-flight row keeps the failure mode out of the read+write race
 *      surface entirely.
 *   4. Bandwidth + battery. A user trickling back online over a weak cell
 *      connection wants their first request to land, not five concurrent
 *      uploads sharing one TCP window.
 *
 * REJECT in V1: parallel drain, batched dispatch, "fan out N rows at once,"
 * job-runner libraries (queue-promise, p-queue, bull), worker pools.
 *
 * ─── Sweep ordering on launch ─────────────────────────────────────────────
 *
 * The launch ritual is:
 *
 *   1. `runStartupSweep({nowMs})` — fires `sweepStaleEntries` (delete
 *      terminal rows past 7 days) and `recoverStuckInFlight` (reset
 *      in_flight rows older than 5 min back to pending with attempt_count
 *      bumped). This must happen *before* the first drain so the drainer
 *      doesn't try to call `markInFlight` on a row that's already
 *      `in_flight` (silent no-op per CRUD contract, but skipping wasted
 *      work is good hygiene).
 *   2. `drainNow()` — process the now-pending rows.
 *
 * The CRUD layer's `sweepStaleEntries` deliberately preserves pending +
 * in_flight rows regardless of age; the stuck-in_flight recovery happens
 * here, not there, because the policy is drainer-local (the CRUD layer
 * doesn't know about app-launch boundaries).
 *
 * ─── Stuck in_flight recovery (5 min threshold) ───────────────────────────
 *
 * A row stuck in `in_flight` state on launch means the previous app
 * session crashed or was force-killed mid-drain. Recovery policy:
 *
 *   - in_flight rows where `last_attempt_started_at` < nowMs - 5 minutes
 *     are reset to `pending` with attempt_count incremented (so the
 *     backoff schedule still terminates after MAX_ATTEMPTS — a row
 *     repeatedly crashing the app still fails out instead of looping).
 *   - We don't have a `last_attempt_started_at` column. We use
 *     `next_attempt_at` as a proxy: when `markInFlight` flipped the row
 *     to in_flight, `next_attempt_at` was the value the drainer used to
 *     decide the row was ready. A row that's been in_flight for > 5 min
 *     means `next_attempt_at` is at least 5 min in the past *and* status
 *     is still in_flight, which only happens if the drainer never
 *     reported terminal state.
 *   - Threshold tuning: 5 min covers a slow upload over a weak cell
 *     network (the API client's default timeout is 20s; 5 min is 15x
 *     headroom for app-suspended-mid-drain on iOS, where an app can
 *     spend up to 30s in suspended state before being killed). Any row
 *     genuinely in-flight beyond 5 min of wall-clock has been abandoned
 *     by an OS-level kill, not by user action.
 *   - We bump attempt_count via the CRUD's `scheduleBackoff` (with the
 *     row first re-marked as in_flight to satisfy the state guard) so
 *     the schedule stays consistent — recovery counts as one attempt.
 *
 * Why not a separate column: schema churn. `next_attempt_at` is a
 * usable proxy because in_flight rows don't reschedule until either
 * markDone or scheduleBackoff fires; if neither fired, the timestamp
 * is the original "I'm processing this" boundary. Future schema rev
 * (post-V1) can split this out cleanly.
 *
 * ─── Idempotent drainNow ─────────────────────────────────────────────────
 *
 * `drainNow()` returns a Promise. If a drain is already in progress, the
 * second call returns the *same* in-progress promise (so callers awaiting
 * it observe the same completion). This is per-instance idempotency; two
 * separate `SyncDrainer` instances do not share state. (V1 wires a single
 * instance per app — see E7-003.)
 *
 * ─── Cancellation semantics ──────────────────────────────────────────────
 *
 * `stop()` requests a graceful halt. The currently-processing row finishes
 * (we don't kill mid-row — partial state would mean an unparseable
 * `in_flight` row whose actual API status is unknown). After the row
 * resolves, the drainer breaks the loop without picking up the next row.
 *
 * Subsequent `drainNow()` calls reset the stop flag and proceed.
 *
 * ─── 429 retry-after takes precedence over the schedule ──────────────────
 *
 * When the API returns `kind: 'server'` with `retry_after`, the drainer
 * reschedules with `retry_after_seconds * 1000` instead of consuming a
 * schedule slot. The attempt count does NOT increment — a 429 means "you
 * asked too fast, try again later," not "your request failed." Burning a
 * schedule slot on rate-limit would force a working request into the
 * terminal-fail branch under sustained rate-limit pressure.
 *
 * The retry-after override is implemented as a direct UPDATE rather than
 * a CRUD call because the CRUD's `scheduleBackoff` is locked to the
 * master-plan schedule. Adding a "schedule with custom delay" entry point
 * to the CRUD layer would surface a foot-gun (callers could pass any
 * delay and bypass the locked schedule); keeping it drainer-local makes
 * the precedence explicit at the call site.
 *
 * ─── Endpoint dispatch ──────────────────────────────────────────────────
 *
 * The CRUD layer stores `endpoint` as a string. The drainer dispatches by
 * a closed table of supported endpoints. Unknown endpoints are
 * non-retryable: a row whose endpoint we don't recognize means a deploy
 * skew (the producer wrote a kind we don't know how to drive); retrying
 * won't fix it. We `markFailedTerminal` and move on.
 *
 * Image endpoints (`identify`, `diagnose`) carry their request body as
 * the JSON-serialized image descriptor `{ uri, name?, type? }`; the
 * drainer reconstructs the API call shape. Text endpoints (`consult`,
 * `review`) carry the request body verbatim.
 *
 * ─── UTC ms only ─────────────────────────────────────────────────────────
 *
 * Same E4-002 critical-regression contract as `useWateringEngine` and
 * the CRUD layer. No `Date.getDate`, no `setHours`, no `toLocaleDateString`.
 * Source-grep test pins this in `__tests__/SyncDrainer.test.ts`.
 */

import type {
  ApiClient,
  ApiResult,
  ConsultRequest,
  ConsultResponse,
  DiagnoseRequest,
  DiagnoseResponse,
  IdentifyRequest,
  IdentifyResponse,
  ReviewRequest,
  ReviewResponse,
} from '../api';
import {
  isLlmCallEndpoint,
  recordLlmCall,
  shouldRecordLlmCallResult,
  type LlmCallEndpoint,
  type LlmCallWriter,
} from '../lib/llmBudget';
import {
  claimInFlight,
  markDone,
  markFailedTerminal,
  scheduleBackoff,
  selectReadyForRetry,
  sweepStaleEntries,
  type QueueBindValue,
  type QueueExecutor,
  type QueueKind,
  type QueueRow,
} from './queueCrud';

/**
 * Maximum rows pulled per drain pass. Cap exists so a stuck device with
 * thousands of queued rows doesn't load all of them into memory at once;
 * each drain pass commits its results, and the next call picks up where
 * it left off. 50 covers the upper bound of a heavy offline session
 * (worst case: a user diagnoses 5 plants/day × 8 days offline ≈ 40 rows)
 * with headroom.
 */
export const DRAIN_BATCH_LIMIT = 50;

/**
 * Stuck-in_flight recovery threshold in milliseconds. A row that's been
 * in_flight for > 5 min on launch is presumed abandoned by an OS-level
 * kill and reset to pending (with attempt_count incremented). See file
 * header for tuning rationale.
 */
export const STUCK_IN_FLIGHT_THRESHOLD_MS = 5 * 60_000;

/**
 * Maximum consecutive rate-limit responses we honor before demoting to
 * the regular retryable schedule (which burns an attempt). Defense
 * against a backend that emits `server + retry_after` for a non-429
 * (5xx with Retry-After) — codex flagged the api-client classifies 5xx
 * with Retry-After as `server + retry_after`, identical to a true 429.
 *
 * Without this cap, repeated 5xx-with-retry-after would never increment
 * attempt_count and never terminal-fail, expanding the "multiple 429s
 * never terminal" rule to non-rate-limit server failures. The cap is
 * per-drainer-session in-memory (does not persist across app restarts),
 * which is acceptable: a backend stuck on this pattern across multiple
 * session lifetimes is a persistent server bug the schedule's terminal
 * fail can absorb at session boundary, not infinite-loop forever within
 * one session.
 *
 * Tuning: 10 consecutive rate-limits at the worst-case retry-after of
 * 10 minutes is ~100 minutes of patience before the drainer demotes to
 * the regular schedule and starts burning attempts. A genuine rate
 * limit clears well before that.
 */
export const MAX_CONSECUTIVE_RATE_LIMITS = 10;

/** Closed table of endpoints the drainer knows how to drive. */
const KNOWN_ENDPOINTS: ReadonlySet<QueueKind> = new Set([
  'identify',
  'diagnose',
  'consult',
  'review',
]);

function isKnownEndpoint(value: string): value is QueueKind {
  return KNOWN_ENDPOINTS.has(value as QueueKind);
}

/**
 * Outcome categories the drainer derives from `ApiResult`. Each carries
 * a `billable` flag — true when the upstream LLM call actually fired
 * and consumed quota, regardless of whether the API surfaced a success
 * or a structured error. The flag drives the E11-006 insertion path
 * (`recordLlmCall`); see `lib/llmBudget.ts` for the policy table.
 *
 * Locked taxonomy:
 *   - `success`              — billable=true (ok=true)
 *   - `rate_limited`         — billable=true (server returned 429; provider
 *                              processed enough to rate-limit us)
 *   - `retryable` (server)   — billable=true (5xx — provider billed)
 *   - `retryable` (net/timo) — billable=false (fetch threw before reaching
 *                              provider OR never reached provider)
 *   - `terminal` (parse/L1/  — billable=true (provider billed; we just
 *      low_conf)               couldn't use the response or it was off-topic)
 *   - `terminal` (unknown    — billable=false (we never even built the
 *      endpoint / payload)     request — schema-level reject)
 *   - `paradox`              — billable=false (kind='queued' from API; we
 *                              never want to count a "the backend says
 *                              you're queued" response as a billable hit)
 */
type DispatchOutcome =
  | { kind: 'success'; billable: true }
  /** Server returned 429 with a retry-after; reschedule without burning an attempt. */
  | { kind: 'rate_limited'; retryAfterMs: number; billable: true }
  /** Retryable: network / timeout / server (non-429). Burns a schedule slot. */
  | { kind: 'retryable'; errorMessage?: string; billable: boolean }
  /** Non-retryable: parse_error / layer1_reject / unknown endpoint. Terminal. */
  | { kind: 'terminal'; errorMessage?: string; billable: boolean }
  /** Paradoxical: `kind: 'queued'` from the API itself — shouldn't happen mid-drain. */
  | { kind: 'paradox'; errorMessage: string; billable: false };

/** Result of a single drain pass; useful for tests + observability hooks. */
export interface DrainSummary {
  processed: number;
  succeeded: number;
  rescheduled: number;
  rateLimited: number;
  failedTerminal: number;
  /** True if `stop()` was called and the loop exited mid-batch. */
  stopped: boolean;
}

/** Result of the launch sweep. */
export interface StartupSweepSummary {
  /** Terminal rows deleted by the 7-day TTL sweep. */
  ttlDeleted: number;
  /** in_flight rows reset to pending due to the 5-min stuck threshold. */
  stuckRecovered: number;
}

export interface SyncDrainerConfig {
  db: QueueExecutor;
  apiClient: ApiClient;
  /** Override clock for tests; defaults to `Date.now`. */
  now?: () => number;
  /**
   * E11-006 insertion path. When provided, the drainer calls
   * `recordLlmCall(budgetDb, endpoint, { nowMs: now() })` AFTER any
   * dispatched row whose `DispatchOutcome.billable === true` (success,
   * rate-limited, server 5xx, parse_error, layer1_reject, low_confidence
   * — everything that billed the upstream provider). DO NOT record on
   * network/timeout/queued/paradox/unknown-endpoint — those did not
   * bill quota. The drainer uses its OWN `nowMs` so a queued call
   * drained later counts toward the day it actually FIRES (not the
   * day it was queued) per the master-plan UTC-day budget rule.
   *
   * Optional: when omitted (legacy compositions, isolated drainer
   * tests), the drainer is a no-op on the budget side. Production
   * wiring (E7-003) supplies the same `openDb()` handle the rest of
   * the app shares; better-sqlite3 in tests injects a small writer.
   */
  budgetDb?: LlmCallWriter;
  /** Override drain batch limit; defaults to DRAIN_BATCH_LIMIT. */
  batchLimit?: number;
  /**
   * Override the stuck-in_flight recovery threshold. Defaults to
   * STUCK_IN_FLIGHT_THRESHOLD_MS (5 min).
   */
  stuckInFlightThresholdMs?: number;
  /**
   * Override the consecutive-rate-limit cap. Defaults to
   * MAX_CONSECUTIVE_RATE_LIMITS (10). After this many consecutive
   * `server + retry_after` outcomes on the same row, the drainer
   * demotes to the regular schedule (burning an attempt). Tests
   * use a smaller value to hit the boundary cheaply.
   */
  maxConsecutiveRateLimits?: number;
}

/**
 * Construct a drainer. Returns a singleton-ish handle: the caller (E7-003)
 * holds onto it for the lifetime of the app and calls `drainNow()` /
 * `stop()` from listeners. The factory pattern (over a class) keeps the
 * dependency surface explicit and avoids the `this`-binding pitfalls of
 * destructured methods.
 */
export interface SyncDrainer {
  /**
   * Trigger a drain pass. If a drain is already in progress, returns the
   * same promise so concurrent callers observe one shared completion.
   */
  drainNow(): Promise<DrainSummary>;
  /**
   * Run the launch ritual: 7-day TTL sweep + stuck-in_flight recovery.
   * Must run before the first drain — see file header.
   */
  runStartupSweep(): Promise<StartupSweepSummary>;
  /**
   * Request graceful cancellation. The currently-processing row finishes;
   * the loop breaks before picking up the next row.
   */
  stop(): void;
  /** True if a drain pass is currently in flight. */
  isDraining(): boolean;
}

export function createSyncDrainer(config: SyncDrainerConfig): SyncDrainer {
  const now = config.now ?? Date.now;
  const batchLimit = config.batchLimit ?? DRAIN_BATCH_LIMIT;
  const stuckThresholdMs =
    config.stuckInFlightThresholdMs ?? STUCK_IN_FLIGHT_THRESHOLD_MS;
  const maxConsecutiveRateLimits =
    config.maxConsecutiveRateLimits ?? MAX_CONSECUTIVE_RATE_LIMITS;

  let activeDrain: Promise<DrainSummary> | null = null;
  let stopRequested = false;
  // In-memory consecutive-rate-limit counter, keyed by row id. Reset on
  // any non-rate-limit outcome (success, retryable, terminal) and on
  // app restart (the drainer is constructed fresh). See
  // MAX_CONSECUTIVE_RATE_LIMITS docstring for the rationale.
  const consecutiveRateLimits = new Map<string, number>();

  async function runDrainPass(): Promise<DrainSummary> {
    const summary: DrainSummary = {
      processed: 0,
      succeeded: 0,
      rescheduled: 0,
      rateLimited: 0,
      failedTerminal: 0,
      stopped: false,
    };

    // Pull a fresh batch of ready rows. Rows enqueued during the drain
    // (or rescheduled by an earlier iteration of this same pass) will
    // be picked up on the *next* drainNow() call — keeping the batch
    // immutable across the loop avoids long-running passes that never
    // terminate under continuous enqueue pressure.
    const rows = await selectReadyForRetry(config.db, {
      nowMs: now(),
      limit: batchLimit,
    });

    for (const row of rows) {
      if (stopRequested) {
        summary.stopped = true;
        break;
      }
      await processRow(row, summary);
    }

    return summary;
  }

  async function processRow(row: QueueRow, summary: DrainSummary): Promise<void> {
    summary.processed += 1;

    // Atomic claim: pending → in_flight inside an exclusive transaction.
    // If a sibling drainer already claimed this row (V1 lock against
    // parallel dispatch — defense-in-depth), `claimInFlight` returns
    // false and we skip the API call entirely. Without this, two
    // drainers selecting the same pending row would both dispatch and
    // the loser's success/error mutators would no-op against the
    // winner's state-guarded transitions — but the API call would
    // already have been duplicated, wasting bandwidth and (worse) a
    // rate-limit slot.
    const claimed = await claimInFlight(config.db, row.id);
    if (!claimed) {
      // Either a sibling drainer claimed it, or the row already went
      // terminal between selectReadyForRetry and the claim attempt.
      // Drop our processed-count back so the summary reflects actual
      // work; the row will be re-selected on the next drain pass if
      // it's still pending.
      summary.processed -= 1;
      consecutiveRateLimits.delete(row.id);
      return;
    }

    let outcome: DispatchOutcome;
    try {
      outcome = await dispatchRow(row, config.apiClient);
    } catch (err) {
      // The API client classifies its own failures into ApiResult kinds;
      // a thrown error here is a programming-error path (e.g. malformed
      // payload_json that JSON.parse rejects, or a payload that fails
      // schema reconstruction). These are non-retryable — the row's
      // shape is the problem, retrying won't fix it. Not billable —
      // the request never made it to the provider.
      outcome = {
        kind: 'terminal',
        errorMessage: err instanceof Error ? err.message : String(err),
        billable: false,
      };
    }

    // E11-006 insertion path. Record BEFORE the row's terminal-state
    // mutator so a budget-write failure (logged in `recordLlmCall`)
    // never blocks the row from advancing. Best-effort: errors are
    // swallowed inside the helper. The drainer-side `nowMs` is the
    // drain-time clock — a row queued yesterday and drained today
    // counts as a today call (master-plan UTC-day budget rule).
    if (outcome.billable && config.budgetDb && isLlmCallEndpoint(row.endpoint)) {
      const endpoint: LlmCallEndpoint = row.endpoint;
      void recordLlmCall(config.budgetDb, endpoint, { nowMs: now() });
    }

    switch (outcome.kind) {
      case 'success':
        consecutiveRateLimits.delete(row.id);
        await markDone(config.db, row.id);
        summary.succeeded += 1;
        return;

      case 'rate_limited': {
        const prior = consecutiveRateLimits.get(row.id) ?? 0;
        const next = prior + 1;
        if (next > maxConsecutiveRateLimits) {
          // Demote: the api-client surfaces 5xx-with-Retry-After as
          // server+retry_after identical to a true 429, so a backend
          // stuck on that pattern would never burn an attempt. After
          // MAX_CONSECUTIVE_RATE_LIMITS hits we route through the
          // regular schedule, which both honors the schedule and
          // makes terminal failure reachable. Reset the counter so a
          // genuine 429 cycle later in the row's life starts fresh.
          consecutiveRateLimits.delete(row.id);
          const result = await scheduleBackoff(config.db, row.id, {
            nowMs: now(),
            errorMessage: 'rate-limit cap exceeded; demoted to schedule',
          });
          if (result.status === 'failed') {
            summary.failedTerminal += 1;
          } else {
            summary.rescheduled += 1;
          }
          return;
        }
        consecutiveRateLimits.set(row.id, next);
        await rescheduleAfterRateLimit(row, outcome.retryAfterMs);
        summary.rateLimited += 1;
        return;
      }

      case 'retryable': {
        consecutiveRateLimits.delete(row.id);
        const result = await scheduleBackoff(config.db, row.id, {
          nowMs: now(),
          errorMessage: outcome.errorMessage,
        });
        if (result.status === 'failed') {
          summary.failedTerminal += 1;
        } else {
          // 'pending' (rescheduled) or 'noop' (state-guarded).
          summary.rescheduled += 1;
        }
        return;
      }

      case 'terminal':
        consecutiveRateLimits.delete(row.id);
        await markFailedTerminal(config.db, row.id, outcome.errorMessage);
        summary.failedTerminal += 1;
        return;

      case 'paradox':
        // Backend returned `kind: 'queued'` to a request the drainer
        // submitted. That would mean the *backend* has its own queue
        // and is bouncing our retry — which is not how V1 works (the
        // backend serves synchronously; the queue is mobile-side only).
        // Surface as terminal so it doesn't loop; the message is
        // diagnostic for the next bug report.
        consecutiveRateLimits.delete(row.id);
        await markFailedTerminal(config.db, row.id, outcome.errorMessage);
        summary.failedTerminal += 1;
        return;
    }
  }

  /**
   * Apply a custom delay from a 429 retry-after. Bypasses the locked
   * schedule (and the attempt-count increment) on purpose — see file
   * header. The state guard `WHERE status = 'in_flight'` ensures a
   * concurrent successful drain (or a manual mark) can't be clobbered
   * by this rewrite.
   */
  async function rescheduleAfterRateLimit(
    row: QueueRow,
    retryAfterMs: number,
  ): Promise<void> {
    const nextAttemptAt = now() + Math.max(0, retryAfterMs);
    await config.db.runAsync(
      `UPDATE sync_queue
          SET status = 'pending',
              next_attempt_at = ?,
              last_error = NULL
        WHERE id = ? AND status = 'in_flight'`,
      [nextAttemptAt, row.id] as QueueBindValue[],
    );
  }

  async function recoverStuckInFlight(nowMs: number): Promise<number> {
    // Find in_flight rows where next_attempt_at is older than the
    // threshold. next_attempt_at is the value at markInFlight time
    // (markInFlight doesn't update it; only scheduleBackoff /
    // rescheduleAfterRateLimit do). A row stuck > threshold means the
    // drainer never reported terminal state — i.e. crash/kill/suspend.
    const cutoff = nowMs - stuckThresholdMs;
    const stuck = await config.db.getAllAsync<{
      id: string;
      attempt_count: number;
    }>(
      `SELECT id, attempt_count
         FROM sync_queue
        WHERE status = 'in_flight' AND next_attempt_at <= ?`,
      [cutoff] as QueueBindValue[],
    );

    let recovered = 0;
    for (const stuckRow of stuck) {
      // Recovery counts as one attempt: bump attempt_count via the
      // CRUD's scheduleBackoff path. The row is already in_flight, so
      // the state guard is satisfied. If attempt_count was already 5
      // (5 prior attempts), the 6th will terminal-fail — appropriate
      // for a row that's repeatedly crashing the app mid-drain.
      const result = await scheduleBackoff(config.db, stuckRow.id, {
        nowMs,
        errorMessage: 'recovered after stuck in_flight on app launch',
      });
      if (result.status !== 'noop') {
        recovered += 1;
      }
    }
    return recovered;
  }

  function drainNow(): Promise<DrainSummary> {
    // Idempotent: if a drain is already running, return the same
    // promise so concurrent callers observe one shared completion.
    // Synchronous (not async) so the returned promise reference is
    // identical across concurrent calls — an outer `async function`
    // would wrap each return in a fresh promise and break referential
    // equality, which is what callers (and the idempotency test) check.
    if (activeDrain) {
      return activeDrain;
    }
    stopRequested = false;
    const run = (async () => {
      try {
        return await runDrainPass();
      } finally {
        activeDrain = null;
      }
    })();
    activeDrain = run;
    return run;
  }

  return {
    drainNow,

    async runStartupSweep() {
      const nowMs = now();
      // Order: TTL sweep first (cheap, deletes terminal-only rows),
      // then stuck recovery (mutates in_flight → pending). Reverse
      // order would be fine too — they don't overlap on row sets —
      // but cheap-first lets the recovery loop see a smaller table.
      const ttl = await sweepStaleEntries(config.db, { nowMs });
      const stuckRecovered = await recoverStuckInFlight(nowMs);
      return { ttlDeleted: ttl.deleted, stuckRecovered };
    },

    stop() {
      stopRequested = true;
    },

    isDraining() {
      return activeDrain !== null;
    },
  };
}

// ─── Endpoint dispatch ─────────────────────────────────────────────────────

/**
 * Decode the persisted payload + endpoint into an API call and classify
 * the result into a DispatchOutcome. Pure function over (row, apiClient);
 * no clock or state side-effects beyond the API call itself.
 */
async function dispatchRow(
  row: QueueRow,
  api: ApiClient,
): Promise<DispatchOutcome> {
  if (!isKnownEndpoint(row.endpoint)) {
    return {
      kind: 'terminal',
      errorMessage: `unknown endpoint '${row.endpoint}'`,
    };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(row.payload_json);
  } catch (err) {
    return {
      kind: 'terminal',
      errorMessage: `payload JSON parse failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  let result: ApiResult<unknown>;
  switch (row.endpoint) {
    case 'identify':
      result = await api.identify(payload as IdentifyRequest);
      return classify(result as ApiResult<IdentifyResponse>);
    case 'diagnose':
      result = await api.diagnose(payload as DiagnoseRequest);
      return classify(result as ApiResult<DiagnoseResponse>);
    case 'consult':
      result = await api.consult(payload as ConsultRequest);
      return classify(result as ApiResult<ConsultResponse>);
    case 'review':
      result = await api.review(payload as ReviewRequest);
      return classify(result as ApiResult<ReviewResponse>);
  }
}

/**
 * Map an ApiResult kind to a drainer outcome. Locked taxonomy:
 *
 *   - ok                                 → success
 *   - server + retry_after (i.e. 429)    → rate_limited (custom delay,
 *                                          no attempt burn)
 *   - server (no retry_after, i.e. 5xx)  → retryable
 *   - network / timeout                  → retryable
 *   - parse_error / layer1_reject /
 *     low_confidence                     → terminal (non-retryable)
 *   - queued                             → paradox (terminal, with
 *                                          diagnostic message)
 */
function classify(result: ApiResult<unknown>): DispatchOutcome {
  if (result.ok) {
    return { kind: 'success' };
  }
  switch (result.kind) {
    case 'server': {
      // Retry-after is the 429 signal in the client classification.
      // 5xx (no retry-after) takes the retryable path.
      if (typeof result.retry_after === 'number') {
        return {
          kind: 'rate_limited',
          retryAfterMs: Math.max(0, result.retry_after) * 1_000,
        };
      }
      return { kind: 'retryable', errorMessage: result.message };
    }
    case 'network':
    case 'timeout':
      return { kind: 'retryable', errorMessage: result.message };
    case 'parse_error':
    case 'layer1_reject':
    case 'low_confidence':
      return { kind: 'terminal', errorMessage: result.message };
    case 'queued':
      return {
        kind: 'paradox',
        errorMessage:
          'API returned kind=queued; backend should not bounce drainer-issued requests in V1',
      };
  }
}
