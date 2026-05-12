/**
 * E7-007 — Sync-queue INTEGRATION tests.
 *
 * Black-box, end-to-end coverage of the queue contract across the three
 * layers that V1 ships:
 *
 *   1. `hooks/offlineEnqueue.ts` — the user-facing enqueue surface (E7-004)
 *   2. `sync/queueCrud.ts`        — the SQL persistence layer (E7-001)
 *   3. `sync/SyncDrainer.ts`      — the drainer orchestrator (E7-002)
 *
 * Existing tests cover each layer in isolation. This suite drives them
 * COMPOSED, against a real `better-sqlite3` in-memory database, so the
 * persistence assertions read rows that are actually committed (Wave 3
 * lesson: spy-only assertions don't prove the SQL row landed).
 *
 * What this suite pins beyond the unit tests:
 *
 *   - enqueue, drain, success, row marked done end-to-end
 *   - server failure then backoff then second-pass retry fires
 *   - 429 with retry_after honored to the millisecond
 *   - 429 WITHOUT retry_after falls back to schedule, NOT now+0 (the
 *     storm trap the orchestrator flagged)
 *   - network failure follows the retryable path, NOT terminal
 *   - parse_error / layer1_reject yield terminal failure
 *   - concurrent drain + enqueue against `withExclusiveTransactionAsync`
 *     produces no SQLITE_BUSY and no corruption
 *   - cross-status dedupe semantics: a `done` row does NOT block a
 *     legitimate re-enqueue (the codex E7-004 P1 fix)
 *   - offline path: caller short-circuits drainNow when netInfo says false
 *   - end-to-end: offline enqueue, then drainer drains on reconnect
 *   - DST regression: created_at_ms / next_attempt_at_ms math survives
 *     spring-forward
 */

import Database from 'better-sqlite3';
type DatabaseSync = Database.Database;

import { runMigrations, type SqlExecutor } from '../../db/migrations';
import {
  hashStable,
  safeEnqueue,
  enqueueOffline,
  type OfflineQueueConfig,
} from '../../hooks/offlineEnqueue';
import {
  enqueueRequest,
  type QueueBindValue,
  type QueueExecutor,
} from '../queueCrud';
import { createSyncDrainer } from '../SyncDrainer';
import type { ApiClient, ApiResult } from '../../api';

// Adapters

function makeQueueExecutor(db: DatabaseSync): QueueExecutor {
  // FIFO mutex around BEGIN/COMMIT models expo-sqlite's exclusive
  // transaction serialization. Two concurrent callers see the second
  // wait until the first commits (or rolls back) — same shape the
  // production driver promises.
  let txTail: Promise<void> = Promise.resolve();
  return {
    async runAsync(source: string, params: QueueBindValue[]) {
      db.prepare(source).run(...params);
    },
    async getFirstAsync<T>(source: string, params: QueueBindValue[]): Promise<T | null> {
      const r = db.prepare(source).get(...params) as T | undefined;
      return r ?? null;
    },
    async getAllAsync<T>(source: string, params: QueueBindValue[]): Promise<T[]> {
      return db.prepare(source).all(...params) as T[];
    },
    async withExclusiveTransactionAsync(task) {
      const myTurn = txTail.then(async () => {
        db.exec('BEGIN IMMEDIATE');
        try {
          await task();
          db.exec('COMMIT');
        } catch (err) {
          db.exec('ROLLBACK');
          throw err;
        }
      });
      txTail = myTurn.catch(() => undefined);
      await myTurn;
    },
  };
}

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

async function freshDb(): Promise<{ raw: DatabaseSync; q: QueueExecutor }> {
  const raw = new Database(':memory:');
  raw.exec('PRAGMA foreign_keys = ON');
  await runMigrations(makeMigrationAdapter(raw));
  return { raw, q: makeQueueExecutor(raw) };
}

interface QueueRowSnapshot {
  id: string;
  endpoint: string;
  payload_json: string;
  ref_table: string;
  ref_id: string;
  status: string;
  attempt_count: number;
  next_attempt_at: number;
  created_at: number;
  expires_at: number;
  last_error: string | null;
}

function readAllRows(raw: DatabaseSync): QueueRowSnapshot[] {
  return raw
    .prepare(
      'SELECT id, endpoint, payload_json, ref_table, ref_id, status, ' +
        'attempt_count, next_attempt_at, created_at, expires_at, last_error ' +
        'FROM sync_queue ORDER BY created_at ASC, id ASC',
    )
    .all() as QueueRowSnapshot[];
}

function readRow(raw: DatabaseSync, id: string): QueueRowSnapshot | undefined {
  return raw
    .prepare(
      'SELECT id, endpoint, payload_json, ref_table, ref_id, status, ' +
        'attempt_count, next_attempt_at, created_at, expires_at, last_error ' +
        'FROM sync_queue WHERE id = ?',
    )
    .get(id) as QueueRowSnapshot | undefined;
}

// Mock API client

type Endpoint = 'identify' | 'diagnose' | 'consult' | 'review';

type ScriptedOutcome =
  | { kind: 'success'; data?: unknown }
  | { kind: 'network' }
  | { kind: 'timeout' }
  | { kind: 'server'; message?: string }
  | { kind: '429'; retryAfterSeconds?: number }
  | { kind: 'parse_error' }
  | { kind: 'layer1_reject'; message?: string }
  | { kind: 'queued' };

function toApiResult(o: ScriptedOutcome): ApiResult<unknown> {
  switch (o.kind) {
    case 'success':
      return { ok: true, data: o.data ?? { ok: true } };
    case 'network':
      return { ok: false, kind: 'network' };
    case 'timeout':
      return { ok: false, kind: 'timeout' };
    case 'server':
      return o.message
        ? { ok: false, kind: 'server', message: o.message }
        : { ok: false, kind: 'server' };
    case '429':
      // 429 without retry_after: omit the property entirely so the
      // drainer's `Number.isFinite(result.retry_after)` falls through
      // to the retryable branch (the `?? 0` storm trap test pins this).
      if (o.retryAfterSeconds === undefined) {
        return { ok: false, kind: 'server' };
      }
      return { ok: false, kind: 'server', retry_after: o.retryAfterSeconds };
    case 'parse_error':
      return { ok: false, kind: 'parse_error' };
    case 'layer1_reject':
      return o.message
        ? { ok: false, kind: 'layer1_reject', message: o.message }
        : { ok: false, kind: 'layer1_reject' };
    case 'queued':
      return { ok: false, kind: 'queued' };
  }
}

interface MockApi {
  client: ApiClient;
  calls: Array<{ endpoint: Endpoint; payload: unknown }>;
  script(endpoint: Endpoint, o: ScriptedOutcome): void;
  setDelay(ms: number): void;
}

function makeMockApi(): MockApi {
  const queues: Record<Endpoint, ScriptedOutcome[]> = {
    identify: [],
    diagnose: [],
    consult: [],
    review: [],
  };
  const calls: MockApi['calls'] = [];
  let delayMs = 0;

  async function dispatch(endpoint: Endpoint, payload: unknown): Promise<ApiResult<unknown>> {
    calls.push({ endpoint, payload });
    if (delayMs > 0) {
      await new Promise<void>((r) => setTimeout(r, delayMs));
    }
    const next = queues[endpoint].shift();
    return toApiResult(next ?? { kind: 'success' });
  }

  const client: ApiClient = {
    identify: (input) => dispatch('identify', input) as Promise<ApiResult<never>>,
    diagnose: (input) => dispatch('diagnose', input) as Promise<ApiResult<never>>,
    consult: (input) => dispatch('consult', input) as Promise<ApiResult<never>>,
    review: (input) => dispatch('review', input) as Promise<ApiResult<never>>,
    weather: (input) => dispatch('identify' as Endpoint, input) as Promise<ApiResult<never>>,
  };

  return {
    client,
    calls,
    script(endpoint, o) {
      queues[endpoint].push(o);
    },
    setDelay(ms) {
      delayMs = ms;
    },
  };
}

// NetInfo-shaped probe

interface NetInfoLike {
  isConnected: () => Promise<boolean> | boolean;
}

function makeNetInfo(initial: boolean): NetInfoLike & { set(v: boolean): void } {
  let online = initial;
  return {
    isConnected: () => online,
    set(v: boolean) {
      online = v;
    },
  };
}

// 1) Enqueue -> drain -> success -> row marked done

describe('integration — enqueue then drain then success', () => {
  it('marks the row done after a successful drain', async () => {
    const { raw, q } = await freshDb();
    const api = makeMockApi();
    const drainer = createSyncDrainer({ db: q, apiClient: api.client, now: () => 1_000_000 });

    const enq = await enqueueRequest(q, {
      kind: 'consult',
      payload: { note: 'help my fern' },
      nowMs: 1_000_000,
    });
    expect(readRow(raw, enq.id)!.status).toBe('pending');

    api.script('consult', { kind: 'success', data: { ok: true } });

    const summary = await drainer.drainNow();
    expect(summary).toMatchObject({
      processed: 1,
      succeeded: 1,
      rescheduled: 0,
      rateLimited: 0,
      failedTerminal: 0,
      stopped: false,
    });
    expect(api.calls).toHaveLength(1);
    expect(api.calls[0]!.endpoint).toBe('consult');

    const row = readRow(raw, enq.id)!;
    expect(row.status).toBe('done');
    expect(row.last_error).toBeNull();
  });
});

// 2) Server failure -> backoff -> retry

describe('integration — server failure then backoff then second-pass retry', () => {
  it('5xx schedules a 1-min backoff; advancing the clock re-drains and re-fires', async () => {
    const { raw, q } = await freshDb();
    const api = makeMockApi();
    let clock = 5_000_000;
    const drainer = createSyncDrainer({
      db: q,
      apiClient: api.client,
      now: () => clock,
    });

    const enq = await enqueueRequest(q, {
      kind: 'consult',
      payload: 'hi',
      nowMs: clock,
    });

    // First pass: 5xx -> retryable. Row stays pending; attempt_count=1;
    // next_attempt_at = now + 60_000 (locked schedule slot 1).
    api.script('consult', { kind: 'server', message: 'down' });
    const first = await drainer.drainNow();
    expect(first.rescheduled).toBe(1);
    expect(first.succeeded).toBe(0);
    const afterFirst = readRow(raw, enq.id)!;
    expect(afterFirst.status).toBe('pending');
    expect(afterFirst.attempt_count).toBe(1);
    expect(afterFirst.next_attempt_at).toBe(5_000_000 + 60_000);
    expect(afterFirst.last_error).toBe('down');

    // Before the schedule slot elapses, drain is a no-op — the row is
    // still pending but selectReadyForRetry only picks rows whose
    // next_attempt_at <= now.
    clock = 5_000_000 + 30_000;
    const between = await drainer.drainNow();
    expect(between.processed).toBe(0);
    expect(api.calls).toHaveLength(1);

    // Advance past the schedule slot. Second drain re-fires; this time
    // success then done.
    clock = 5_000_000 + 60_000 + 1;
    api.script('consult', { kind: 'success' });
    const second = await drainer.drainNow();
    expect(second.succeeded).toBe(1);
    expect(api.calls).toHaveLength(2);
    expect(readRow(raw, enq.id)!.status).toBe('done');
  });
});

// 3) 429 with retry_after honored to ms

describe('integration — 429 with retry_after', () => {
  it('reschedules to now + retry_after_seconds*1000 with attempt_count NOT incremented', async () => {
    const { raw, q } = await freshDb();
    const api = makeMockApi();
    const fixedNow = 7_500_000;
    const drainer = createSyncDrainer({
      db: q,
      apiClient: api.client,
      now: () => fixedNow,
    });

    const enq = await enqueueRequest(q, { kind: 'consult', payload: 'x', nowMs: 0 });
    api.script('consult', { kind: '429', retryAfterSeconds: 42 });

    const summary = await drainer.drainNow();
    expect(summary.rateLimited).toBe(1);
    expect(summary.rescheduled).toBe(0);

    const row = readRow(raw, enq.id)!;
    expect(row.status).toBe('pending');
    expect(row.attempt_count).toBe(0);
    // Exact ms-math: now + N * 1000. NOT now (would mean `?? 0` storm)
    // and NOT now + schedule-slot (would mean retry_after ignored).
    expect(row.next_attempt_at).toBe(fixedNow + 42_000);
    // The retry-after override clears last_error per the
    // rescheduleAfterRateLimit SQL.
    expect(row.last_error).toBeNull();
  });
});

// 4) 429 WITHOUT retry_after — the `?? 0` storm trap

describe('integration — 429 without retry_after (storm trap)', () => {
  it('falls back to exponential-schedule backoff, NOT now+0', async () => {
    // REGRESSION SURFACE: a naive drainer that read
    //   retryAfterMs = result.retry_after ?? 0
    // and applied
    //   next_attempt_at = now + retryAfterMs
    // would set the row up for an immediate-fire retry storm. The
    // drainer's actual behavior is to require
    //   Number.isFinite(result.retry_after)
    // and route the no-retry-after `server` outcome through the
    // retryable schedule (attempt 1 -> +1 min). This test asserts the
    // regression-loud boundary: next_attempt_at MUST advance by at
    // least the schedule slot (60s), and MUST NOT equal `now` (the
    // storm marker).
    const { raw, q } = await freshDb();
    const api = makeMockApi();
    const fixedNow = 9_000_000;
    const drainer = createSyncDrainer({
      db: q,
      apiClient: api.client,
      now: () => fixedNow,
    });

    const enq = await enqueueRequest(q, { kind: 'consult', payload: 'x', nowMs: 0 });
    // 429 without retry-after surfaces from the api-client as
    // `kind: 'server'` with no retry_after property.
    api.script('consult', { kind: '429' /* no retryAfterSeconds */ });

    const summary = await drainer.drainNow();

    const row = readRow(raw, enq.id)!;
    // The storm-trap assertion. If a future change introduces `?? 0`
    // fallback the row would be `next_attempt_at === fixedNow` (or
    // similar) — and this test must fail loudly.
    expect(row.next_attempt_at).not.toBe(fixedNow);
    expect(row.next_attempt_at - fixedNow).toBeGreaterThanOrEqual(60_000);

    // And it should burn a schedule slot — a 5xx without retry-after
    // is a retryable failure, NOT a rate-limit (which would preserve
    // attempt_count).
    expect(row.status).toBe('pending');
    expect(row.attempt_count).toBe(1);
    expect(summary.rescheduled).toBe(1);
    expect(summary.rateLimited).toBe(0);
  });
});

// 5) Network failure -> backoff (retryable, NOT terminal)

describe('integration — network failure during drain', () => {
  it('a network kind reschedules per backoff schedule and stays pending', async () => {
    const { raw, q } = await freshDb();
    const api = makeMockApi();
    const fixedNow = 12_000_000;
    const drainer = createSyncDrainer({
      db: q,
      apiClient: api.client,
      now: () => fixedNow,
    });

    const enq = await enqueueRequest(q, { kind: 'consult', payload: 'x', nowMs: 0 });
    api.script('consult', { kind: 'network' });

    const summary = await drainer.drainNow();
    expect(summary.rescheduled).toBe(1);
    expect(summary.failedTerminal).toBe(0);

    const row = readRow(raw, enq.id)!;
    expect(row.status).toBe('pending');
    expect(row.attempt_count).toBe(1);
    expect(row.next_attempt_at).toBe(fixedNow + 60_000);
  });

  it('a timeout kind is also retryable (not terminal)', async () => {
    const { raw, q } = await freshDb();
    const api = makeMockApi();
    const drainer = createSyncDrainer({ db: q, apiClient: api.client, now: () => 100 });
    const enq = await enqueueRequest(q, { kind: 'consult', payload: 'x', nowMs: 0 });
    api.script('consult', { kind: 'timeout' });
    await drainer.drainNow();
    const row = readRow(raw, enq.id)!;
    expect(row.status).toBe('pending');
    expect(row.attempt_count).toBe(1);
  });
});

// 6) Permanent failure terminates the row

describe('integration — permanent (terminal) failure kinds', () => {
  it('parse_error -> status=failed, no further retries', async () => {
    const { raw, q } = await freshDb();
    const api = makeMockApi();
    const drainer = createSyncDrainer({ db: q, apiClient: api.client });

    const enq = await enqueueRequest(q, { kind: 'consult', payload: 'x', nowMs: 0 });
    api.script('consult', { kind: 'parse_error' });

    const summary = await drainer.drainNow();
    expect(summary.failedTerminal).toBe(1);

    const row = readRow(raw, enq.id)!;
    expect(row.status).toBe('failed');
    // attempt_count is NOT bumped on terminal kinds — the row never
    // gets a second chance, so the schedule's bookkeeping is moot.
    expect(row.attempt_count).toBe(0);

    // Subsequent drains never re-pick this row.
    api.script('consult', { kind: 'success' });
    const second = await drainer.drainNow();
    expect(second.processed).toBe(0);
    expect(readRow(raw, enq.id)!.status).toBe('failed');
  });

  it('layer1_reject -> status=failed with diagnostic message', async () => {
    const { raw, q } = await freshDb();
    const api = makeMockApi();
    const drainer = createSyncDrainer({ db: q, apiClient: api.client });
    const enq = await enqueueRequest(q, { kind: 'consult', payload: 'x', nowMs: 0 });
    api.script('consult', { kind: 'layer1_reject', message: 'off-topic' });
    await drainer.drainNow();
    const row = readRow(raw, enq.id)!;
    expect(row.status).toBe('failed');
    expect(row.last_error).toBe('off-topic');
  });
});

// 7) Concurrent drain + enqueue (real exclusive transaction)

describe('integration — concurrent drain + enqueue', () => {
  it('parallel drain() and enqueueOffline() against the same DB: no SQLITE_BUSY, no orphans', async () => {
    // The serialization contract: `withExclusiveTransactionAsync` is a
    // FIFO mutex around BEGIN IMMEDIATE / COMMIT. Two callers racing
    // see the second one wait until the first commits. The test fires
    // a drain and an enqueueOffline simultaneously via Promise.all and
    // asserts (a) neither throws SQLITE_BUSY, (b) the post-state is
    // consistent — either the drain processed the existing pending row
    // to done AND the new offline-enqueue inserted a fresh pending row,
    // OR the drain found no row and the offline-enqueue inserted one
    // (the drainer's snapshot of `selectReadyForRetry` ran before the
    // new insert committed). Both endings are valid; the contract is
    // "no corruption."
    const { raw, q } = await freshDb();
    const api = makeMockApi();
    // Tiny delay forces the drain's API call to overlap with the
    // enqueueOffline's exclusive transaction so the mutex sees real
    // contention.
    api.setDelay(5);
    const drainer = createSyncDrainer({
      db: q,
      apiClient: api.client,
      now: () => 50_000_000,
    });

    // Pre-existing row the drainer will pick up.
    const existing = await enqueueRequest(q, {
      kind: 'consult',
      payload: 'existing',
      nowMs: 50_000_000,
    });
    api.script('consult', { kind: 'success' });

    // The new enqueue uses a different inputHash so it doesn't dedupe.
    const offlineConfig: OfflineQueueConfig = {
      db: q,
      nowMs: () => 50_000_000,
    };
    const inputHash = hashStable({ note: 'new', plant_context: { id: 'p2' } });

    let drainError: unknown = null;
    let enqError: unknown = null;
    const [drainRes, enqRes] = await Promise.all([
      drainer.drainNow().catch((e) => {
        drainError = e;
        return null;
      }),
      enqueueOffline(offlineConfig, {
        endpoint: 'consult',
        payload: { note: 'new', plant_context: { id: 'p2' } },
        inputHash,
      }).catch((e) => {
        enqError = e;
        return null;
      }),
    ]);

    // No driver-level corruption.
    expect(drainError).toBeNull();
    expect(enqError).toBeNull();
    expect(drainRes).not.toBeNull();
    expect(enqRes).not.toBeNull();
    expect(enqRes!.inserted).toBe(true);

    // Final state must contain both rows. No row left in in_flight
    // (the drainer either completed or never started; either way it
    // doesn't leak in_flight state).
    const all = readAllRows(raw);
    expect(all).toHaveLength(2);
    const existingRow = all.find((r) => r.id === existing.id)!;
    const newRow = all.find((r) => r.id === enqRes!.id)!;
    expect(existingRow.status).toBe('done');
    expect(newRow.status).toBe('pending');
    // The drainer never observed the new row in its batch (the
    // selectReadyForRetry ran before the new INSERT committed under
    // the mutex).
    expect(api.calls.length).toBe(1);
  });

  it('two parallel enqueueOffline calls with the same inputHash collapse to ONE row (TOCTOU defense)', async () => {
    const { raw, q } = await freshDb();
    const offlineConfig: OfflineQueueConfig = { db: q, nowMs: () => 60_000_000 };
    const inputHash = hashStable({ tap: 'twice' });

    const [a, b] = await Promise.all([
      enqueueOffline(offlineConfig, {
        endpoint: 'consult',
        payload: { tap: 'twice' },
        inputHash,
      }),
      enqueueOffline(offlineConfig, {
        endpoint: 'consult',
        payload: { tap: 'twice' },
        inputHash,
      }),
    ]);

    // Exactly one of the two callers got `inserted: true`; the other
    // observed the freshly-committed row and deduped.
    expect([a.inserted, b.inserted].filter(Boolean)).toHaveLength(1);
    expect(readAllRows(raw)).toHaveLength(1);
  });

  it('N=20 concurrent enqueueOffline calls split across 4 hashes: exactly 4 rows persist', async () => {
    // Codex (E7-007 review) flagged that the single-connection
    // better-sqlite3 + JS FIFO mutex can mask a regression from
    // `BEGIN IMMEDIATE` to a non-exclusive `BEGIN` — the test adapter's
    // mutex would still serialize even if the underlying SQL lock mode
    // weakened. This test widens the surface: 20 concurrent
    // enqueueOffline calls split across 4 distinct inputHashes (5
    // calls each). If the live-only dedupe probe is not atomic with
    // the INSERT (the TOCTOU race the exclusive transaction defends
    // against), at least one hash bucket would over-insert. The
    // assertion: exactly 4 pending rows, one per hash. This is the
    // sharpest reachable invariant for an in-process better-sqlite3
    // test — true cross-connection SQLite-BUSY contention would
    // require a real expo-sqlite environment, which V1 does not bring
    // into Jest.
    const { raw, q } = await freshDb();
    const offlineConfig: OfflineQueueConfig = { db: q, nowMs: () => 70_000_000 };

    const hashes = ['alpha', 'beta', 'gamma', 'delta'].map((label) => ({
      label,
      hash: hashStable({ note: label }),
      payload: { note: label },
    }));

    // 20 calls: 5 per hash, interleaved.
    const callPlan: Array<typeof hashes[number]> = [];
    for (let i = 0; i < 5; i++) {
      for (const h of hashes) callPlan.push(h);
    }
    expect(callPlan).toHaveLength(20);

    const results = await Promise.all(
      callPlan.map((h) =>
        enqueueOffline(offlineConfig, {
          endpoint: 'consult',
          payload: h.payload,
          inputHash: h.hash,
        }),
      ),
    );

    // Exactly 4 of the 20 calls were `inserted: true`; the other 16
    // observed a freshly-committed live row and deduped.
    const insertedCount = results.filter((r) => r.inserted).length;
    expect(insertedCount).toBe(4);

    // Exactly 4 rows persisted. Any non-atomic probe-then-insert
    // pattern would surface here as 5+ rows.
    const all = readAllRows(raw);
    expect(all).toHaveLength(4);
    // One row per distinct inputHash.
    const refIdBases = new Set(all.map((r) => r.ref_id.split(':')[0]));
    expect(refIdBases).toEqual(new Set(hashes.map((h) => h.hash)));
  });
});

// 8) Dedupe across re-enqueue after drain success

describe('integration — re-enqueue after drain success (live-only dedupe)', () => {
  it('a done row does NOT block a fresh enqueue of the same (endpoint, inputHash)', async () => {
    // Codex P1 from E7-004: the CRUD's enqueueRequest dedupes across
    // ALL statuses (including done/failed) on (ref_table, ref_id).
    // The hook layer (enqueueOffline) works around this by probing
    // live-only (pending/in_flight) and using a unique-per-attempt
    // refId suffix so a re-submission a week later inserts a NEW row.
    // This test pins that contract end-to-end against the drainer.
    const { raw, q } = await freshDb();
    const api = makeMockApi();
    const t0 = 1_000_000_000;
    const t1 = t0 + 7 * 86_400_000; // a week later
    let clock = t0;
    const drainer = createSyncDrainer({
      db: q,
      apiClient: api.client,
      now: () => clock,
    });

    const offlineCfg: OfflineQueueConfig = { db: q, nowMs: () => clock };
    const payload = { note: 'how to repot' };
    const inputHash = hashStable(payload);

    // 1. First enqueue then pending row.
    const first = await enqueueOffline(offlineCfg, {
      endpoint: 'consult',
      payload,
      inputHash,
    });
    expect(first.inserted).toBe(true);

    // 2. Drain then success then row marked done.
    api.script('consult', { kind: 'success' });
    await drainer.drainNow();
    expect(readRow(raw, first.id)!.status).toBe('done');

    // 3. Advance clock a week. User re-submits the same payload.
    clock = t1;
    const second = await enqueueOffline(offlineCfg, {
      endpoint: 'consult',
      payload,
      inputHash,
    });
    // The crucial assertion: the second enqueue created a NEW row.
    // A naive cross-status dedupe would have returned `inserted:false`
    // and the user would silently lose their re-submission.
    expect(second.inserted).toBe(true);
    expect(second.id).not.toBe(first.id);

    // Two distinct rows: one done (the prior drain), one pending (fresh).
    const all = readAllRows(raw);
    expect(all).toHaveLength(2);
    const done = all.find((r) => r.id === first.id)!;
    const pending = all.find((r) => r.id === second.id)!;
    expect(done.status).toBe('done');
    expect(pending.status).toBe('pending');

    // 4. The drainer picks up the fresh row on the next pass.
    api.script('consult', { kind: 'success' });
    await drainer.drainNow();
    expect(readRow(raw, second.id)!.status).toBe('done');
  });
});

// 9) Drainer skips when offline (netInfo false)

describe('integration — drainer respects netInfo gate (offline)', () => {
  // The SyncDrainer module is netInfo-agnostic by design — wiring lives
  // in E7-003. The "skip drain when offline" contract is therefore
  // expressed at the CALLER (E7-003) side, not inside the drainer.
  // This suite models that wiring: when the caller's
  // `netInfo.isConnected()` returns false, the caller skips drainNow()
  // entirely; rows are untouched.
  it('caller short-circuits drainNow when netInfo says offline; rows untouched', async () => {
    const { raw, q } = await freshDb();
    const api = makeMockApi();
    const drainer = createSyncDrainer({ db: q, apiClient: api.client });
    const netInfo = makeNetInfo(false);

    const enq = await enqueueRequest(q, { kind: 'consult', payload: 'x', nowMs: 0 });
    api.script('consult', { kind: 'success' });

    // Model the E7-003 wake-up wiring: only fire drainNow when online.
    async function wake() {
      if (await netInfo.isConnected()) {
        return drainer.drainNow();
      }
      return null;
    }
    const res = await wake();
    expect(res).toBeNull();
    expect(api.calls).toEqual([]);

    const row = readRow(raw, enq.id)!;
    expect(row.status).toBe('pending');
    expect(row.attempt_count).toBe(0);
  });
});

// 10) Offline-enqueue -> online-drain end-to-end

describe('integration — offline enqueue then online drain end-to-end', () => {
  it('persists offline; then drains and fires the original payload on reconnect', async () => {
    const { raw, q } = await freshDb();
    const api = makeMockApi();
    let clock = 100_000_000;
    const drainer = createSyncDrainer({
      db: q,
      apiClient: api.client,
      now: () => clock,
    });

    // Simulate the request-hook offline path. Pre-flight: netInfo says
    // offline -> no api call, but the hook routes through `safeEnqueue`
    // so the row lands in sync_queue. We drive `safeEnqueue` directly
    // here (no React tree needed) — this is the same code path the
    // hook calls.
    const netInfo = makeNetInfo(false);
    const offlineCfg: OfflineQueueConfig = { db: q, nowMs: () => clock };
    const wireBody = { note: 'why is my fern wilting', plant_context: { id: 'fern-1' } };
    const inputHash = hashStable(wireBody);

    // The hook's actual control flow:
    const online1 = await netInfo.isConnected();
    let enqueueResult: { id: string; inserted: boolean } | null = null;
    if (!online1) {
      enqueueResult = await safeEnqueue(offlineCfg, {
        endpoint: 'consult',
        payload: wireBody,
        inputHash,
      });
    } else {
      throw new Error('test precondition: netInfo should be offline at first');
    }
    expect(enqueueResult).not.toBeNull();
    expect(enqueueResult!.inserted).toBe(true);
    expect(api.calls).toEqual([]); // no api call during offline pre-flight

    const persisted = readRow(raw, enqueueResult!.id)!;
    expect(persisted.status).toBe('pending');
    expect(persisted.endpoint).toBe('consult');
    expect(JSON.parse(persisted.payload_json)).toEqual(wireBody);

    // Reconnect. E7-003 fires drainNow() on online_active transition.
    netInfo.set(true);
    api.script('consult', { kind: 'success' });
    const summary = await drainer.drainNow();
    expect(summary.succeeded).toBe(1);

    // The drainer reconstructed the request from the persisted payload.
    expect(api.calls).toHaveLength(1);
    expect(api.calls[0]!.endpoint).toBe('consult');
    expect(api.calls[0]!.payload).toEqual(wireBody);

    expect(readRow(raw, enqueueResult!.id)!.status).toBe('done');
  });
});

// 11) DST regression on created_at / next_attempt_at (ms math only)

describe('integration — DST spring-forward', () => {
  // The E4-002 critical-regression contract for the watering engine
  // applies equally to the queue: ALL persisted timestamps are UTC ms,
  // never calendar-day math. This test pins that the queue's enqueue +
  // backoff math survive the 2026 spring-forward boundary in
  // America/New_York (02:00 local -> 03:00 local on 2026-03-08). The
  // assertion: enqueueing at that wall-clock instant and advancing the
  // ms-clock by 23h produces the SAME row state as enqueueing at any
  // non-DST instant and advancing by 23h. UTC ms math is timezone-free
  // by construction; this test exists to fail loudly if a future
  // refactor sneaks a `new Date()` or calendar API into the queue path.
  it('DST spring-forward does not perturb created_at_ms / next_attempt_at_ms (ms math only)', async () => {
    // 2026-03-08 01:30 America/New_York (UTC-05 right before the jump)
    // = 2026-03-08 06:30 UTC.
    const dstBoundaryMs = Date.UTC(2026, 2, 8, 6, 30, 0); // month is 0-indexed
    // A non-DST baseline: 2026-04-15 12:00 UTC, well clear of any
    // transition boundary.
    const baselineMs = Date.UTC(2026, 3, 15, 12, 0, 0);

    async function runScenario(t0: number): Promise<{
      pending: QueueRowSnapshot;
      afterBackoff: QueueRowSnapshot;
    }> {
      const { raw, q } = await freshDb();
      const api = makeMockApi();
      let clock = t0;
      const drainer = createSyncDrainer({
        db: q,
        apiClient: api.client,
        now: () => clock,
      });
      const enq = await enqueueRequest(q, {
        kind: 'consult',
        payload: 'x',
        nowMs: t0,
      });
      const pending = readRow(raw, enq.id)!;
      // Server failure -> schedule slot 1 (60_000 ms).
      api.script('consult', { kind: 'server', message: 'down' });
      await drainer.drainNow();
      // Advance the ms-clock by 23 hours (spanning the spring-forward
      // boundary in the DST-boundary scenario). Then drain again.
      clock = t0 + 23 * 60 * 60_000;
      api.script('consult', { kind: 'success' });
      await drainer.drainNow();
      const afterBackoff = readRow(raw, enq.id)!;
      return { pending, afterBackoff };
    }

    const dst = await runScenario(dstBoundaryMs);
    const baseline = await runScenario(baselineMs);

    // The created_at offset from t0 is identical (zero) regardless of
    // whether t0 crossed a DST boundary. UTC ms is a monotonic count
    // of milliseconds since epoch; clock arithmetic doesn't know
    // anything about local DST.
    expect(dst.pending.created_at).toBe(dstBoundaryMs);
    expect(baseline.pending.created_at).toBe(baselineMs);
    expect(dst.pending.created_at - dstBoundaryMs).toBe(
      baseline.pending.created_at - baselineMs,
    );

    // The expires_at offset (TTL = 7 days = 7 * 86_400_000 ms) is
    // identical in BOTH scenarios. A calendar-day implementation would
    // diverge here: 7 calendar-days across a spring-forward is 7*24h -
    // 1h = 167h of wall-clock; against 168h on the baseline. UTC ms
    // doesn't care.
    const expectedTtlMs = 7 * 86_400_000;
    expect(dst.pending.expires_at - dst.pending.created_at).toBe(expectedTtlMs);
    expect(baseline.pending.expires_at - baseline.pending.created_at).toBe(
      expectedTtlMs,
    );

    // Both rows ended up `done` after the 23h advance + retry — the
    // backoff schedule is ms-math, so the 60s slot elapsed identically
    // in both scenarios.
    expect(dst.afterBackoff.status).toBe('done');
    expect(baseline.afterBackoff.status).toBe('done');
  });
});
