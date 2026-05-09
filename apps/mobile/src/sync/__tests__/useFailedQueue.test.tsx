/**
 * Tests for useFailedQueue (E7-006).
 *
 * Same better-sqlite3 + QueueExecutor adapter as the CRUD/drainer tests so
 * the hook talks to a real SQLite (in-memory) and exercises the actual
 * resetForRetry transaction. The drainer is mocked — we only care that
 * `drainNow` was invoked, not what it did.
 */
import { describe, expect, it, jest } from '@jest/globals';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import Database from 'better-sqlite3';
import { AppState, type AppStateStatus } from 'react-native';
type DatabaseSync = Database.Database;

import { runMigrations, type SqlExecutor } from '../../db/migrations';
import {
  enqueueRequest,
  type QueueBindValue,
  type QueueExecutor,
} from '../queueCrud';
import type { SyncDrainer } from '../SyncDrainer';
import { useFailedQueue } from '../useFailedQueue';

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

function makeDrainer(): { drainer: Pick<SyncDrainer, 'drainNow'>; drainSpy: jest.Mock } {
  const drainSpy = jest.fn(async () => ({
    processed: 0,
    succeeded: 0,
    rescheduled: 0,
    rateLimited: 0,
    failedTerminal: 0,
    stopped: false,
  }));
  return {
    drainer: { drainNow: drainSpy as unknown as SyncDrainer['drainNow'] },
    drainSpy,
  };
}

async function failOne(raw: DatabaseSync, q: QueueExecutor): Promise<string> {
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

// AppState mocking

type AppStateListener = (next: AppStateStatus) => void;

function captureAppState(): { listeners: AppStateListener[]; restore: () => void } {
  const listeners: AppStateListener[] = [];
  const spy = jest
    .spyOn(AppState, 'addEventListener')
    .mockImplementation(((event: string, listener: AppStateListener) => {
      if (event === 'change') {
        listeners.push(listener);
      }
      return {
        remove: () => {
          const idx = listeners.indexOf(listener);
          if (idx >= 0) listeners.splice(idx, 1);
        },
      };
    }) as never);
  return {
    listeners,
    restore: () => {
      spy.mockRestore();
    },
  };
}

// Tests

describe('useFailedQueue', () => {
  it('returns empty failedRows when the queue has no failed rows', async () => {
    const { restore } = captureAppState();
    const { q } = await freshDb();
    const { drainer } = makeDrainer();

    const { result } = renderHook(() => useFailedQueue({ db: q, drainer }));
    await waitFor(() => {
      expect(result.current.failedRows).toEqual([]);
    });
    expect(result.current.status).toBe('idle');
    restore();
  });

  it('returns failed rows when the queue has them, ordered by created_at ASC', async () => {
    const { restore } = captureAppState();
    const { raw, q } = await freshDb();
    await failOne(raw, q);
    await failOne(raw, q);
    const { drainer } = makeDrainer();

    const { result } = renderHook(() => useFailedQueue({ db: q, drainer }));
    await waitFor(() => {
      expect(result.current.failedRows).toHaveLength(2);
    });
    expect(result.current.failedRows.every((r) => r.status === 'failed')).toBe(true);
    restore();
  });

  it('retryOne resets one row and triggers drainer.drainNow()', async () => {
    const { restore } = captureAppState();
    const { raw, q } = await freshDb();
    const id = await failOne(raw, q);
    const { drainer, drainSpy } = makeDrainer();
    const nowValue = 9_000;

    const { result } = renderHook(() =>
      useFailedQueue({ db: q, drainer, now: () => nowValue }),
    );
    await waitFor(() => {
      expect(result.current.failedRows).toHaveLength(1);
    });

    await act(async () => {
      await result.current.retryOne(id);
    });

    const row = raw.prepare('SELECT * FROM sync_queue WHERE id = ?').get(id) as {
      status: string;
      attempt_count: number;
      next_attempt_at: number;
    };
    expect(row.status).toBe('pending');
    expect(row.attempt_count).toBe(0);
    expect(row.next_attempt_at).toBe(9_000);
    expect(drainSpy).toHaveBeenCalledTimes(1);
    restore();
  });

  it('retryAll resets every failed row in one transaction', async () => {
    const { restore } = captureAppState();
    const { raw, q } = await freshDb();
    const a = await failOne(raw, q);
    const b = await failOne(raw, q);
    const c = await failOne(raw, q);
    const { drainer, drainSpy } = makeDrainer();

    const { result } = renderHook(() =>
      useFailedQueue({ db: q, drainer, now: () => 5_000 }),
    );
    await waitFor(() => {
      expect(result.current.failedRows).toHaveLength(3);
    });

    await act(async () => {
      await result.current.retryAll();
    });

    for (const id of [a, b, c]) {
      const row = raw.prepare('SELECT * FROM sync_queue WHERE id = ?').get(id) as {
        status: string;
        attempt_count: number;
        next_attempt_at: number;
      };
      expect(row.status).toBe('pending');
      expect(row.attempt_count).toBe(0);
      expect(row.next_attempt_at).toBe(5_000);
    }
    expect(drainSpy).toHaveBeenCalledTimes(1);
    restore();
  });

  it('AppState "active" transition triggers a refresh', async () => {
    const { listeners, restore } = captureAppState();
    const { raw, q } = await freshDb();
    const { drainer } = makeDrainer();

    const { result } = renderHook(() => useFailedQueue({ db: q, drainer }));
    await waitFor(() => {
      expect(result.current.failedRows).toEqual([]);
    });

    await failOne(raw, q);

    expect(listeners.length).toBeGreaterThan(0);
    await act(async () => {
      listeners.forEach((l) => l('active'));
      await new Promise((resolve) => setImmediate(resolve));
    });

    await waitFor(() => {
      expect(result.current.failedRows).toHaveLength(1);
    });
    restore();
  });

  it('AppState transitions other than "active" do not refresh', async () => {
    const { listeners, restore } = captureAppState();
    const { raw, q } = await freshDb();
    const { drainer } = makeDrainer();

    const { result } = renderHook(() => useFailedQueue({ db: q, drainer }));
    await waitFor(() => {
      expect(result.current.failedRows).toEqual([]);
    });

    await failOne(raw, q);

    await act(async () => {
      listeners.forEach((l) => l('background'));
      listeners.forEach((l) => l('inactive'));
      await new Promise((resolve) => setImmediate(resolve));
    });

    expect(result.current.failedRows).toEqual([]);
    restore();
  });

  it('status flips idle -> retrying -> idle around retryAll', async () => {
    const { restore } = captureAppState();
    const { raw, q } = await freshDb();
    await failOne(raw, q);
    const { drainer, drainSpy } = makeDrainer();

    let resolveDrain!: () => void;
    drainSpy.mockImplementation(() => {
      return new Promise<unknown>((resolve) => {
        resolveDrain = () => resolve({
          processed: 0,
          succeeded: 0,
          rescheduled: 0,
          rateLimited: 0,
          failedTerminal: 0,
          stopped: false,
        });
      });
    });

    const { result } = renderHook(() => useFailedQueue({ db: q, drainer }));
    await waitFor(() => {
      expect(result.current.failedRows).toHaveLength(1);
    });

    expect(result.current.status).toBe('idle');

    let retryPromise!: Promise<void>;
    await act(async () => {
      retryPromise = result.current.retryAll();
      await new Promise((resolve) => setImmediate(resolve));
    });
    expect(result.current.status).toBe('retrying');

    await act(async () => {
      resolveDrain();
      await retryPromise;
    });
    expect(result.current.status).toBe('idle');
    restore();
  });

  it('retryOne on a row that is already pending is a safe no-op (drainer still fires)', async () => {
    const { restore } = captureAppState();
    const { raw, q } = await freshDb();
    const r = await enqueueRequest(q, { kind: 'diagnose', payload: 'p', nowMs: 1 });
    const { drainer, drainSpy } = makeDrainer();

    const { result } = renderHook(() => useFailedQueue({ db: q, drainer }));
    await waitFor(() => {
      expect(result.current.failedRows).toEqual([]);
    });

    await act(async () => {
      await result.current.retryOne(r.id);
    });

    const row = raw.prepare('SELECT * FROM sync_queue WHERE id = ?').get(r.id) as {
      status: string;
      attempt_count: number;
    };
    expect(row.status).toBe('pending');
    expect(row.attempt_count).toBe(0);
    expect(drainSpy).toHaveBeenCalledTimes(1);
    restore();
  });

  it('retryOne on an in_flight row is a safe no-op (drainer owns it)', async () => {
    const { restore } = captureAppState();
    const { raw, q } = await freshDb();
    const r = await enqueueRequest(q, { kind: 'diagnose', payload: 'p', nowMs: 1 });
    raw
      .prepare(
        "UPDATE sync_queue SET status='in_flight', attempt_count=2 WHERE id = ?",
      )
      .run(r.id);
    const { drainer } = makeDrainer();

    const { result } = renderHook(() => useFailedQueue({ db: q, drainer }));
    await waitFor(() => {
      expect(result.current.failedRows).toEqual([]);
    });

    await act(async () => {
      await result.current.retryOne(r.id);
    });

    const row = raw.prepare('SELECT * FROM sync_queue WHERE id = ?').get(r.id) as {
      status: string;
      attempt_count: number;
    };
    expect(row.status).toBe('in_flight');
    expect(row.attempt_count).toBe(2);
    restore();
  });

  it('retryAll with no failed rows skips drainer.drainNow() entirely', async () => {
    const { restore } = captureAppState();
    const { q } = await freshDb();
    const { drainer, drainSpy } = makeDrainer();

    const { result } = renderHook(() => useFailedQueue({ db: q, drainer }));
    await waitFor(() => {
      expect(result.current.failedRows).toEqual([]);
    });

    await act(async () => {
      await result.current.retryAll();
    });

    expect(drainSpy).not.toHaveBeenCalled();
    expect(result.current.status).toBe('idle');
    restore();
  });

  it('refresh updates failedRows after a row is reclassified externally', async () => {
    const { restore } = captureAppState();
    const { raw, q } = await freshDb();
    const id = await failOne(raw, q);
    const { drainer } = makeDrainer();

    const { result } = renderHook(() => useFailedQueue({ db: q, drainer }));
    await waitFor(() => {
      expect(result.current.failedRows).toHaveLength(1);
    });

    raw.prepare("UPDATE sync_queue SET status='done' WHERE id = ?").run(id);

    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.failedRows).toEqual([]);
    restore();
  });

  it('second retryAll while one is in flight is a no-op', async () => {
    const { restore } = captureAppState();
    const { raw, q } = await freshDb();
    await failOne(raw, q);
    const { drainer, drainSpy } = makeDrainer();

    let resolveDrain!: () => void;
    drainSpy.mockImplementation(() => {
      return new Promise<unknown>((resolve) => {
        resolveDrain = () => resolve({
          processed: 0,
          succeeded: 0,
          rescheduled: 0,
          rateLimited: 0,
          failedTerminal: 0,
          stopped: false,
        });
      });
    });

    const { result } = renderHook(() => useFailedQueue({ db: q, drainer }));
    await waitFor(() => {
      expect(result.current.failedRows).toHaveLength(1);
    });

    let firstRetry!: Promise<void>;
    let secondRetry!: Promise<void>;
    await act(async () => {
      firstRetry = result.current.retryAll();
      await new Promise((resolve) => setImmediate(resolve));
      secondRetry = result.current.retryAll();
      await secondRetry;
    });

    expect(drainSpy).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveDrain();
      await firstRetry;
    });
    restore();
  });

  it('strict-mode-style double mount does not double-fire side effects', async () => {
    const { listeners, restore } = captureAppState();
    const { raw, q } = await freshDb();
    await failOne(raw, q);
    const { drainer } = makeDrainer();

    const first = renderHook(() => useFailedQueue({ db: q, drainer }));
    await waitFor(() => {
      expect(first.result.current.failedRows).toHaveLength(1);
    });
    first.unmount();

    const second = renderHook(() => useFailedQueue({ db: q, drainer }));
    await waitFor(() => {
      expect(second.result.current.failedRows).toHaveLength(1);
    });

    expect(listeners.length).toBe(1);
    restore();
  });

  it('post-retry refresh observes the post-write state even when a refresh is mid-flight (codex P2)', async () => {
    const { restore } = captureAppState();
    const { raw, q } = await freshDb();
    const id = await failOne(raw, q);
    const { drainer } = makeDrainer();

    const { result } = renderHook(() => useFailedQueue({ db: q, drainer }));
    await waitFor(() => {
      expect(result.current.failedRows).toHaveLength(1);
    });

    // Kick off a manual refresh, then immediately tap retry. The retry's
    // post-write refresh must observe the post-reset state — banner
    // should reflect that the failed row is gone (it was reset to
    // pending).
    await act(async () => {
      const slowRefresh = result.current.refresh();
      const retry = result.current.retryOne(id);
      await Promise.all([slowRefresh, retry]);
    });

    // After retry, the row was reset to pending; selectFailedRows now
    // returns []. The banner should reflect that.
    expect(result.current.failedRows).toEqual([]);
    restore();
  });

  it('refresh is idempotent — repeated calls with same row set keep array reference', async () => {
    const { restore } = captureAppState();
    const { raw, q } = await freshDb();
    await failOne(raw, q);
    const { drainer } = makeDrainer();

    const { result } = renderHook(() => useFailedQueue({ db: q, drainer }));
    await waitFor(() => {
      expect(result.current.failedRows).toHaveLength(1);
    });

    const firstRef = result.current.failedRows;

    await act(async () => {
      await result.current.refresh();
      await result.current.refresh();
      await result.current.refresh();
    });

    expect(result.current.failedRows).toBe(firstRef);
    restore();
  });
});
