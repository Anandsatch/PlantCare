/**
 * Tests for the SyncDrainer (E7-002).
 *
 * Same `better-sqlite3 + QueueExecutor adapter` strategy as the CRUD test —
 * lets us exercise the drainer's state machine end-to-end against the same
 * SQL that production runs on device.
 *
 * What this exercises (22+ tests):
 *   - drainNow with no pending rows
 *   - single + multiple row drains, FIFO ordering
 *   - retryable kinds → scheduleBackoff burns an attempt
 *   - 429 with retry-after → custom delay, attempt count NOT incremented
 *   - terminal kinds (parse_error / layer1_reject / queued / unknown
 *     endpoint / payload-parse-fail)
 *   - mid-drain stop()
 *   - concurrent drainNow → idempotent (one shared promise)
 *   - 7-day TTL sweeper called once on launch, before first drain
 *   - sweeper preserves pending + in_flight rows (CRUD contract mirror)
 *   - stuck in_flight recovery (5 min threshold) on launch
 *   - 5-min threshold sub-day-precision regression
 *   - DST/IDL: source-grep that the drainer uses no calendar APIs
 */
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
type DatabaseSync = Database.Database;

import { runMigrations, type SqlExecutor } from '../../db/migrations';
import {
  enqueueRequest,
  markInFlight,
  type QueueBindValue,
  type QueueExecutor,
} from '../queueCrud';
import {
  STUCK_IN_FLIGHT_THRESHOLD_MS,
  createSyncDrainer,
  type SyncDrainer,
} from '../SyncDrainer';
import type { ApiClient, ApiResult } from '../../api';

const TTL_DAY_MS = 86_400_000;
const TTL_MS = 7 * TTL_DAY_MS;

// Test adapters

function makeQueueExecutor(db: DatabaseSync): QueueExecutor {
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

type SyncQueueRow = {
  id: string;
  endpoint: string;
  status: string;
  attempt_count: number;
  next_attempt_at: number;
  last_error: string | null;
};

function rowOf(raw: DatabaseSync, id: string): SyncQueueRow | undefined {
  return raw
    .prepare(
      'SELECT id, endpoint, status, attempt_count, next_attempt_at, last_error FROM sync_queue WHERE id = ?',
    )
    .get(id) as SyncQueueRow | undefined;
}

// Mock API client

type MockKind =
  | { kind: 'success'; data?: unknown }
  | { kind: 'network' }
  | { kind: 'timeout' }
  | { kind: 'server'; message?: string }
  | { kind: '429'; retryAfterSeconds: number }
  | { kind: 'parse_error' }
  | { kind: 'layer1_reject'; message?: string }
  | { kind: 'low_confidence' }
  | { kind: 'queued' };

function toApiResult(m: MockKind): ApiResult<unknown> {
  switch (m.kind) {
    case 'success':
      return { ok: true, data: m.data ?? { ok: true } };
    case 'network':
      return { ok: false, kind: 'network' };
    case 'timeout':
      return { ok: false, kind: 'timeout' };
    case 'server':
      return m.message
        ? { ok: false, kind: 'server', message: m.message }
        : { ok: false, kind: 'server' };
    case '429':
      return { ok: false, kind: 'server', retry_after: m.retryAfterSeconds };
    case 'parse_error':
      return { ok: false, kind: 'parse_error' };
    case 'layer1_reject':
      return m.message
        ? { ok: false, kind: 'layer1_reject', message: m.message }
        : { ok: false, kind: 'layer1_reject' };
    case 'low_confidence':
      return { ok: false, kind: 'low_confidence' };
    case 'queued':
      return { ok: false, kind: 'queued' };
  }
}

interface MockApi {
  client: ApiClient;
  calls: Array<{ endpoint: string; payload: unknown }>;
  script(endpoint: 'identify' | 'diagnose' | 'consult' | 'review', m: MockKind): void;
  setDelay(ms: number): void;
}

function makeMockApi(): MockApi {
  const queues: Record<string, MockKind[]> = {
    identify: [],
    diagnose: [],
    consult: [],
    review: [],
  };
  const calls: MockApi['calls'] = [];
  let delayMs = 0;

  async function dispatch(endpoint: string, payload: unknown): Promise<ApiResult<unknown>> {
    calls.push({ endpoint, payload });
    if (delayMs > 0) {
      await new Promise<void>((r) => setTimeout(r, delayMs));
    }
    const next = queues[endpoint]?.shift();
    return toApiResult(next ?? { kind: 'success' });
  }

  const client: ApiClient = {
    identify: (input) => dispatch('identify', input) as Promise<ApiResult<never>>,
    diagnose: (input) => dispatch('diagnose', input) as Promise<ApiResult<never>>,
    consult: (input) => dispatch('consult', input) as Promise<ApiResult<never>>,
    review: (input) => dispatch('review', input) as Promise<ApiResult<never>>,
    weather: (input) => dispatch('weather', input) as Promise<ApiResult<never>>,
  };

  return {
    client,
    calls,
    script(endpoint, m) {
      queues[endpoint]!.push(m);
    },
    setDelay(ms) {
      delayMs = ms;
    },
  };
}

// Tests

describe('drainNow — empty queue', () => {
  it('returns immediately with zero work and no api calls', async () => {
    const { q } = await freshDb();
    const api = makeMockApi();
    const drainer = createSyncDrainer({ db: q, apiClient: api.client });
    const summary = await drainer.drainNow();
    expect(summary).toEqual({
      processed: 0,
      succeeded: 0,
      rescheduled: 0,
      rateLimited: 0,
      failedTerminal: 0,
      stopped: false,
    });
    expect(api.calls).toEqual([]);
  });
});

describe('drainNow — single row', () => {
  it('processes a single pending row through markInFlight then api then markDone', async () => {
    const { raw, q } = await freshDb();
    const api = makeMockApi();
    const drainer = createSyncDrainer({ db: q, apiClient: api.client });

    const enq = await enqueueRequest(q, {
      kind: 'consult',
      payload: { plant_id: 'p1', note: 'hi' },
      nowMs: 100,
    });
    api.script('consult', { kind: 'success' });

    const summary = await drainer.drainNow();
    expect(summary.processed).toBe(1);
    expect(summary.succeeded).toBe(1);
    expect(api.calls).toHaveLength(1);
    expect(api.calls[0]!.endpoint).toBe('consult');
    expect(api.calls[0]!.payload).toEqual({ plant_id: 'p1', note: 'hi' });
    expect(rowOf(raw, enq.id)!.status).toBe('done');
  });
});

describe('drainNow — FIFO ordering by next_attempt_at', () => {
  it('processes multiple rows serially in next_attempt_at ASC order', async () => {
    const { q } = await freshDb();
    const api = makeMockApi();
    const drainer = createSyncDrainer({ db: q, apiClient: api.client });

    // Insert deliberately out of insertion order so the SQL ORDER BY is the
    // real test, not insertion order.
    const c = await enqueueRequest(q, { kind: 'consult', payload: { tag: 'C' }, nowMs: 300 });
    const a = await enqueueRequest(q, { kind: 'consult', payload: { tag: 'A' }, nowMs: 100 });
    const b = await enqueueRequest(q, { kind: 'consult', payload: { tag: 'B' }, nowMs: 200 });

    api.script('consult', { kind: 'success' });
    api.script('consult', { kind: 'success' });
    api.script('consult', { kind: 'success' });

    await drainer.drainNow();
    expect(api.calls.map((call) => (call.payload as { tag: string }).tag)).toEqual([
      'A',
      'B',
      'C',
    ]);
    void a;
    void b;
    void c;
  });
});

describe('drainNow — serial processing (one in-flight at a time)', () => {
  it('does not start row N+1 while row N is in flight', async () => {
    const { q } = await freshDb();
    const api = makeMockApi();
    api.setDelay(20);
    const drainer = createSyncDrainer({ db: q, apiClient: api.client });

    await enqueueRequest(q, { kind: 'consult', payload: { i: 1 }, nowMs: 100 });
    await enqueueRequest(q, { kind: 'consult', payload: { i: 2 }, nowMs: 200 });
    api.script('consult', { kind: 'success' });
    api.script('consult', { kind: 'success' });

    const drainPromise = drainer.drainNow();
    await new Promise<void>((r) => setTimeout(r, 5));
    expect(api.calls.length).toBe(1);
    await drainPromise;
    expect(api.calls.length).toBe(2);
  });
});

describe('drainNow — retryable error path', () => {
  it('network error triggers scheduleBackoff to attempt 1 (1m delay)', async () => {
    const { raw, q } = await freshDb();
    const api = makeMockApi();
    const fixedNow = 10_000_000;
    const drainer = createSyncDrainer({
      db: q,
      apiClient: api.client,
      now: () => fixedNow,
    });

    const enq = await enqueueRequest(q, { kind: 'consult', payload: 1, nowMs: 0 });
    api.script('consult', { kind: 'network' });

    const summary = await drainer.drainNow();
    expect(summary.rescheduled).toBe(1);
    expect(summary.failedTerminal).toBe(0);
    const row = rowOf(raw, enq.id)!;
    expect(row.status).toBe('pending');
    expect(row.attempt_count).toBe(1);
    expect(row.next_attempt_at).toBe(fixedNow + 60_000);
  });

  it('timeout is retryable and burns one attempt', async () => {
    const { raw, q } = await freshDb();
    const api = makeMockApi();
    const drainer = createSyncDrainer({ db: q, apiClient: api.client, now: () => 1_000 });
    const enq = await enqueueRequest(q, { kind: 'consult', payload: 1, nowMs: 0 });
    api.script('consult', { kind: 'timeout' });
    await drainer.drainNow();
    expect(rowOf(raw, enq.id)!.attempt_count).toBe(1);
    expect(rowOf(raw, enq.id)!.status).toBe('pending');
  });

  it('server 5xx (no retry-after) is retryable', async () => {
    const { raw, q } = await freshDb();
    const api = makeMockApi();
    const drainer = createSyncDrainer({ db: q, apiClient: api.client, now: () => 1_000 });
    const enq = await enqueueRequest(q, { kind: 'consult', payload: 1, nowMs: 0 });
    api.script('consult', { kind: 'server', message: 'down' });
    await drainer.drainNow();
    expect(rowOf(raw, enq.id)!.attempt_count).toBe(1);
    expect(rowOf(raw, enq.id)!.last_error).toBe('down');
  });

  it('after 5 retryable failures, the 6th attempt terminal-fails', async () => {
    const { raw, q } = await freshDb();
    const api = makeMockApi();
    let clock = 0;
    const drainer = createSyncDrainer({ db: q, apiClient: api.client, now: () => clock });
    const enq = await enqueueRequest(q, { kind: 'consult', payload: 1, nowMs: 0 });

    for (let i = 1; i <= 6; i++) {
      api.script('consult', { kind: 'network' });
      clock += TTL_DAY_MS;
      await drainer.drainNow();
    }
    const row = rowOf(raw, enq.id)!;
    expect(row.status).toBe('failed');
    expect(row.attempt_count).toBe(6);
  });
});

describe('drainNow — 429 retry-after override', () => {
  it('429 with retry_after uses custom delay; attempt_count NOT incremented', async () => {
    const { raw, q } = await freshDb();
    const api = makeMockApi();
    const fixedNow = 5_000_000;
    const drainer = createSyncDrainer({
      db: q,
      apiClient: api.client,
      now: () => fixedNow,
    });
    const enq = await enqueueRequest(q, { kind: 'consult', payload: 1, nowMs: 0 });
    api.script('consult', { kind: '429', retryAfterSeconds: 90 });

    const summary = await drainer.drainNow();
    expect(summary.rateLimited).toBe(1);
    expect(summary.rescheduled).toBe(0);

    const row = rowOf(raw, enq.id)!;
    expect(row.status).toBe('pending');
    expect(row.attempt_count).toBe(0);
    expect(row.next_attempt_at).toBe(fixedNow + 90_000);
    expect(row.last_error).toBeNull();
  });

  it('multiple 429s in a row never advance attempt_count up to the consecutive cap', async () => {
    const { raw, q } = await freshDb();
    const api = makeMockApi();
    let clock = 0;
    // Use a large cap so the test exercises the no-attempt-burn path
    // without tripping the demotion (which is exercised separately).
    const drainer = createSyncDrainer({
      db: q,
      apiClient: api.client,
      now: () => clock,
      maxConsecutiveRateLimits: 100,
    });
    const enq = await enqueueRequest(q, { kind: 'consult', payload: 1, nowMs: 0 });

    for (let i = 0; i < 10; i++) {
      api.script('consult', { kind: '429', retryAfterSeconds: 1 });
      clock += 60_000;
      await drainer.drainNow();
    }
    expect(rowOf(raw, enq.id)!.attempt_count).toBe(0);
    expect(rowOf(raw, enq.id)!.status).toBe('pending');
  });

  it('after MAX_CONSECUTIVE_RATE_LIMITS hits, drainer demotes to schedule (burns an attempt)', async () => {
    // Defense against a 5xx-with-Retry-After loop that the api-client
    // currently surfaces as `server + retry_after`, identical to a
    // true 429 (codex P2 from E7-002 review). After the configured
    // cap, the (cap+1)th rate-limit response routes through
    // scheduleBackoff and the row's attempt_count advances, so a
    // misbehaving backend can no longer pin the row in pending forever.
    const { raw, q } = await freshDb();
    const api = makeMockApi();
    let clock = 0;
    const drainer = createSyncDrainer({
      db: q,
      apiClient: api.client,
      now: () => clock,
      maxConsecutiveRateLimits: 3,
    });
    const enq = await enqueueRequest(q, { kind: 'consult', payload: 1, nowMs: 0 });

    // Three rate-limits within the cap: attempt_count stays 0.
    for (let i = 0; i < 3; i++) {
      api.script('consult', { kind: '429', retryAfterSeconds: 1 });
      clock += 60_000;
      await drainer.drainNow();
    }
    expect(rowOf(raw, enq.id)!.attempt_count).toBe(0);

    // The 4th rate-limit demotes to the schedule.
    api.script('consult', { kind: '429', retryAfterSeconds: 1 });
    clock += 60_000;
    const summary = await drainer.drainNow();
    expect(summary.rescheduled).toBe(1);
    expect(summary.rateLimited).toBe(0);
    const row = rowOf(raw, enq.id)!;
    expect(row.attempt_count).toBe(1);
    expect(row.last_error).toMatch(/rate-limit cap/);
  });

  it('a successful response between rate limits resets the consecutive counter', async () => {
    const { raw, q } = await freshDb();
    const api = makeMockApi();
    let clock = 0;
    const drainer = createSyncDrainer({
      db: q,
      apiClient: api.client,
      now: () => clock,
      maxConsecutiveRateLimits: 2,
    });
    const enq1 = await enqueueRequest(q, { kind: 'consult', payload: 1, nowMs: 0 });
    // First row: 2 rate-limits then success, drains to done.
    api.script('consult', { kind: '429', retryAfterSeconds: 1 });
    clock += 60_000;
    await drainer.drainNow();
    api.script('consult', { kind: '429', retryAfterSeconds: 1 });
    clock += 60_000;
    await drainer.drainNow();
    api.script('consult', { kind: 'success' });
    clock += 60_000;
    await drainer.drainNow();
    expect(rowOf(raw, enq1.id)!.status).toBe('done');

    // Second row, fresh counter (the prior row's success cleared the
    // first row's entry; this one starts fresh too).
    const enq2 = await enqueueRequest(q, { kind: 'consult', payload: 2, nowMs: clock });
    for (let i = 0; i < 2; i++) {
      api.script('consult', { kind: '429', retryAfterSeconds: 1 });
      clock += 60_000;
      await drainer.drainNow();
    }
    // Within cap, attempt_count still 0.
    expect(rowOf(raw, enq2.id)!.attempt_count).toBe(0);
  });
});

describe('drainNow — terminal (non-retryable) kinds', () => {
  it('parse_error triggers markFailedTerminal', async () => {
    const { raw, q } = await freshDb();
    const api = makeMockApi();
    const drainer = createSyncDrainer({ db: q, apiClient: api.client });
    const enq = await enqueueRequest(q, { kind: 'consult', payload: 1, nowMs: 0 });
    api.script('consult', { kind: 'parse_error' });
    const summary = await drainer.drainNow();
    expect(summary.failedTerminal).toBe(1);
    expect(rowOf(raw, enq.id)!.status).toBe('failed');
  });

  it('layer1_reject triggers markFailedTerminal with message', async () => {
    const { raw, q } = await freshDb();
    const api = makeMockApi();
    const drainer = createSyncDrainer({ db: q, apiClient: api.client });
    const enq = await enqueueRequest(q, { kind: 'consult', payload: 1, nowMs: 0 });
    api.script('consult', { kind: 'layer1_reject', message: 'off-topic' });
    await drainer.drainNow();
    const row = rowOf(raw, enq.id)!;
    expect(row.status).toBe('failed');
    expect(row.last_error).toBe('off-topic');
  });

  it('queued (paradoxical) triggers markFailedTerminal with diagnostic message', async () => {
    const { raw, q } = await freshDb();
    const api = makeMockApi();
    const drainer = createSyncDrainer({ db: q, apiClient: api.client });
    const enq = await enqueueRequest(q, { kind: 'consult', payload: 1, nowMs: 0 });
    api.script('consult', { kind: 'queued' });
    await drainer.drainNow();
    const row = rowOf(raw, enq.id)!;
    expect(row.status).toBe('failed');
    expect(row.last_error).toMatch(/queued/);
  });

  it('unknown endpoint string triggers markFailedTerminal without an api call', async () => {
    const { raw, q } = await freshDb();
    const api = makeMockApi();
    const drainer = createSyncDrainer({ db: q, apiClient: api.client });
    const id = 'rogue-row';
    raw
      .prepare(
        `INSERT INTO sync_queue (
          id, endpoint, payload_json, ref_table, ref_id,
          status, attempt_count, next_attempt_at, created_at, expires_at, last_error
        ) VALUES (?, 'unknown_endpoint', '{}', '_no_dedupe', ?, 'pending', 0, 0, 0, ?, NULL)`,
      )
      .run(id, id, TTL_MS);

    await drainer.drainNow();
    expect(api.calls).toEqual([]);
    const row = rowOf(raw, id)!;
    expect(row.status).toBe('failed');
    expect(row.last_error).toMatch(/unknown endpoint/);
  });

  it('payload_json that JSON.parse rejects triggers markFailedTerminal', async () => {
    const { raw, q } = await freshDb();
    const api = makeMockApi();
    const drainer = createSyncDrainer({ db: q, apiClient: api.client });
    const id = 'broken-payload';
    raw
      .prepare(
        `INSERT INTO sync_queue (
          id, endpoint, payload_json, ref_table, ref_id,
          status, attempt_count, next_attempt_at, created_at, expires_at, last_error
        ) VALUES (?, 'consult', 'not-json{{', '_no_dedupe', ?, 'pending', 0, 0, 0, ?, NULL)`,
      )
      .run(id, id, TTL_MS);
    await drainer.drainNow();
    expect(api.calls).toEqual([]);
    expect(rowOf(raw, id)!.status).toBe('failed');
    expect(rowOf(raw, id)!.last_error).toMatch(/payload JSON parse failed/);
  });
});

describe('stop()', () => {
  it('mid-drain stop: current row finishes, next row is not started', async () => {
    const { raw, q } = await freshDb();
    const api = makeMockApi();
    api.setDelay(15);
    const drainer = createSyncDrainer({ db: q, apiClient: api.client });

    const a = await enqueueRequest(q, { kind: 'consult', payload: 'a', nowMs: 100 });
    const b = await enqueueRequest(q, { kind: 'consult', payload: 'b', nowMs: 200 });
    api.script('consult', { kind: 'success' });
    api.script('consult', { kind: 'success' });

    const drainPromise = drainer.drainNow();
    await new Promise<void>((r) => setTimeout(r, 5));
    drainer.stop();
    const summary = await drainPromise;

    expect(summary.stopped).toBe(true);
    expect(summary.processed).toBe(1);
    expect(rowOf(raw, a.id)!.status).toBe('done');
    expect(rowOf(raw, b.id)!.status).toBe('pending');
    expect(api.calls).toHaveLength(1);
  });

  it('stop flag resets between drainNow() calls', async () => {
    const { raw, q } = await freshDb();
    const api = makeMockApi();
    const drainer = createSyncDrainer({ db: q, apiClient: api.client });

    drainer.stop();
    const enq = await enqueueRequest(q, { kind: 'consult', payload: 'x', nowMs: 100 });
    api.script('consult', { kind: 'success' });
    const summary = await drainer.drainNow();
    expect(summary.stopped).toBe(false);
    expect(rowOf(raw, enq.id)!.status).toBe('done');
  });
});

describe('drainNow() — idempotent under concurrent calls', () => {
  it('two parallel drainNow() calls share one promise and run once', async () => {
    const { raw, q } = await freshDb();
    const api = makeMockApi();
    api.setDelay(15);
    const drainer = createSyncDrainer({ db: q, apiClient: api.client });

    const enq = await enqueueRequest(q, { kind: 'consult', payload: 1, nowMs: 0 });
    api.script('consult', { kind: 'success' });

    const a = drainer.drainNow();
    const b = drainer.drainNow();
    expect(a).toBe(b);
    const [resA, resB] = await Promise.all([a, b]);
    expect(resA).toBe(resB);
    expect(api.calls).toHaveLength(1);
    expect(rowOf(raw, enq.id)!.status).toBe('done');
  });

  it('isDraining() true while in-flight, false after settle', async () => {
    const { q } = await freshDb();
    const api = makeMockApi();
    api.setDelay(10);
    const drainer = createSyncDrainer({ db: q, apiClient: api.client });
    await enqueueRequest(q, { kind: 'consult', payload: 1, nowMs: 0 });
    api.script('consult', { kind: 'success' });
    expect(drainer.isDraining()).toBe(false);
    const p = drainer.drainNow();
    expect(drainer.isDraining()).toBe(true);
    await p;
    expect(drainer.isDraining()).toBe(false);
  });
});

describe('runStartupSweep — TTL + stuck recovery', () => {
  it('deletes terminal rows older than 7 days; preserves pending + in_flight', async () => {
    const { raw, q } = await freshDb();
    const api = makeMockApi();
    const now = 30 * TTL_DAY_MS;
    const drainer = createSyncDrainer({ db: q, apiClient: api.client, now: () => now });

    const oldDone = await enqueueRequest(q, {
      kind: 'consult',
      payload: 1,
      nowMs: now - TTL_MS - 1,
    });
    const oldPending = await enqueueRequest(q, {
      kind: 'consult',
      payload: 2,
      nowMs: now - 30 * TTL_DAY_MS,
    });
    const oldInFlight = await enqueueRequest(q, {
      kind: 'consult',
      payload: 3,
      nowMs: now - 30 * TTL_DAY_MS,
    });
    raw.prepare("UPDATE sync_queue SET status='done' WHERE id = ?").run(oldDone.id);
    raw
      .prepare("UPDATE sync_queue SET status='in_flight' WHERE id = ?")
      .run(oldInFlight.id);

    const summary = await drainer.runStartupSweep();
    expect(summary.ttlDeleted).toBe(1);
    expect(rowOf(raw, oldDone.id)).toBeUndefined();
    expect(rowOf(raw, oldPending.id)).toBeDefined();
    expect(rowOf(raw, oldInFlight.id)).toBeDefined();
  });

  it('runs sweep BEFORE first drain (terminal stale rows are gone before drainer sees them)', async () => {
    const { raw, q } = await freshDb();
    const api = makeMockApi();
    const now = 30 * TTL_DAY_MS;
    const drainer = createSyncDrainer({ db: q, apiClient: api.client, now: () => now });

    const oldDone = await enqueueRequest(q, {
      kind: 'consult',
      payload: 1,
      nowMs: now - TTL_MS - 1,
    });
    raw.prepare("UPDATE sync_queue SET status='done' WHERE id = ?").run(oldDone.id);

    await drainer.runStartupSweep();
    const drainSummary = await drainer.drainNow();
    expect(drainSummary.processed).toBe(0);
    expect(rowOf(raw, oldDone.id)).toBeUndefined();
  });

  it('stuck in_flight recovery: a row in_flight > 5 min on launch resets to pending with attempt++', async () => {
    const { raw, q } = await freshDb();
    const api = makeMockApi();
    const now = 1_000_000_000;
    const drainer = createSyncDrainer({ db: q, apiClient: api.client, now: () => now });

    const enq = await enqueueRequest(q, {
      kind: 'consult',
      payload: 1,
      nowMs: now - 60 * 60_000, // 1 hour ago
    });
    await markInFlight(q, enq.id);

    const summary = await drainer.runStartupSweep();
    expect(summary.stuckRecovered).toBe(1);
    const row = rowOf(raw, enq.id)!;
    expect(row.status).toBe('pending');
    expect(row.attempt_count).toBe(1);
    expect(row.last_error).toMatch(/stuck/);
  });

  it('5-min threshold sub-day-precision regression: 4m 59s in_flight is NOT recovered, 5m 1s IS', async () => {
    const { raw, q } = await freshDb();
    const api = makeMockApi();
    const now = 1_000_000_000;
    const drainer = createSyncDrainer({ db: q, apiClient: api.client, now: () => now });

    expect(STUCK_IN_FLIGHT_THRESHOLD_MS).toBe(5 * 60_000);

    const fresh = await enqueueRequest(q, {
      kind: 'consult',
      payload: 1,
      nowMs: now - (5 * 60_000 - 1_000),
    });
    await markInFlight(q, fresh.id);

    const stuck = await enqueueRequest(q, {
      kind: 'consult',
      payload: 2,
      nowMs: now - (5 * 60_000 + 1_000),
    });
    await markInFlight(q, stuck.id);

    const summary = await drainer.runStartupSweep();
    expect(summary.stuckRecovered).toBe(1);
    expect(rowOf(raw, fresh.id)!.status).toBe('in_flight');
    expect(rowOf(raw, stuck.id)!.status).toBe('pending');
  });

  it('stuck recovery respects the schedule: a row stuck on its 5th attempt terminal-fails on recovery', async () => {
    const { raw, q } = await freshDb();
    const api = makeMockApi();
    const now = 1_000_000_000;
    const drainer = createSyncDrainer({ db: q, apiClient: api.client, now: () => now });

    const enq = await enqueueRequest(q, {
      kind: 'consult',
      payload: 1,
      nowMs: now - 60 * 60_000,
    });
    raw
      .prepare("UPDATE sync_queue SET status='in_flight', attempt_count=5 WHERE id = ?")
      .run(enq.id);

    const summary = await drainer.runStartupSweep();
    expect(summary.stuckRecovered).toBe(1);
    expect(rowOf(raw, enq.id)!.status).toBe('failed');
    expect(rowOf(raw, enq.id)!.attempt_count).toBe(6);
  });
});

describe('endpoint dispatch — all four kinds round-trip', () => {
  it.each(['identify', 'diagnose', 'consult', 'review'] as const)(
    'drives %s through the api client',
    async (endpoint) => {
      const { raw, q } = await freshDb();
      const api = makeMockApi();
      const drainer = createSyncDrainer({ db: q, apiClient: api.client });
      const enq = await enqueueRequest(q, {
        kind: endpoint,
        payload: { e: endpoint },
        nowMs: 0,
      });
      api.script(endpoint, { kind: 'success' });
      await drainer.drainNow();
      expect(api.calls.map((c) => c.endpoint)).toEqual([endpoint]);
      expect(rowOf(raw, enq.id)!.status).toBe('done');
    },
  );
});

describe('DST/IDL contract: no calendar math', () => {
  const sourcePath = resolve(__dirname, '..', 'SyncDrainer.ts');
  const rawSource = readFileSync(sourcePath, 'utf-8');
  const codeOnly = rawSource
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

  it('contains no calendar getters/setters', () => {
    const banned = [
      /\.getDate\b/,
      /\.setDate\b/,
      /\.setHours\b/,
      /\.getHours\b/,
      /\.getDay\b/,
      /\.getFullYear\b/,
      /\.setFullYear\b/,
      /\.getMonth\b/,
      /\.toLocaleDateString\b/,
      /\.toLocaleTimeString\b/,
    ];
    for (const re of banned) {
      expect(codeOnly).not.toMatch(re);
    }
  });

  it('uses Date.now / injected clock only, not new Date() arithmetic', () => {
    expect(codeOnly).not.toMatch(/new Date\(/);
  });
});

describe('claim race defense (codex P2)', () => {
  it('drainer skips dispatch when row was claimed by a sibling between select and claim', async () => {
    // Simulate the race: selectReadyForRetry returns a pending row, but
    // before processRow's claimInFlight fires, a sibling drainer (or an
    // E7-006 "Tap to retry" reset, etc.) flips the row's state out from
    // under us. claimInFlight returns false → no API call → summary
    // reflects no work.
    const { raw, q } = await freshDb();
    const api = makeMockApi();
    const drainer = createSyncDrainer({ db: q, apiClient: api.client });

    const enq = await enqueueRequest(q, { kind: 'consult', payload: 1, nowMs: 0 });
    // Pre-flight: a "sibling" already claimed it.
    raw.prepare("UPDATE sync_queue SET status='in_flight' WHERE id = ?").run(enq.id);

    const summary = await drainer.drainNow();
    expect(api.calls).toEqual([]);
    expect(summary.processed).toBe(0);
    // Row remains in_flight (sibling's responsibility); we did nothing.
    expect(rowOf(raw, enq.id)!.status).toBe('in_flight');
  });
});

describe('SyncDrainer factory', () => {
  it('returns the documented surface', async () => {
    const { q } = await freshDb();
    const api = makeMockApi();
    const drainer: SyncDrainer = createSyncDrainer({ db: q, apiClient: api.client });
    expect(typeof drainer.drainNow).toBe('function');
    expect(typeof drainer.runStartupSweep).toBe('function');
    expect(typeof drainer.stop).toBe('function');
    expect(typeof drainer.isDraining).toBe('function');
  });
});
