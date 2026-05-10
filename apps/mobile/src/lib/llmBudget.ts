/**
 * `recordLlmCall(executor, endpoint, { nowMs })` — single insertion-path
 * helper for the E11-005 budget counter.
 *
 * # Why this exists
 *
 * The `llm_calls` SQLite table backs `useLlmBudget()` (E11-005) and the
 * 40+/50+ banner + LLM CTA disable surfaces (E11-006). Every place in the
 * app that consumes a unit of upstream LLM quota inserts one row here.
 * Centralizing the INSERT as a single helper means:
 *
 *   - one validated `endpoint` enum boundary (we DO NOT add a SQLite
 *     `CHECK` on the column — the master plan locks the column to TEXT
 *     so a future endpoint addition doesn't trigger a migration; the
 *     validation lives at this boundary instead);
 *   - one definition of "happens after a successful response" (codex
 *     adversarial-review risk #1: don't fire on `'queued'` or
 *     `'network'`/`'timeout'` because those calls never reached the
 *     provider and never billed quota);
 *   - one place to flip if we ever add an analytics emitter (V1 lock:
 *     no analytics beyond the SQLite row; the row IS the signal).
 *
 * # When to call it (insertion-path policy — codex E11-006 P1)
 *
 * Call `recordLlmCall(executor, endpoint, { nowMs })` ONLY after a
 * terminal-success `ApiResult`. Specifically:
 *
 *   - `ok: true` → record
 *   - any non-ok kind → DO NOT record
 *
 * Why narrower than "the provider billed":
 *
 *   - `server` (5xx / 429) is RETRYABLE — the SyncDrainer reschedules
 *     and re-fires. A 5xx-success cycle would record twice (or more)
 *     for one user-perceived attempt.
 *   - `parse_error` / `layer1_reject` / `low_confidence` are paths
 *     where the user got no usable result. The budget is a UX gate
 *     (50 visible answers per day), not a provider-billing audit.
 *   - `network` / `timeout` / `queued` never reached or never returned
 *     a result.
 *
 * The OpenRouter free-tier quota IS the upstream lock; the local
 * SQLite counter is the in-app surface for the user's experience.
 * Over-counting would spuriously disable CTAs the user perceives as
 * earned attempts.
 *
 * # SyncDrainer integration
 *
 * The SyncDrainer (E7-002) drains queued LLM calls when the device
 * reconnects. Those calls fire on a different day from when they were
 * enqueued — so we MUST count them on the day they actually fire
 * (not the day they were queued). The drainer calls
 * `recordLlmCall` from its terminal-success path with `nowMs = now()`,
 * which uses the drain-time clock. See `SyncDrainer.ts` § endpoint
 * dispatch.
 *
 * # UTC ms only
 *
 * The `called_at_ms` column is UTC milliseconds. Default `nowMs` is
 * `Date.now()`. NO date-fns / dayjs / luxon / Temporal — same
 * project-wide E4-002 lock as the watering engine.
 *
 * # Race / atomicity
 *
 * The INSERT is a single statement; SQLite's implicit-transaction
 * atomicity covers it. We do NOT wrap it in
 * `withExclusiveTransactionAsync` because:
 *
 *   - the SyncDrainer already runs row processing inside a claim-style
 *     `withExclusiveTransactionAsync` for the row's `sync_queue` state
 *     transition; nesting another exclusive tx is illegal in SQLite
 *     (no nested transactions on the same connection — see
 *     `queueCrud.ts` header).
 *   - the COUNT-then-render race in `useLlmBudget` is already
 *     bounded by the call-counter pattern; an INSERT that lands
 *     between the SELECT and the React render simply shows up on
 *     the next refresh (AppState 'active', an explicit refresh, or
 *     the next mount).
 *
 * # Best-effort semantics
 *
 * The helper NEVER throws into the caller. A failed INSERT (disk full,
 * connection closed, schema drift) is logged via the optional
 * `onError` hook and swallowed. Reasoning:
 *
 *   - the LLM call already succeeded; we already showed the user the
 *     result; aborting the response handler now would be a worse UX
 *     than under-counting one row.
 *   - the budget meter is a dashboard, not a load-bearing path. A
 *     under-count by one row will self-correct on the next call
 *     because every other call counts.
 *   - throwing from this helper would propagate up into the consult /
 *     diagnose / identify hooks' promise chains and trigger the error
 *     branch on the very call the user just successfully completed.
 *
 * # V1 scope locks honored here
 *
 *   - DO NOT call `/api/budget` — there is no such endpoint.
 *   - DO NOT add a CHECK on the endpoint column — TEXT only.
 *   - DO NOT add an analytics emitter — the SQLite row IS the signal.
 *   - DO NOT add a notification on threshold cross — banner-only UX.
 *   - DO NOT add date-fns / dayjs / luxon / Temporal — UTC ms.
 */

/**
 * Subset of `expo-sqlite`'s `SQLiteDatabase` we need for the INSERT.
 * Same shape as `LlmBudgetExecutor`'s read surface (different method)
 * so callers can inject the same adapter for both reads and writes.
 */
export interface LlmCallWriter {
  runAsync(
    source: string,
    params: ReadonlyArray<string | number>,
  ): Promise<unknown>;
}

/**
 * The four V1 LLM endpoints. Lifted from `QueueKind` in `sync/queueCrud.ts`
 * but redeclared here so this helper doesn't reach into the sync layer
 * (the sync layer reaches into us — the dependency arrow runs one way).
 *
 * If a future ticket adds a fifth endpoint (e.g. `'predict'`), extend this
 * union AND the dispatch tables in `SyncDrainer.ts`. The SQLite column is
 * deliberately TEXT so no schema migration is needed.
 */
export type LlmCallEndpoint = 'identify' | 'diagnose' | 'consult' | 'review';

/** Set form for `validateEndpoint`. Closed-set; defensive against typos. */
const KNOWN_ENDPOINTS: ReadonlySet<LlmCallEndpoint> = new Set([
  'identify',
  'diagnose',
  'consult',
  'review',
]);

export function isLlmCallEndpoint(value: string): value is LlmCallEndpoint {
  return KNOWN_ENDPOINTS.has(value as LlmCallEndpoint);
}

export interface RecordLlmCallOptions {
  /**
   * Override clock. Defaults to `Date.now`. Tests pin a fixed `nowMs` so
   * the row's `called_at_ms` is deterministic. The SyncDrainer passes
   * its own clock-injected `now()` so a queued call drained later
   * counts toward the day it actually fires (NOT the day it was
   * queued — see file header).
   */
  nowMs?: number;
  /**
   * Optional best-effort error sink. Default: `console.warn`. Tests pass
   * a jest.fn() to assert the helper swallows DB errors without
   * throwing. The helper NEVER re-throws — the LLM call already
   * succeeded, and burning the user's just-completed result on a
   * counter-table write is a strictly worse UX than under-counting
   * one row.
   */
  onError?: (err: unknown) => void;
}

const INSERT_SQL =
  'INSERT INTO llm_calls (endpoint, called_at_ms) VALUES (?, ?)';

/**
 * Insert one row into `llm_calls`. Best-effort — never throws into the
 * caller. Returns true if the row was written, false otherwise.
 *
 * @param db        SQLite executor (production: `await openDb()`; tests:
 *                  better-sqlite3 adapter or jest.fn).
 * @param endpoint  One of `'identify' | 'diagnose' | 'consult' | 'review'`.
 *                  Validated here so a typo at the call site doesn't
 *                  ship a row no future analytics could trust.
 * @param options   `nowMs` override (defaults to `Date.now`); `onError`
 *                  override (defaults to `console.warn`).
 */
export async function recordLlmCall(
  db: LlmCallWriter,
  endpoint: LlmCallEndpoint,
  options: RecordLlmCallOptions = {},
): Promise<boolean> {
  if (!isLlmCallEndpoint(endpoint)) {
    // Defense-in-depth: the type narrows callers to the union, but a
    // call from JS land (or a future stringly-typed call site) could
    // still reach here. Drop the row rather than insert garbage.
    const onError = options.onError ?? defaultOnError;
    onError(
      new Error(
        `recordLlmCall: refusing to insert unknown endpoint '${String(endpoint)}'`,
      ),
    );
    return false;
  }

  const calledAtMs =
    options.nowMs !== undefined ? options.nowMs : Date.now();

  try {
    await db.runAsync(INSERT_SQL, [endpoint, calledAtMs]);
    return true;
  } catch (err) {
    const onError = options.onError ?? defaultOnError;
    onError(err);
    return false;
  }
}

/**
 * Predicate: does this `ApiResult` represent a terminal-success that
 * should bump the budget meter? Pure function; lifted out of the hooks
 * so the four LLM hooks + the SyncDrainer all read from one source of
 * truth.
 *
 * # Locked taxonomy — terminal-success ONLY (codex E11-006 P1)
 *
 * The first WIP iteration of this file used a broader "consumed
 * upstream quota" policy that recorded on `parse_error`,
 * `layer1_reject`, `low_confidence`, and `server` because the provider
 * had billed those calls. That over-counts:
 *
 *   - `server` (5xx / 429) is RETRYABLE: the row is rescheduled by
 *     the SyncDrainer and fires again. A row that 5xxes 3 times before
 *     succeeding would burn 4 budget slots for 1 user-perceived
 *     attempt.
 *   - `parse_error` / `layer1_reject` / `low_confidence` are surfaces
 *     where the user gets NO LLM result (the parse fails or the router
 *     rejects). Counting them against the daily budget would gate a
 *     user out of the app on the strength of broken responses they
 *     never saw — and the upstream eval / parser fix is the right
 *     remediation, not a soft cap.
 *
 * The locked policy: the budget tracks meter the user *got value
 * from* — not every byte the provider charged for. The OpenRouter
 * free-tier quota is the upstream lock; the local SQLite counter is
 * a UX surface, not a billing audit.
 *
 *   - `ok = true`               → record (success — the user got a result)
 *   - `ok = false` (any kind)   → DO NOT record. The drainer will re-
 *                                 fire `server` rows on schedule;
 *                                 `parse_error` / `layer1_reject` /
 *                                 `low_confidence` / `network` /
 *                                 `timeout` / `queued` all leave the
 *                                 user without a usable result, so
 *                                 they don't burn budget.
 *
 * # Forward-compat
 *
 * Any new `kind` the api-client adds inherits the conservative
 * default: not recorded. A future "billable, terminal, but ok=false"
 * kind (none exists today) would need an explicit plumbing here AND
 * a CHANGELOG-level review of the budget contract — not a silent
 * default-on.
 */
export function shouldRecordLlmCallResult(result: {
  readonly ok: boolean;
  readonly kind?: string;
}): boolean {
  // Terminal-success only. See header for the rationale on why we
  // narrowed from "consumed quota" to "user-perceived success."
  return result.ok === true;
}

function defaultOnError(err: unknown): void {
  // Best-effort: surface to the dev console without bubbling. The error
  // path here is "the budget counter row didn't write" — an under-count
  // by one, not a user-visible defect. Routing this to a Sentry-style
  // emitter is a post-V1 concern (V1 lock: no analytics emitter).
  // eslint-disable-next-line no-console
  console.warn('[recordLlmCall] insert failed; continuing without counting', err);
}
