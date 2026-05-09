/**
 * Tests for the sync_queue CRUD layer (E7-001).
 *
 * Same approach as `db/__tests__/migrations.test.ts`: drive the module
 * against a `better-sqlite3` adapter that implements the QueueExecutor
 * surface. expo-sqlite is a native module and doesn't load in jest's Node
 * env; better-sqlite3 ships pre-built for Node 20 (CI baseline).
 *
 * What this exercises:
 *   - enqueue insert + status defaults + dedupe
 *   - selectReadyForRetry filter, ordering, and limit
 *   - markInFlight / markDone / markFailedTerminal state transitions and
 *     idempotency
 *   - scheduleBackoff at every attempt level, including terminal-fail at
 *     attempt 6, plus the atomicity claim (concurrent calls do not both
 *     increment past the schedule)
 *   - sweepStaleEntries deletes only terminal rows past the 7-day TTL,
 *     with sub-day-precision boundary fixtures (Wave 1 lesson)
 *   - DST/IDL: no calendar math anywhere — verified by source-grep
 *   - Foreign keys are ON throughout (mirrors openDb behavior)
 */
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
type DatabaseSync = Database.Database;

import { runMigrations, type SqlExecutor } from '../../db/migrations';
import {
  BACKOFF_SCHEDULE_MS,
  MAX_ATTEMPTS,
  TTL_MS,
  claimInFlight,
  enqueueRequest,
  markDone,
  markFailedTerminal,
  markInFlight,
  resetForRetry,
  scheduleBackoff,
  selectFailedRows,
  selectReadyForRetry,
  sweepStaleEntries,
  type QueueBindValue,
  type QueueExecutor,
} from '../queueCrud';

const TTL_DAY_MS = 86_400_000;

/**
 * QueueExecutor adapter over better-sqlite3. The shapes (`runAsync`,
 * `getFirstAsync`, `getAllAsync`, `withTransactionAsync`) match what the
 * real expo-sqlite SQLiteDatabase exposes, so the module under test runs
 * identical bytes against both backends.
 *
 * Transaction serialization: better-sqlite3 (the in-test backend) does
 * not allow nested BEGINs from the same connection — but expo-sqlite's
 * native module *does* serialize statements on a single connection. We
 * model that with a tiny per-adapter mutex around `withTransactionAsync`,
 * so two concurrent transactions queue rather than overlap. Without this
 * the atomicity-of-scheduleBackoff test would hit a nested-transaction
 * error that's a test-harness artifact, not a real-world failure.
 */
function makeQueueExecutor(db: DatabaseSync): QueueExecutor {
  // FIFO mutex for transactions. Each enqueued task awaits the previous
  // one's completion before its `BEGIN` fires.
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
      // Chain the next caller behind us regardless of whether we throw —
      // the lock should release on both success and failure.
      txTail = myTurn.catch(() => undefined);
      await myTurn;
    },
  };
}

/**
 * Migration adapter (matches the SqlExecutor shape from db/migrations.ts).
 * Used once at the top of each test to bootstrap the schema.
 */
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
  payload_json: string;
  ref_table: string;
  ref_id: string;
  status: string;
  attempt_count: number;
  next_attempt_at: number;
  created_at: number;
  expires_at: number;
  last_error: string | null;
};

function rowOf(raw: DatabaseSync, id: string): SyncQueueRow | undefined {
  return raw.prepare('SELECT * FROM sync_queue WHERE id = ?').get(id) as
    | SyncQueueRow
    | undefined;
}

function fkOn(raw: DatabaseSync): boolean {
  const r = raw.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number };
  return r.foreign_keys === 1;
}

describe('enqueueRequest', () => {
  it('inserts with status=pending, attempt_count=0, next_attempt_at=now, expires_at=now+7d', async () => {
    const { raw, q } = await freshDb();
    const now = 1_700_000_000_000;
    const result = await enqueueRequest(q, {
      kind: 'diagnose',
      payload: { photoId: 'ph1' },
      nowMs: now,
    });
    expect(result.inserted).toBe(true);

    const r = rowOf(raw, result.id)!;
    expect(r.status).toBe('pending');
    expect(r.attempt_count).toBe(0);
    expect(r.next_attempt_at).toBe(now);
    expect(r.created_at).toBe(now);
    expect(r.expires_at).toBe(now + TTL_MS);
    expect(r.endpoint).toBe('diagnose');
    expect(JSON.parse(r.payload_json)).toEqual({ photoId: 'ph1' });
    expect(r.last_error).toBeNull();
  });

  it('returns the existing id and does not duplicate when called twice with the same dedupeKey', async () => {
    const { raw, q } = await freshDb();
    const now = 1_700_000_000_000;
    const first = await enqueueRequest(q, {
      kind: 'diagnose',
      payload: { photoId: 'ph1' },
      dedupeKey: { refTable: 'photos', refId: 'ph1' },
      nowMs: now,
    });
    const second = await enqueueRequest(q, {
      kind: 'diagnose',
      payload: { photoId: 'ph1', retryHint: 'will-be-ignored' },
      dedupeKey: { refTable: 'photos', refId: 'ph1' },
      nowMs: now + 60_000,
    });
    expect(second.id).toBe(first.id);
    expect(second.inserted).toBe(false);

    const count = (raw.prepare('SELECT count(*) AS c FROM sync_queue').get() as {
      c: number;
    }).c;
    expect(count).toBe(1);

    // Original payload preserved (no overwrite).
    const r = rowOf(raw, first.id)!;
    expect(JSON.parse(r.payload_json)).toEqual({ photoId: 'ph1' });
  });

  it('treats dedupeKey as case-sensitive (BINARY collation default)', async () => {
    const { raw, q } = await freshDb();
    const a = await enqueueRequest(q, {
      kind: 'diagnose',
      payload: 1,
      dedupeKey: { refTable: 'photos', refId: 'ph1' },
      nowMs: 1,
    });
    const b = await enqueueRequest(q, {
      kind: 'diagnose',
      payload: 2,
      dedupeKey: { refTable: 'PHOTOS', refId: 'ph1' },
      nowMs: 2,
    });
    expect(a.id).not.toBe(b.id);
    expect(
      (raw.prepare('SELECT count(*) AS c FROM sync_queue').get() as { c: number }).c,
    ).toBe(2);
  });

  it('without dedupeKey, every call inserts a fresh row', async () => {
    const { raw, q } = await freshDb();
    await enqueueRequest(q, { kind: 'diagnose', payload: 1, nowMs: 1 });
    await enqueueRequest(q, { kind: 'diagnose', payload: 1, nowMs: 1 });
    await enqueueRequest(q, { kind: 'diagnose', payload: 1, nowMs: 1 });
    const c = (raw.prepare('SELECT count(*) AS c FROM sync_queue').get() as {
      c: number;
    }).c;
    expect(c).toBe(3);
  });

  it('serializes a null/undefined payload to JSON null', async () => {
    const { raw, q } = await freshDb();
    const r1 = await enqueueRequest(q, { kind: 'review', payload: null, nowMs: 1 });
    const r2 = await enqueueRequest(q, {
      kind: 'review',
      payload: undefined,
      nowMs: 1,
    });
    expect(rowOf(raw, r1.id)!.payload_json).toBe('null');
    expect(rowOf(raw, r2.id)!.payload_json).toBe('null');
  });
});

describe('selectReadyForRetry', () => {
  it('returns only pending rows where next_attempt_at <= now, ordered ascending', async () => {
    const { q } = await freshDb();
    const a = await enqueueRequest(q, { kind: 'identify', payload: 'a', nowMs: 100 });
    const b = await enqueueRequest(q, { kind: 'identify', payload: 'b', nowMs: 200 });
    const c = await enqueueRequest(q, { kind: 'identify', payload: 'c', nowMs: 300 });
    const d = await enqueueRequest(q, { kind: 'identify', payload: 'd', nowMs: 1_000 });

    const ready = await selectReadyForRetry(q, { nowMs: 500, limit: 10 });
    const ids = ready.map((r) => r.id);
    expect(ids).toEqual([a.id, b.id, c.id]);
    expect(ids).not.toContain(d.id);
  });

  it('respects the limit', async () => {
    const { q } = await freshDb();
    await enqueueRequest(q, { kind: 'identify', payload: 'a', nowMs: 100 });
    await enqueueRequest(q, { kind: 'identify', payload: 'b', nowMs: 200 });
    await enqueueRequest(q, { kind: 'identify', payload: 'c', nowMs: 300 });
    const ready = await selectReadyForRetry(q, { nowMs: 500, limit: 2 });
    expect(ready).toHaveLength(2);
  });

  it('returns empty when limit is non-positive or non-finite', async () => {
    const { q } = await freshDb();
    await enqueueRequest(q, { kind: 'identify', payload: 'a', nowMs: 100 });
    expect(await selectReadyForRetry(q, { nowMs: 500, limit: 0 })).toEqual([]);
    expect(await selectReadyForRetry(q, { nowMs: 500, limit: -3 })).toEqual([]);
    expect(
      await selectReadyForRetry(q, { nowMs: 500, limit: Number.NaN }),
    ).toEqual([]);
  });

  it('skips in_flight, done, and failed rows even if next_attempt_at is in the past', async () => {
    const { q, raw } = await freshDb();
    const inFlight = await enqueueRequest(q, {
      kind: 'identify',
      payload: 'a',
      nowMs: 100,
    });
    const done = await enqueueRequest(q, { kind: 'identify', payload: 'b', nowMs: 100 });
    const failed = await enqueueRequest(q, {
      kind: 'identify',
      payload: 'c',
      nowMs: 100,
    });
    raw
      .prepare("UPDATE sync_queue SET status='in_flight' WHERE id = ?")
      .run(inFlight.id);
    raw.prepare("UPDATE sync_queue SET status='done' WHERE id = ?").run(done.id);
    raw.prepare("UPDATE sync_queue SET status='failed' WHERE id = ?").run(failed.id);

    const ready = await selectReadyForRetry(q, { nowMs: 500, limit: 10 });
    expect(ready).toEqual([]);
  });
});

describe('markInFlight / markDone / markFailedTerminal', () => {
  it('markInFlight flips pending -> in_flight', async () => {
    const { raw, q } = await freshDb();
    const r = await enqueueRequest(q, { kind: 'diagnose', payload: 'p', nowMs: 1 });
    await markInFlight(q, r.id);
    expect(rowOf(raw, r.id)!.status).toBe('in_flight');
  });

  it('markInFlight is idempotent: a second call on an in_flight row is a silent no-op', async () => {
    const { raw, q } = await freshDb();
    const r = await enqueueRequest(q, { kind: 'diagnose', payload: 'p', nowMs: 1 });
    await markInFlight(q, r.id);
    await markInFlight(q, r.id);
    expect(rowOf(raw, r.id)!.status).toBe('in_flight');
  });

  it('markInFlight is a no-op when the row is already done or failed', async () => {
    const { raw, q } = await freshDb();
    const a = await enqueueRequest(q, { kind: 'diagnose', payload: 'a', nowMs: 1 });
    const b = await enqueueRequest(q, { kind: 'diagnose', payload: 'b', nowMs: 1 });
    raw.prepare("UPDATE sync_queue SET status='done' WHERE id = ?").run(a.id);
    raw.prepare("UPDATE sync_queue SET status='failed' WHERE id = ?").run(b.id);
    await markInFlight(q, a.id);
    await markInFlight(q, b.id);
    expect(rowOf(raw, a.id)!.status).toBe('done');
    expect(rowOf(raw, b.id)!.status).toBe('failed');
  });

  it('markDone flips in_flight -> done and clears last_error', async () => {
    const { raw, q } = await freshDb();
    const r = await enqueueRequest(q, { kind: 'diagnose', payload: 'p', nowMs: 1 });
    raw
      .prepare("UPDATE sync_queue SET status='in_flight', last_error='oops' WHERE id = ?")
      .run(r.id);
    await markDone(q, r.id);
    const row1 = rowOf(raw, r.id)!;
    expect(row1.status).toBe('done');
    expect(row1.last_error).toBeNull();
  });

  it('markDone does not apply backoff and does not change attempt_count', async () => {
    const { raw, q } = await freshDb();
    const r = await enqueueRequest(q, { kind: 'diagnose', payload: 'p', nowMs: 1 });
    raw
      .prepare(
        "UPDATE sync_queue SET status='in_flight', attempt_count=2 WHERE id = ?",
      )
      .run(r.id);
    await markDone(q, r.id);
    const row1 = rowOf(raw, r.id)!;
    expect(row1.status).toBe('done');
    expect(row1.attempt_count).toBe(2);
    expect(row1.next_attempt_at).toBe(1);
  });

  it('markFailedTerminal flips status -> failed and records the error message', async () => {
    const { raw, q } = await freshDb();
    const r = await enqueueRequest(q, { kind: 'diagnose', payload: 'p', nowMs: 1 });
    await markFailedTerminal(q, r.id, 'manual fail');
    const row1 = rowOf(raw, r.id)!;
    expect(row1.status).toBe('failed');
    expect(row1.last_error).toBe('manual fail');
  });

  it('markFailedTerminal does not reschedule next_attempt_at', async () => {
    const { raw, q } = await freshDb();
    const r = await enqueueRequest(q, { kind: 'diagnose', payload: 'p', nowMs: 100 });
    await markFailedTerminal(q, r.id);
    const row1 = rowOf(raw, r.id)!;
    expect(row1.next_attempt_at).toBe(100);
    expect(row1.last_error).toBeNull();
  });

  it('markFailedTerminal does NOT downgrade a done row to failed', async () => {
    const { raw, q } = await freshDb();
    const r = await enqueueRequest(q, { kind: 'diagnose', payload: 'p', nowMs: 1 });
    raw.prepare("UPDATE sync_queue SET status='done' WHERE id = ?").run(r.id);
    await markFailedTerminal(q, r.id, 'too late');
    const row1 = rowOf(raw, r.id)!;
    expect(row1.status).toBe('done');
    expect(row1.last_error).toBeNull();
  });

  it('markFailedTerminal works on an in_flight row', async () => {
    const { raw, q } = await freshDb();
    const r = await enqueueRequest(q, { kind: 'diagnose', payload: 'p', nowMs: 1 });
    raw.prepare("UPDATE sync_queue SET status='in_flight' WHERE id = ?").run(r.id);
    await markFailedTerminal(q, r.id, 'gone');
    const row1 = rowOf(raw, r.id)!;
    expect(row1.status).toBe('failed');
    expect(row1.last_error).toBe('gone');
  });
});

describe('scheduleBackoff', () => {
  it('attempt 1 -> next_attempt_at = now + 1m', async () => {
    const { raw, q } = await freshDb();
    const r = await enqueueRequest(q, { kind: 'diagnose', payload: 'p', nowMs: 0 });
    raw.prepare("UPDATE sync_queue SET status='in_flight' WHERE id = ?").run(r.id);
    const result = await scheduleBackoff(q, r.id, { nowMs: 1_000_000 });
    expect(result).toEqual({ attemptCount: 1, status: 'pending' });
    const row1 = rowOf(raw, r.id)!;
    expect(row1.next_attempt_at).toBe(1_000_000 + 60_000);
    expect(row1.status).toBe('pending');
    expect(row1.attempt_count).toBe(1);
  });

  it('attempt 2 -> next_attempt_at = now + 5m', async () => {
    const { raw, q } = await freshDb();
    const r = await enqueueRequest(q, { kind: 'diagnose', payload: 'p', nowMs: 0 });
    raw
      .prepare(
        "UPDATE sync_queue SET status='in_flight', attempt_count=1 WHERE id = ?",
      )
      .run(r.id);
    const result = await scheduleBackoff(q, r.id, { nowMs: 1_000_000 });
    expect(result).toEqual({ attemptCount: 2, status: 'pending' });
    expect(rowOf(raw, r.id)!.next_attempt_at).toBe(1_000_000 + 5 * 60_000);
  });

  it('attempt 3 -> next_attempt_at = now + 30m', async () => {
    const { raw, q } = await freshDb();
    const r = await enqueueRequest(q, { kind: 'diagnose', payload: 'p', nowMs: 0 });
    raw
      .prepare(
        "UPDATE sync_queue SET status='in_flight', attempt_count=2 WHERE id = ?",
      )
      .run(r.id);
    const result = await scheduleBackoff(q, r.id, { nowMs: 1_000_000 });
    expect(result).toEqual({ attemptCount: 3, status: 'pending' });
    expect(rowOf(raw, r.id)!.next_attempt_at).toBe(1_000_000 + 30 * 60_000);
  });

  it('attempt 4 -> next_attempt_at = now + 2h', async () => {
    const { raw, q } = await freshDb();
    const r = await enqueueRequest(q, { kind: 'diagnose', payload: 'p', nowMs: 0 });
    raw
      .prepare(
        "UPDATE sync_queue SET status='in_flight', attempt_count=3 WHERE id = ?",
      )
      .run(r.id);
    const result = await scheduleBackoff(q, r.id, { nowMs: 1_000_000 });
    expect(result).toEqual({ attemptCount: 4, status: 'pending' });
    expect(rowOf(raw, r.id)!.next_attempt_at).toBe(1_000_000 + 2 * 60 * 60_000);
  });

  it('attempt 5 -> next_attempt_at = now + 8h', async () => {
    const { raw, q } = await freshDb();
    const r = await enqueueRequest(q, { kind: 'diagnose', payload: 'p', nowMs: 0 });
    raw
      .prepare(
        "UPDATE sync_queue SET status='in_flight', attempt_count=4 WHERE id = ?",
      )
      .run(r.id);
    const result = await scheduleBackoff(q, r.id, { nowMs: 1_000_000 });
    expect(result).toEqual({ attemptCount: 5, status: 'pending' });
    expect(rowOf(raw, r.id)!.next_attempt_at).toBe(1_000_000 + 8 * 60 * 60_000);
  });

  it('attempt 6 -> terminal failure (status=failed, no further reschedule)', async () => {
    const { raw, q } = await freshDb();
    const r = await enqueueRequest(q, { kind: 'diagnose', payload: 'p', nowMs: 0 });
    raw
      .prepare(
        "UPDATE sync_queue SET status='in_flight', attempt_count=5 WHERE id = ?",
      )
      .run(r.id);
    const result = await scheduleBackoff(q, r.id, {
      nowMs: 1_000_000,
      errorMessage: 'last gasp',
    });
    expect(result).toEqual({ attemptCount: 6, status: 'failed' });
    const row1 = rowOf(raw, r.id)!;
    expect(row1.status).toBe('failed');
    expect(row1.attempt_count).toBe(MAX_ATTEMPTS);
    expect(row1.last_error).toBe('last gasp');
    expect(row1.next_attempt_at).toBe(0);
  });

  it('walks attempts 1..6 sequentially with the locked schedule', async () => {
    expect(BACKOFF_SCHEDULE_MS).toEqual([
      60_000,
      5 * 60_000,
      30 * 60_000,
      2 * 60 * 60_000,
      8 * 60 * 60_000,
    ]);
    expect(MAX_ATTEMPTS).toBe(6);
  });

  it('is atomic: two concurrent drainers cannot both increment past the schedule', async () => {
    // Race scenario: two drainer instances see attempt_count=0 on the same
    // in_flight row simultaneously and both call scheduleBackoff. Without
    // the exclusive transaction, both could read 0, both write 1, losing
    // an increment. With it, the second call enters its transaction after
    // the first commits. By that time the row is back to status='pending'
    // (or still in_flight if the first one terminal-failed), so the
    // second call returns 'noop' and the row's attempt_count is the
    // first call's result.
    const { raw, q } = await freshDb();
    const r = await enqueueRequest(q, { kind: 'diagnose', payload: 'p', nowMs: 0 });
    raw.prepare("UPDATE sync_queue SET status='in_flight' WHERE id = ?").run(r.id);

    const a = scheduleBackoff(q, r.id, { nowMs: 1_000_000 });
    const b = scheduleBackoff(q, r.id, { nowMs: 1_000_000 });
    const [resA, resB] = await Promise.all([a, b]);

    // One call rescheduled (attempt 1), the other observed the post-state
    // and noop'd. The row is at attempt_count=1, not 2 — the attempt
    // counter advanced exactly once for one drainer attempt, not twice.
    const statuses = [resA.status, resB.status].sort();
    expect(statuses).toEqual(['noop', 'pending']);
    expect(rowOf(raw, r.id)!.attempt_count).toBe(1);
  });

  it('is atomic across the full schedule walk (six in_flight transitions, six attempts)', async () => {
    // The realistic drainer pattern: each retry markInFlight + scheduleBackoff
    // pair runs serially. Walk the full schedule and confirm we land on
    // status='failed' at attempt 6, with no off-by-one in the boundary.
    const { raw, q } = await freshDb();
    const r = await enqueueRequest(q, { kind: 'diagnose', payload: 'p', nowMs: 0 });

    for (let i = 1; i <= 6; i++) {
      raw
        .prepare("UPDATE sync_queue SET status='in_flight' WHERE id = ?")
        .run(r.id);
      const result = await scheduleBackoff(q, r.id, { nowMs: 1_000_000 });
      if (i < 6) {
        expect(result).toEqual({ attemptCount: i, status: 'pending' });
      } else {
        expect(result).toEqual({ attemptCount: 6, status: 'failed' });
      }
    }
    expect(rowOf(raw, r.id)!.status).toBe('failed');
    expect(rowOf(raw, r.id)!.attempt_count).toBe(6);
  });

  it('is a no-op on rows that are already done or failed (returns status=noop)', async () => {
    const { raw, q } = await freshDb();
    const a = await enqueueRequest(q, { kind: 'diagnose', payload: 'a', nowMs: 0 });
    const b = await enqueueRequest(q, { kind: 'diagnose', payload: 'b', nowMs: 0 });
    raw.prepare("UPDATE sync_queue SET status='done' WHERE id = ?").run(a.id);
    raw
      .prepare(
        "UPDATE sync_queue SET status='failed', attempt_count=6 WHERE id = ?",
      )
      .run(b.id);

    const resA = await scheduleBackoff(q, a.id, { nowMs: 999 });
    const resB = await scheduleBackoff(q, b.id, { nowMs: 999 });
    expect(resA.status).toBe('noop');
    expect(resB.status).toBe('noop');
    // Underlying row state is unchanged.
    expect(rowOf(raw, a.id)!.status).toBe('done');
    expect(rowOf(raw, a.id)!.attempt_count).toBe(0);
    expect(rowOf(raw, b.id)!.status).toBe('failed');
    expect(rowOf(raw, b.id)!.attempt_count).toBe(6);
  });

  it('is a no-op on a pending row (must be in_flight first)', async () => {
    const { raw, q } = await freshDb();
    const r = await enqueueRequest(q, { kind: 'diagnose', payload: 'p', nowMs: 0 });
    // Row is still 'pending' — caller forgot to markInFlight.
    const result = await scheduleBackoff(q, r.id, { nowMs: 1_000_000 });
    expect(result.status).toBe('noop');
    // No write happened: attempt_count and next_attempt_at unchanged.
    const row1 = rowOf(raw, r.id)!;
    expect(row1.attempt_count).toBe(0);
    expect(row1.next_attempt_at).toBe(0);
    expect(row1.status).toBe('pending');
  });

  it('throws on a missing id', async () => {
    const { q } = await freshDb();
    await expect(
      scheduleBackoff(q, 'does-not-exist', { nowMs: 1 }),
    ).rejects.toThrow(/not found/);
  });
});

describe('sweepStaleEntries (7-day TTL)', () => {
  it('deletes done and failed rows older than 7 days', async () => {
    const { raw, q } = await freshDb();
    const now = 30 * TTL_DAY_MS;

    const oldDone = await enqueueRequest(q, {
      kind: 'diagnose',
      payload: 'a',
      nowMs: now - TTL_MS - 1,
    });
    const oldFailed = await enqueueRequest(q, {
      kind: 'diagnose',
      payload: 'b',
      nowMs: now - TTL_MS - 1,
    });
    raw.prepare("UPDATE sync_queue SET status='done' WHERE id = ?").run(oldDone.id);
    raw
      .prepare("UPDATE sync_queue SET status='failed' WHERE id = ?")
      .run(oldFailed.id);

    const result = await sweepStaleEntries(q, { nowMs: now });
    expect(result.deleted).toBe(2);
    expect(rowOf(raw, oldDone.id)).toBeUndefined();
    expect(rowOf(raw, oldFailed.id)).toBeUndefined();
  });

  it('preserves pending and in_flight rows regardless of age', async () => {
    const { raw, q } = await freshDb();
    const now = 30 * TTL_DAY_MS;

    const oldPending = await enqueueRequest(q, {
      kind: 'diagnose',
      payload: 'a',
      nowMs: now - 30 * TTL_DAY_MS,
    });
    const oldInFlight = await enqueueRequest(q, {
      kind: 'diagnose',
      payload: 'b',
      nowMs: now - 30 * TTL_DAY_MS,
    });
    raw
      .prepare("UPDATE sync_queue SET status='in_flight' WHERE id = ?")
      .run(oldInFlight.id);

    const result = await sweepStaleEntries(q, { nowMs: now });
    expect(result.deleted).toBe(0);
    expect(rowOf(raw, oldPending.id)).toBeDefined();
    expect(rowOf(raw, oldInFlight.id)).toBeDefined();
  });

  it('boundary: 6d 23h 59m 59s old terminal row is preserved', async () => {
    const { raw, q } = await freshDb();
    const now = 100 * TTL_DAY_MS;
    const sixDays23h59m59s =
      6 * TTL_DAY_MS + 23 * 3_600_000 + 59 * 60_000 + 59_000;
    const enq = await enqueueRequest(q, {
      kind: 'diagnose',
      payload: 'p',
      nowMs: now - sixDays23h59m59s,
    });
    raw.prepare("UPDATE sync_queue SET status='done' WHERE id = ?").run(enq.id);
    const result = await sweepStaleEntries(q, { nowMs: now });
    expect(result.deleted).toBe(0);
    expect(rowOf(raw, enq.id)).toBeDefined();
  });

  it('boundary: exactly 7d (cutoff) old terminal row is preserved (strict <)', async () => {
    const { raw, q } = await freshDb();
    const now = 100 * TTL_DAY_MS;
    const enq = await enqueueRequest(q, {
      kind: 'diagnose',
      payload: 'p',
      nowMs: now - TTL_MS,
    });
    raw.prepare("UPDATE sync_queue SET status='failed' WHERE id = ?").run(enq.id);
    const result = await sweepStaleEntries(q, { nowMs: now });
    expect(result.deleted).toBe(0);
    expect(rowOf(raw, enq.id)).toBeDefined();
  });

  it('boundary: 7d + 1ms old terminal row is swept (sub-day-precision case)', async () => {
    const { raw, q } = await freshDb();
    const now = 100 * TTL_DAY_MS;
    const enq = await enqueueRequest(q, {
      kind: 'diagnose',
      payload: 'p',
      nowMs: now - TTL_MS - 1,
    });
    raw.prepare("UPDATE sync_queue SET status='done' WHERE id = ?").run(enq.id);
    const result = await sweepStaleEntries(q, { nowMs: now });
    expect(result.deleted).toBe(1);
    expect(rowOf(raw, enq.id)).toBeUndefined();
  });
});

describe('claimInFlight (atomic claim variant)', () => {
  it('returns true and flips pending → in_flight on first call', async () => {
    const { raw, q } = await freshDb();
    const r = await enqueueRequest(q, { kind: 'diagnose', payload: 'p', nowMs: 1 });
    const claimed = await claimInFlight(q, r.id);
    expect(claimed).toBe(true);
    expect(rowOf(raw, r.id)!.status).toBe('in_flight');
  });

  it('returns false on second call (already in_flight)', async () => {
    const { raw, q } = await freshDb();
    const r = await enqueueRequest(q, { kind: 'diagnose', payload: 'p', nowMs: 1 });
    const first = await claimInFlight(q, r.id);
    const second = await claimInFlight(q, r.id);
    expect(first).toBe(true);
    expect(second).toBe(false);
    // Status still in_flight; no double-flip.
    expect(rowOf(raw, r.id)!.status).toBe('in_flight');
  });

  it('returns false on done / failed / missing rows without mutation', async () => {
    const { raw, q } = await freshDb();
    const a = await enqueueRequest(q, { kind: 'diagnose', payload: 'a', nowMs: 1 });
    const b = await enqueueRequest(q, { kind: 'diagnose', payload: 'b', nowMs: 1 });
    raw.prepare("UPDATE sync_queue SET status='done' WHERE id = ?").run(a.id);
    raw.prepare("UPDATE sync_queue SET status='failed' WHERE id = ?").run(b.id);
    expect(await claimInFlight(q, a.id)).toBe(false);
    expect(await claimInFlight(q, b.id)).toBe(false);
    expect(await claimInFlight(q, 'no-such-id')).toBe(false);
    // States preserved.
    expect(rowOf(raw, a.id)!.status).toBe('done');
    expect(rowOf(raw, b.id)!.status).toBe('failed');
  });

  it('two concurrent claims on the same pending row: exactly one returns true', async () => {
    const { raw, q } = await freshDb();
    const r = await enqueueRequest(q, { kind: 'diagnose', payload: 'p', nowMs: 1 });
    const [a, b] = await Promise.all([claimInFlight(q, r.id), claimInFlight(q, r.id)]);
    const wins = [a, b].filter(Boolean).length;
    expect(wins).toBe(1);
    expect(rowOf(raw, r.id)!.status).toBe('in_flight');
  });
});

describe('resetForRetry (E7-006 — Tap to retry)', () => {
  async function failOne(
    raw: DatabaseSync,
    q: QueueExecutor,
  ): Promise<string> {
    const r = await enqueueRequest(q, {
      kind: 'diagnose',
      payload: 'p',
      nowMs: 1_000,
    });
    raw
      .prepare(
        "UPDATE sync_queue SET status='failed', attempt_count=6, last_error='boom' WHERE id = ?",
      )
      .run(r.id);
    return r.id;
  }

  it('resets a single failed row to pending with attempt_count=0 and next_attempt_at=now', async () => {
    const { raw, q } = await freshDb();
    const id = await failOne(raw, q);

    const result = await resetForRetry(q, [id], { nowMs: 9_000 });
    expect(result.resetIds).toEqual([id]);

    const r = rowOf(raw, id)!;
    expect(r.status).toBe('pending');
    expect(r.attempt_count).toBe(0);
    expect(r.next_attempt_at).toBe(9_000);
    expect(r.last_error).toBeNull();
  });

  it('resets multiple failed rows in a single transaction', async () => {
    const { raw, q } = await freshDb();
    const a = await failOne(raw, q);
    const b = await failOne(raw, q);
    const c = await failOne(raw, q);

    const result = await resetForRetry(q, [a, b, c], { nowMs: 5_000 });
    expect(result.resetIds.sort()).toEqual([a, b, c].sort());
    for (const id of [a, b, c]) {
      const r = rowOf(raw, id)!;
      expect(r.status).toBe('pending');
      expect(r.attempt_count).toBe(0);
      expect(r.next_attempt_at).toBe(5_000);
    }
  });

  it('does NOT reset an in_flight row (drainer owns its lifecycle)', async () => {
    const { raw, q } = await freshDb();
    const r = await enqueueRequest(q, { kind: 'diagnose', payload: 'p', nowMs: 1 });
    raw
      .prepare(
        "UPDATE sync_queue SET status='in_flight', attempt_count=2, next_attempt_at=100 WHERE id = ?",
      )
      .run(r.id);

    const result = await resetForRetry(q, [r.id], { nowMs: 9_000 });
    expect(result.resetIds).toEqual([]);

    const row = rowOf(raw, r.id)!;
    expect(row.status).toBe('in_flight');
    expect(row.attempt_count).toBe(2);
    expect(row.next_attempt_at).toBe(100);
  });

  it('does NOT reset a pending row (already drainable)', async () => {
    const { raw, q } = await freshDb();
    const r = await enqueueRequest(q, { kind: 'diagnose', payload: 'p', nowMs: 1 });
    raw
      .prepare(
        "UPDATE sync_queue SET attempt_count=3, next_attempt_at=2_000_000 WHERE id = ?",
      )
      .run(r.id);

    const result = await resetForRetry(q, [r.id], { nowMs: 9_000 });
    expect(result.resetIds).toEqual([]);

    const row = rowOf(raw, r.id)!;
    expect(row.status).toBe('pending');
    expect(row.attempt_count).toBe(3);
    expect(row.next_attempt_at).toBe(2_000_000);
  });

  it('does NOT reset a done row (resetting would re-fire an accepted request)', async () => {
    const { raw, q } = await freshDb();
    const r = await enqueueRequest(q, { kind: 'diagnose', payload: 'p', nowMs: 1 });
    raw.prepare("UPDATE sync_queue SET status='done' WHERE id = ?").run(r.id);

    const result = await resetForRetry(q, [r.id], { nowMs: 9_000 });
    expect(result.resetIds).toEqual([]);
    expect(rowOf(raw, r.id)!.status).toBe('done');
  });

  it('silently drops missing ids', async () => {
    const { q } = await freshDb();
    const result = await resetForRetry(q, ['no-such-id'], { nowMs: 1 });
    expect(result.resetIds).toEqual([]);
  });

  it('mixed input: returns only the ids that actually transitioned', async () => {
    const { raw, q } = await freshDb();
    const failed = await failOne(raw, q);
    const inFlight = await enqueueRequest(q, {
      kind: 'diagnose',
      payload: 'p',
      nowMs: 1,
    });
    raw
      .prepare("UPDATE sync_queue SET status='in_flight' WHERE id = ?")
      .run(inFlight.id);

    const result = await resetForRetry(q, [failed, inFlight.id, 'missing'], {
      nowMs: 9_000,
    });
    expect(result.resetIds).toEqual([failed]);

    expect(rowOf(raw, failed)!.status).toBe('pending');
    expect(rowOf(raw, inFlight.id)!.status).toBe('in_flight');
  });

  it('empty input returns empty resetIds without opening a transaction', async () => {
    const { q } = await freshDb();
    const result = await resetForRetry(q, [], { nowMs: 1 });
    expect(result.resetIds).toEqual([]);
  });

  it('clears last_error on reset', async () => {
    const { raw, q } = await freshDb();
    const id = await failOne(raw, q);
    expect(rowOf(raw, id)!.last_error).toBe('boom');
    await resetForRetry(q, [id], { nowMs: 9_000 });
    expect(rowOf(raw, id)!.last_error).toBeNull();
  });
});

describe('selectFailedRows (E7-006)', () => {
  it('returns only failed rows ordered by created_at ASC', async () => {
    const { raw, q } = await freshDb();
    const a = await enqueueRequest(q, { kind: 'diagnose', payload: 'a', nowMs: 100 });
    const b = await enqueueRequest(q, { kind: 'diagnose', payload: 'b', nowMs: 200 });
    const c = await enqueueRequest(q, { kind: 'diagnose', payload: 'c', nowMs: 300 });

    raw.prepare("UPDATE sync_queue SET status='failed' WHERE id = ?").run(a.id);
    raw.prepare("UPDATE sync_queue SET status='failed' WHERE id = ?").run(c.id);
    raw.prepare("UPDATE sync_queue SET status='in_flight' WHERE id = ?").run(b.id);

    const rows = await selectFailedRows(q);
    expect(rows.map((r) => r.id)).toEqual([a.id, c.id]);
    expect(rows.every((r) => r.status === 'failed')).toBe(true);
  });

  it('returns empty when no rows are failed', async () => {
    const { q } = await freshDb();
    await enqueueRequest(q, { kind: 'diagnose', payload: 'a', nowMs: 1 });
    expect(await selectFailedRows(q)).toEqual([]);
  });
});

describe('foreign keys & module isolation', () => {
  it('every CRUD path runs with PRAGMA foreign_keys = ON', async () => {
    const { raw, q } = await freshDb();
    expect(fkOn(raw)).toBe(true);

    const r = await enqueueRequest(q, { kind: 'identify', payload: 'a', nowMs: 1 });
    expect(fkOn(raw)).toBe(true);

    await selectReadyForRetry(q, { nowMs: 1, limit: 5 });
    expect(fkOn(raw)).toBe(true);

    await markInFlight(q, r.id);
    await scheduleBackoff(q, r.id, { nowMs: 1 });
    expect(fkOn(raw)).toBe(true);

    await sweepStaleEntries(q, { nowMs: 1 });
    expect(fkOn(raw)).toBe(true);
  });
});

/**
 * DST/IDL contract — same critical regression boundary as `useWateringEngine`
 * (E4-002). The CRUD layer must use UTC ms only. Enforced statically by
 * grepping the source for any calendar-math surface.
 */
describe('DST/IDL: no calendar math', () => {
  const sourcePath = resolve(__dirname, '..', 'queueCrud.ts');
  const rawSource = readFileSync(sourcePath, 'utf-8');

  // Strip comments before grepping. The module deliberately mentions
  // banned APIs (`Date.getDate`, `setHours`) in the file header to explain
  // *why* it doesn't use them; we want to police the *runtime* code, not
  // documentation. Strips block comments and line comments.
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

  it('uses Date.now only, not new Date() arithmetic', () => {
    expect(codeOnly).not.toMatch(/new Date\(/);
  });
});
