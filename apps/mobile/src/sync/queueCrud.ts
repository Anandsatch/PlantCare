/**
 * `sync_queue` CRUD layer — typed enqueue / select / update / sweep functions
 * for the offline-mode persistence queue. E7-001.
 *
 * ─── State machine ──────────────────────────────────────────────────────
 *
 *      ┌─ enqueue ─────────────────────────────────────────────────────┐
 *      ▼                                                                │
 *   pending  ── markInFlight ──▶  in_flight  ── markDone ──▶  done      │
 *      ▲                              │                                 │
 *      │                              ├── markFailedTerminal ──▶ failed │
 *      │                              │                                 │
 *      └─── scheduleBackoff ──────────┘  (writes back to pending with a │
 *           bumped attempt_count and a delayed next_attempt_at; on the  │
 *           6th attempt it terminates instead — see schedule below.)    │
 *
 * Status values exhausted: 'pending' | 'in_flight' | 'done' | 'failed'.
 * Note the master plan also drew an `'expired'` terminal status driven by a
 * sweeper. E7-001 rejects that: pending and in_flight rows are *never*
 * mutated by the sweeper. A user offline for 8 days should not lose their
 * queued diagnose; it drains when they reconnect. The sweeper only deletes
 * already-terminal rows ('done' / 'failed') to keep the table small.
 *
 * ─── Backoff schedule (locked, do not deviate) ──────────────────────────
 *
 *   attempt 1 → +1m
 *   attempt 2 → +5m
 *   attempt 3 → +30m
 *   attempt 4 → +2h
 *   attempt 5 → +8h
 *   attempt 6 → markFailedTerminal (no further reschedule)
 *
 * The schedule is the master-plan-locked sequence (1m, 5m, 30m, 2h, 8h,
 * fail). Different sequences (e.g. exponential 2^n, fibonacci) are V1
 * scope locks: REJECT.
 *
 * ─── 7-day TTL sweeper ──────────────────────────────────────────────────
 *
 * `sweepStaleEntries({ nowMs })` deletes rows where:
 *   created_at < nowMs - 7 * 86_400_000
 *   AND status IN ('done', 'failed')
 *
 * Pending and in_flight rows are *preserved regardless of age*. UTC ms
 * arithmetic only — no calendar math, no Date.getDate / setHours / DST
 * traps. The watering engine's E4-002 critical regression contract applies
 * here too: ms math survives DST flips and the international date line.
 *
 * ─── Schema mapping (apps/mobile/src/db/schema.ts § sync_queue) ─────────
 *
 *   id              TEXT PRIMARY KEY
 *   endpoint        TEXT  NOT NULL    ← maps to enqueue's `kind`
 *   payload_json    TEXT  NOT NULL    ← maps to enqueue's `payload`
 *                                       (caller passes any JSON-serializable
 *                                       value; we JSON.stringify here)
 *   ref_table       TEXT  NOT NULL    ← natural dedupe (with ref_id);
 *   ref_id          TEXT  NOT NULL      `dedupeKey` is delivered as the
 *                                       (ref_table, ref_id) tuple. The
 *                                       schema lacks a dedicated
 *                                       `dedupe_key` column on purpose; the
 *                                       master plan locked these two
 *                                       columns as the dedupe surface, and
 *                                       E7-001 must not migrate.
 *   status          TEXT  NOT NULL DEFAULT 'pending'
 *   attempt_count   INTEGER NOT NULL DEFAULT 0
 *   next_attempt_at INTEGER NOT NULL    ← UTC ms
 *   created_at      INTEGER NOT NULL    ← UTC ms; "enqueued at"
 *   expires_at      INTEGER NOT NULL    ← created_at + 7 days, set on enqueue
 *                                         (informational; sweeper uses
 *                                         created_at directly so the policy
 *                                         is one source of truth)
 *   last_error      TEXT
 *
 * Index `idx_queue_drainable ON (status, next_attempt_at) WHERE status='pending'`
 * supports `selectReadyForRetry` cheaply.
 *
 * ─── V1 scope locks (this file only ships the persistence root) ─────────
 *
 *   - DO NOT wire this CRUD into useDiagnoseRequest / future identify /
 *     consult hooks here. Each hook today coerces 'network' → 'queued' at
 *     the UI layer (see `useDiagnoseRequest.ts` header). E7-002 builds the
 *     drainer on top of this CRUD; E7-004 wires the hooks. Pulling
 *     persistence into individual hooks now would tangle two epics.
 *   - DO NOT introduce a job-runner library (queue-promise, p-queue, bull,
 *     etc.). The state machine is small enough to live in raw SQL.
 *   - DO NOT introduce date-fns / dayjs / luxon / Temporal. UTC ms only.
 *   - DO NOT introduce an ORM (Drizzle / Kysely / Prisma). V1 raw SQL only;
 *     mirrors the `usePlants` pattern.
 *
 * ─── Concurrency & atomicity ────────────────────────────────────────────
 *
 * `scheduleBackoff` and `enqueueRequest` (with dedupeKey) both do a
 * read-then-write that must be atomic against concurrent drainers /
 * enqueuers. The CRUD module routes those through
 * `executor.withExclusiveTransactionAsync` — expo-sqlite provides this
 * as a true exclusive (BEGIN-IMMEDIATE-equivalent on a dedicated
 * connection; see node_modules/expo-sqlite/src/SQLiteDatabase.ts). Codex
 * P1 from adversarial review: the non-exclusive `withTransactionAsync`
 * does NOT serialize against other awaiting statements — two drainer
 * instances racing on the same row could observe each other's
 * intermediate state and produce a lost update. The exclusive variant
 * blocks other writers until COMMIT, which closes the race.
 *
 * The other mutations (markInFlight / markDone / markFailedTerminal) are
 * single-statement and do not need an explicit transaction; SQLite gives
 * each statement implicit-transaction atomicity. Their state guards in
 * the WHERE clauses prevent illegal transitions even under concurrent
 * mutation by a sibling drainer.
 */

/**
 * Subset of `expo-sqlite`'s `SQLiteDatabase` this module needs. Mirrors the
 * shape `usePlants`'s `PlantsExecutor` uses, plus a transaction wrapper
 * (`withTransactionAsync`) that the master plan's `runMigrations` adapter
 * already implements. The expo-sqlite `SQLiteDatabase` class is
 * structurally compatible with this interface; the better-sqlite3 test
 * adapter implements the same surface explicitly.
 */
export type QueueBindValue = string | number | null;

/**
 * `runAsync` / `getFirstAsync` / `getAllAsync` mirror expo-sqlite's variadic
 * surface. `withExclusiveTransactionAsync` wraps the block in a true
 * exclusive transaction (expo-sqlite's `withExclusiveTransactionAsync`
 * binds here at production wiring; better-sqlite3 in tests binds with a
 * FIFO mutex around BEGIN/COMMIT to model the same serialization).
 *
 * The interface deliberately omits a non-exclusive `withTransactionAsync`:
 * codex flagged it as racy in expo-sqlite's docs, and the CRUD module
 * never needs the weaker variant. If a future ticket needs it (e.g. a
 * read-only multi-row report), add it then with a clear comment about
 * which use cases it's safe for.
 */
export interface QueueExecutor {
  runAsync(source: string, params: QueueBindValue[]): Promise<unknown>;
  getFirstAsync<T>(source: string, params: QueueBindValue[]): Promise<T | null>;
  getAllAsync<T>(source: string, params: QueueBindValue[]): Promise<T[]>;
  /**
   * Wrap `task` in an exclusive transaction. Other write-attempts against
   * the same database block until this transaction commits or rolls back.
   * The task must not call `withExclusiveTransactionAsync` recursively —
   * SQLite does not support nested transactions on the same connection.
   */
  withExclusiveTransactionAsync(task: () => Promise<void>): Promise<void>;
}

/**
 * Discriminated status values. The schema column is `TEXT`; this type is
 * the closed set the CRUD layer ever writes.
 */
export type QueueStatus = 'pending' | 'in_flight' | 'done' | 'failed';

/**
 * The four endpoints the V1 LLM proxy serves. Kept open at the type level
 * (`string`) at the SQL boundary so future endpoints don't require a
 * migration, but the typed enqueue surface narrows callers to this set so
 * a typo can't ship a row that no drainer knows how to drive.
 */
export type QueueKind = 'identify' | 'diagnose' | 'consult' | 'review';

/**
 * Natural dedupe key. The schema's `(ref_table, ref_id)` tuple. Callers
 * that want idempotent enqueue (e.g. the same diagnose photo) pass this in
 * and we honor it; if a row already exists with the same `(ref_table,
 * ref_id)` we return its id and do not insert. Callers that don't supply
 * one always insert a fresh row.
 *
 * ── dedupeKey edge-cases (locked):
 *   - Case sensitivity: SQLite TEXT columns are case-sensitive by default
 *     (BINARY collation). 'plants' ≠ 'PLANTS'; we don't normalize. Callers
 *     that want case-insensitive dedupe must lowercase before calling.
 *   - Max length: SQLite imposes no practical column length cap; we do not
 *     enforce one either. The natural keys we generate (table name + uuid)
 *     are < 64 bytes.
 *   - NULL: not allowed at the schema level (`ref_table NOT NULL`,
 *     `ref_id NOT NULL`). Callers without a dedupe identity should pass
 *     `undefined` (no dedupe) rather than null fields. We synthesize a
 *     unique sentinel id for the no-dedupe path so the columns are
 *     populated.
 *   - Empty strings: '' is a legal SQLite TEXT value. The CRUD layer treats
 *     empty strings as truthy dedupe identities; if a caller passes
 *     ('plants', '') a second call with the same tuple will be deduped.
 *     Callers with a no-dedupe intent must pass `undefined`, not empty
 *     strings. This is the same shape as
 *     `attempt_count` defaulting to 0 — the layer is conservative.
 */
export interface DedupeKey {
  refTable: string;
  refId: string;
}

/**
 * The persisted row, surfaced to the drainer in `selectReadyForRetry`.
 * Field names mirror the schema columns 1:1 so the boundary is auditable.
 */
export interface QueueRow {
  id: string;
  endpoint: string;
  payload_json: string;
  ref_table: string;
  ref_id: string;
  status: QueueStatus;
  attempt_count: number;
  next_attempt_at: number;
  created_at: number;
  expires_at: number;
  last_error: string | null;
}

/**
 * Backoff schedule indexed by *next* attempt count (the value attempt_count
 * will hold *after* this scheduleBackoff call). attempt 1 → 1 minute;
 * attempt 2 → 5 minutes; etc. Anything beyond index 5 means "no more
 * retries — caller markFailedTerminal."
 *
 * Locked sequence per master plan §"Sync queue state machine". Do not edit
 * without scope review.
 */
const ONE_MINUTE_MS = 60_000;
const ONE_HOUR_MS = 60 * 60_000;
export const BACKOFF_SCHEDULE_MS: readonly number[] = [
  1 * ONE_MINUTE_MS,        // attempt 1 → 1 min
  5 * ONE_MINUTE_MS,        // attempt 2 → 5 min
  30 * ONE_MINUTE_MS,       // attempt 3 → 30 min
  2 * ONE_HOUR_MS,          // attempt 4 → 2 h
  8 * ONE_HOUR_MS,          // attempt 5 → 8 h
] as const;

/** Maximum attempts before terminal failure. */
export const MAX_ATTEMPTS = BACKOFF_SCHEDULE_MS.length + 1; // 6

const TTL_DAY_MS = 86_400_000;
const TTL_DAYS = 7;
export const TTL_MS = TTL_DAYS * TTL_DAY_MS;

const SELECT_COLUMNS =
  'id, endpoint, payload_json, ref_table, ref_id, status, attempt_count, ' +
  'next_attempt_at, created_at, expires_at, last_error';

function generateId(): string {
  // Same approach as usePlants. Hermes (RN 0.74+) and Node 20+ both ship
  // crypto.randomUUID; expo-sqlite tests run under jest-expo / Node 20.
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (!c?.randomUUID) {
    throw new Error('crypto.randomUUID is unavailable; cannot generate sync_queue id');
  }
  return c.randomUUID();
}

export interface EnqueueRequestInput {
  /** Which API the drainer should call. */
  kind: QueueKind;
  /** JSON-serializable body. We JSON.stringify here so callers don't double-encode. */
  payload: unknown;
  /**
   * Optional natural-dedupe identity. If supplied and a row already
   * exists with the same (refTable, refId), this call returns the existing
   * row's id without inserting. Without it, every call inserts a fresh row.
   */
  dedupeKey?: DedupeKey;
  /** Override clock for tests. */
  nowMs?: number;
}

export interface EnqueueResult {
  /** The row id (existing if dedup hit, new otherwise). */
  id: string;
  /** Whether this call inserted a new row (true) or returned an existing one (false). */
  inserted: boolean;
}

/**
 * Enqueue a request. Returns the row id and whether a new row was created.
 *
 * Atomicity: when `dedupeKey` is supplied, the existence-check + insert
 * runs inside a transaction so two concurrent enqueues for the same
 * dedupeKey can't both insert. Without dedupeKey, the call is a single
 * INSERT statement and SQLite's implicit-transaction atomicity covers it.
 */
export async function enqueueRequest(
  db: QueueExecutor,
  input: EnqueueRequestInput,
): Promise<EnqueueResult> {
  const nowMs = input.nowMs ?? Date.now();
  const payloadJson = JSON.stringify(input.payload ?? null);

  if (input.dedupeKey) {
    const refTable = input.dedupeKey.refTable;
    const refId = input.dedupeKey.refId;
    let result: EnqueueResult | null = null;
    await db.withExclusiveTransactionAsync(async () => {
      const existing = await db.getFirstAsync<{ id: string }>(
        'SELECT id FROM sync_queue WHERE ref_table = ? AND ref_id = ? LIMIT 1',
        [refTable, refId],
      );
      if (existing) {
        result = { id: existing.id, inserted: false };
        return;
      }
      const id = generateId();
      await db.runAsync(
        `INSERT INTO sync_queue (
          id, endpoint, payload_json, ref_table, ref_id,
          status, attempt_count, next_attempt_at, created_at, expires_at, last_error
        ) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, NULL)`,
        [id, input.kind, payloadJson, refTable, refId, nowMs, nowMs, nowMs + TTL_MS],
      );
      result = { id, inserted: true };
    });
    // The transaction wrapper guarantees `result` is set before resolving.
    if (!result) {
      throw new Error('enqueueRequest: transaction completed without setting result');
    }
    return result;
  }

  // No-dedupe path: synthesize a unique sentinel ref_table/ref_id so the
  // NOT NULL columns are populated and no two rows collide. Using the row
  // id as ref_id under a fixed sentinel ref_table keeps the natural-dedupe
  // index unambiguous (every no-dedupe row is uniquely keyed) without
  // requiring a schema change.
  const id = generateId();
  await db.runAsync(
    `INSERT INTO sync_queue (
      id, endpoint, payload_json, ref_table, ref_id,
      status, attempt_count, next_attempt_at, created_at, expires_at, last_error
    ) VALUES (?, ?, ?, '_no_dedupe', ?, 'pending', 0, ?, ?, ?, NULL)`,
    [id, input.kind, payloadJson, id, nowMs, nowMs, nowMs + TTL_MS],
  );
  return { id, inserted: true };
}

export interface SelectReadyInput {
  nowMs: number;
  limit: number;
}

/**
 * Returns rows the drainer should attempt now: status='pending' AND
 * next_attempt_at <= nowMs, ordered by next_attempt_at ASC (FIFO among
 * ready rows). The `idx_queue_drainable` partial index in schema.ts
 * supports this exact predicate cheaply.
 */
export async function selectReadyForRetry(
  db: QueueExecutor,
  input: SelectReadyInput,
): Promise<QueueRow[]> {
  if (!Number.isFinite(input.limit) || input.limit <= 0) {
    return [];
  }
  const rows = await db.getAllAsync<QueueRow>(
    `SELECT ${SELECT_COLUMNS}
       FROM sync_queue
      WHERE status = 'pending' AND next_attempt_at <= ?
      ORDER BY next_attempt_at ASC
      LIMIT ?`,
    [input.nowMs, Math.floor(input.limit)],
  );
  return rows;
}

/**
 * Mark a row in_flight. The transition is restricted to pending → in_flight
 * via the WHERE clause; calling on a non-pending row is a silent no-op.
 *
 * Why silent (not throw)? The drainer may retry steering after a partial
 * failure (e.g. native crash mid-flight). On reboot it could try to
 * markInFlight a row that's already done. Throwing here would force the
 * drainer to LEFT-JOIN-style probe state before every transition, which
 * defeats the point of having a CRUD layer. Silent + idempotent is
 * SQLite-idiomatic and matches the master plan's tolerance for retried
 * drainer runs.
 */
export async function markInFlight(
  db: QueueExecutor,
  id: string,
): Promise<void> {
  await db.runAsync(
    "UPDATE sync_queue SET status = 'in_flight' WHERE id = ? AND status = 'pending'",
    [id],
  );
}

/**
 * Mark done. Transition restricted to in_flight → done via the WHERE clause
 * for the same reason as `markInFlight`. A second call is a no-op.
 */
export async function markDone(db: QueueExecutor, id: string): Promise<void> {
  await db.runAsync(
    "UPDATE sync_queue SET status = 'done', last_error = NULL WHERE id = ? AND status = 'in_flight'",
    [id],
  );
}

/**
 * Mark a row terminally failed. No reschedule; the drainer never visits
 * this row again. Optional `errorMessage` is recorded in `last_error` for
 * the UI's "Tap to retry" surface (E7-006).
 *
 * State guard: only transitions from non-terminal states (`pending` /
 * `in_flight`). A `done` row is NOT downgraded to `failed` even if the
 * caller asks for it — that would erase a successful drain. Codex P2 from
 * adversarial review.
 */
export async function markFailedTerminal(
  db: QueueExecutor,
  id: string,
  errorMessage?: string,
): Promise<void> {
  await db.runAsync(
    `UPDATE sync_queue
        SET status = 'failed', last_error = ?
      WHERE id = ? AND status IN ('pending', 'in_flight')`,
    [errorMessage ?? null, id],
  );
}

export interface ScheduleBackoffInput {
  /**
   * Override clock for tests. The schedule offset is added to this. The
   * non-test path passes Date.now() so timezone is irrelevant — UTC ms.
   */
  nowMs?: number;
  errorMessage?: string;
}

export interface ScheduleBackoffResult {
  /**
   * The new attempt_count after the call. 1..MAX_ATTEMPTS-1 means the row
   * is back in pending with a future next_attempt_at; MAX_ATTEMPTS means
   * we exhausted the schedule and the row is now status='failed'.
   */
  attemptCount: number;
  /**
   * Post-call status of the row. `noop` is reported when the call hit a
   * row already in a terminal state (`done` or `failed`) — no write
   * occurred, the row's existing status is preserved. The caller decides
   * what to do; treating it the same as the existing terminal is safe.
   */
  status: 'pending' | 'failed' | 'noop';
}

/**
 * Schedule the next retry for a row that just failed in-flight.
 *
 * State guard: only `in_flight` rows are valid input. The state diagram
 * (master plan §"Sync queue state machine") puts `scheduleBackoff` on the
 * 5xx / network-error edge out of `in_flight`; calling on a `pending` row
 * would silently bump attempt_count without an actual attempt, breaking
 * the schedule's semantics. Codex P2 from adversarial review.
 *
 * Atomic: wraps read + write in `withExclusiveTransactionAsync` so two
 * drainer instances racing on the same row can't both increment
 * attempt_count past the schedule (the exclusive transaction blocks the
 * other writer until COMMIT). Reads attempt_count, computes the next
 * delay from BACKOFF_SCHEDULE_MS, writes back. On the 6th call
 * (attempt_count would become MAX_ATTEMPTS = 6), instead of scheduling
 * we mark the row terminally failed.
 *
 * Idempotency: if the row is already 'done' or 'failed' or has fallen
 * back to 'pending' (because a sibling drainer already rescheduled),
 * this is a no-op and returns `status: 'noop'`. Throws on a missing id.
 */
export async function scheduleBackoff(
  db: QueueExecutor,
  id: string,
  input: ScheduleBackoffInput = {},
): Promise<ScheduleBackoffResult> {
  const nowMs = input.nowMs ?? Date.now();
  const errorMessage = input.errorMessage ?? null;

  let resolved: ScheduleBackoffResult | null = null;

  await db.withExclusiveTransactionAsync(async () => {
    const row = await db.getFirstAsync<{
      attempt_count: number;
      status: QueueStatus;
    }>(
      'SELECT attempt_count, status FROM sync_queue WHERE id = ?',
      [id],
    );
    if (!row) {
      throw new Error(`scheduleBackoff: row ${id} not found`);
    }
    if (row.status !== 'in_flight') {
      // Out-of-state input. Don't reschedule; report no-op so the caller
      // doesn't double-process. This covers 'done' / 'failed' (terminal)
      // as well as 'pending' (some other drainer already rescheduled, or
      // the caller forgot to markInFlight first).
      resolved = { attemptCount: row.attempt_count, status: 'noop' };
      return;
    }

    const nextAttempt = row.attempt_count + 1;
    if (nextAttempt >= MAX_ATTEMPTS) {
      await db.runAsync(
        `UPDATE sync_queue
            SET status = 'failed', attempt_count = ?, last_error = ?
          WHERE id = ?`,
        [nextAttempt, errorMessage, id],
      );
      resolved = { attemptCount: nextAttempt, status: 'failed' };
      return;
    }

    const delayMs = BACKOFF_SCHEDULE_MS[nextAttempt - 1];
    if (delayMs === undefined) {
      throw new Error(`scheduleBackoff: no schedule entry for attempt ${nextAttempt}`);
    }
    const nextAttemptAt = nowMs + delayMs;
    await db.runAsync(
      `UPDATE sync_queue
          SET status = 'pending',
              attempt_count = ?,
              next_attempt_at = ?,
              last_error = ?
        WHERE id = ?`,
      [nextAttempt, nextAttemptAt, errorMessage, id],
    );
    resolved = { attemptCount: nextAttempt, status: 'pending' };
  });

  if (!resolved) {
    throw new Error('scheduleBackoff: transaction completed without setting result');
  }
  return resolved;
}

export interface SweepStaleInput {
  nowMs: number;
}

export interface SweepStaleResult {
  /** Number of rows deleted. */
  deleted: number;
}

/**
 * Delete terminal rows older than 7 days. Pending and in_flight rows are
 * preserved regardless of age — a long-offline user shouldn't lose their
 * queued requests. UTC ms only; no calendar arithmetic.
 *
 * Boundary semantics: a row created at exactly `nowMs - TTL_MS` is
 * preserved (the predicate is strict `<`); a row created 1 ms earlier is
 * swept. The test suite pins both sides of the boundary.
 */
export async function sweepStaleEntries(
  db: QueueExecutor,
  input: SweepStaleInput,
): Promise<SweepStaleResult> {
  const cutoff = input.nowMs - TTL_MS;
  // Count + delete inside the same exclusive transaction so the count
  // can't drift against a concurrent drainer flipping a row's status
  // between the two statements (codex P3 from adversarial review). The
  // pre-count is used because the executor surface is intentionally
  // opaque about `changes()` — expo-sqlite returns it on `runAsync`'s
  // resolution but the better-sqlite3 test adapter would need an extra
  // probe; pre-counting keeps the layer portable.
  let deleted = 0;
  await db.withExclusiveTransactionAsync(async () => {
    const before = await db.getFirstAsync<{ c: number }>(
      `SELECT count(*) AS c
         FROM sync_queue
        WHERE created_at < ? AND status IN ('done', 'failed')`,
      [cutoff],
    );
    await db.runAsync(
      `DELETE FROM sync_queue
        WHERE created_at < ? AND status IN ('done', 'failed')`,
      [cutoff],
    );
    deleted = before?.c ?? 0;
  });
  return { deleted };
}
