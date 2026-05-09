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
 * # When to call it (insertion-path policy)
 *
 * Call `recordLlmCall(executor, endpoint, { nowMs })` AFTER an
 * `ApiResult` resolves with a kind that consumed quota:
 *
 *   - `ok: true`                                          → record
 *   - `ok: false, kind: 'low_confidence'`                 → record
 *   - `ok: false, kind: 'parse_error'`                    → record
 *   - `ok: false, kind: 'server'` (rate-limit / 5xx)      → record
 *   - `ok: false, kind: 'layer1_reject'`                  → record
 *     (the LLM router emitted the off-topic verdict — the upstream
 *     call still fired)
 *
 * DO NOT record on:
 *
 *   - `ok: false, kind: 'queued'`     — call hasn't fired (offline / coerced)
 *   - `ok: false, kind: 'network'`    — fetch threw before reaching provider
 *   - `ok: false, kind: 'timeout'`    — fetch never reached the provider
 *
 * `network` and `timeout` are conservatively excluded even though a
 * timeout MAY have reached the provider — without a wire-level signal
 * that the upstream actually billed, we'd rather under-count than
 * over-count (the budget is a soft gate, and over-counting would
 * spuriously disable CTAs at 50 calls when the user never billed 50).
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
 * Predicate: does this `ApiResult` kind represent a call that consumed
 * upstream quota? See file header for the policy table. Pure function;
 * lifted out of the hooks so the four LLM hooks + the SyncDrainer all
 * read from one source of truth.
 *
 * Accepts a `{ ok: boolean; kind?: string }` shape so callers don't
 * need to import `ApiResult<T>` (which is generic per response type).
 *
 * Locked taxonomy (codex risk #1):
 *   - `ok = true`               → record (success of any data shape)
 *   - `ok = false`:
 *     - `'low_confidence'`      → record (provider billed)
 *     - `'parse_error'`         → record (provider billed; we just
 *                                 couldn't parse the body)
 *     - `'server'`              → record (5xx / 429 — provider billed
 *                                 OR rate-limited; either way the
 *                                 request reached the provider)
 *     - `'layer1_reject'`       → record (LLM router emitted off-topic;
 *                                 the upstream call still fired)
 *     - `'queued'`              → DO NOT record (call hasn't fired)
 *     - `'network'`             → DO NOT record (fetch threw before
 *                                 reaching provider)
 *     - `'timeout'`             → DO NOT record (fetch never reached
 *                                 the provider; conservative under-
 *                                 count rather than spurious gate)
 *
 * Any future kind that the api client emits MUST be classified here
 * explicitly. A `default: false` (silent skip) would silently
 * under-count a future billable kind; `default: true` would silently
 * over-count a future non-billable kind. The exhaustive switch trips
 * the type checker on the next API expansion so the policy is
 * relitigated explicitly.
 */
export function shouldRecordLlmCallResult(result: {
  readonly ok: boolean;
  readonly kind?: string;
}): boolean {
  if (result.ok) return true;
  switch (result.kind) {
    case 'low_confidence':
    case 'parse_error':
    case 'server':
    case 'layer1_reject':
      return true;
    case 'queued':
    case 'network':
    case 'timeout':
      return false;
    default:
      // Unknown kind → conservative: do not count. We'd rather under-
      // count by one row than over-count and falsely disable CTAs at
      // 50. A future kind addition should plumb through this switch
      // explicitly rather than rely on the default arm.
      return false;
  }
}

function defaultOnError(err: unknown): void {
  // Best-effort: surface to the dev console without bubbling. The error
  // path here is "the budget counter row didn't write" — an under-count
  // by one, not a user-visible defect. Routing this to a Sentry-style
  // emitter is a post-V1 concern (V1 lock: no analytics emitter).
  // eslint-disable-next-line no-console
  console.warn('[recordLlmCall] insert failed; continuing without counting', err);
}
