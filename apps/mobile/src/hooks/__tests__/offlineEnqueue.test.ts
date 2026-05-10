/**
 * Unit tests for the offlineEnqueue helper. Pins the hash determinism
 * + key-order independence, the FNV-1a hex output shape, and the
 * safeEnqueue swallow-on-throw contract. The hook tests cover the
 * end-to-end persistence path; this file covers the primitives.
 */
import { describe, expect, it, jest } from '@jest/globals';

import { type QueueExecutor } from '../../sync';
import { fnv1a32Hex, hashStable, safeEnqueue, enqueueOffline } from '../offlineEnqueue';
import { freshQueueDb, readAllQueueRows } from './offlineQueueTestHelpers';

describe('fnv1a32Hex', () => {
  it('returns 8-character lowercase hex', () => {
    const h = fnv1a32Hex('hello');
    expect(h).toMatch(/^[0-9a-f]{8}$/);
  });

  it('is deterministic across calls', () => {
    expect(fnv1a32Hex('plant care')).toBe(fnv1a32Hex('plant care'));
  });

  it('different inputs produce different hashes', () => {
    expect(fnv1a32Hex('a')).not.toBe(fnv1a32Hex('b'));
    expect(fnv1a32Hex('file:///a.jpg')).not.toBe(fnv1a32Hex('file:///b.jpg'));
  });

  it('handles empty string', () => {
    const h = fnv1a32Hex('');
    expect(h).toMatch(/^[0-9a-f]{8}$/);
  });

  it('does NOT collide on Unicode code units that share a low byte (codex P2 regression)', () => {
    // U+00E9 ("é") and U+01E9 ("ǩ") both end in 0xE9 in UTF-16. A
    // naive `charCodeAt() & 0xff` mask would collapse them. The fix:
    // hash UTF-8 bytes instead, so the full code point participates.
    expect(fnv1a32Hex('é')).not.toBe(fnv1a32Hex('ǩ'));
    expect(fnv1a32Hex('Ā')).not.toBe(fnv1a32Hex('Ȁ'));
    // ASCII 'i' (0x69) vs U+0069 ascii 'i' — same; sanity check the
    // implementation didn't break ascii.
    expect(fnv1a32Hex('i')).toBe(fnv1a32Hex('i'));
  });
});

describe('hashStable', () => {
  it('object key order does not affect hash', () => {
    const a = hashStable({ note: 'hi', plant_context: { species_slug: 'monstera' } });
    const b = hashStable({ plant_context: { species_slug: 'monstera' }, note: 'hi' });
    expect(a).toBe(b);
  });

  it('different values produce different hashes', () => {
    expect(hashStable({ photoUri: 'file:///a.jpg' })).not.toBe(
      hashStable({ photoUri: 'file:///b.jpg' }),
    );
  });

  it('array order is preserved (semantic)', () => {
    expect(hashStable({ steps: ['water', 'check'] })).not.toBe(
      hashStable({ steps: ['check', 'water'] }),
    );
  });

  it('NaN/Infinity stable-stringify to a sentinel (no silent collisions)', () => {
    const nan = hashStable({ n: NaN });
    const inf = hashStable({ n: Infinity });
    const negInf = hashStable({ n: -Infinity });
    // All non-finite numbers map to the same sentinel — they're all
    // not-JSON-representable and the dedupe surface treats them
    // equivalently (codex P3 catch).
    expect(nan).toBe(inf);
    expect(nan).toBe(negInf);
    // But a finite number doesn't collide with the sentinel.
    expect(nan).not.toBe(hashStable({ n: 0 }));
  });

  it('null and undefined hash to the same value', () => {
    // Both serialize to 'null' — JSON-compatible.
    expect(hashStable({ x: null })).toBe(hashStable({ x: undefined }));
  });
});

describe('enqueueOffline', () => {
  it('inserts a row with the right endpoint, dedupe shape, and JSON payload', async () => {
    const { raw, q } = await freshQueueDb();

    const result = await enqueueOffline(
      { db: q, nowMs: () => 1_700_000_000_000 },
      {
        endpoint: 'diagnose',
        payload: { image: { uri: 'file:///photo.jpg' } },
        inputHash: 'abcd1234',
      },
    );

    expect(result.inserted).toBe(true);
    expect(result.id).toBeTruthy();

    const rows = readAllQueueRows(raw);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.endpoint).toBe('diagnose');
    expect(rows[0]?.ref_table).toBe('diagnose');
    // refId includes the :nowMs suffix so a previously-terminal row
    // with the same hash doesn't block a fresh enqueue.
    expect(rows[0]?.ref_id).toMatch(/^abcd1234:/);
    expect(rows[0]?.status).toBe('pending');
    expect(rows[0]?.attempt_count).toBe(0);
    expect(rows[0]?.created_at).toBe(1_700_000_000_000);
    const parsed = JSON.parse(rows[0]!.payload_json) as {
      image: { uri: string };
    };
    expect(parsed.image.uri).toBe('file:///photo.jpg');
  });

  it('dedupes against pending/in_flight rows with same (endpoint, inputHash) — returns existing id', async () => {
    const { raw, q } = await freshQueueDb();
    const wiring = {
      endpoint: 'consult' as const,
      payload: { note: 'hello' },
      inputHash: 'fixed_hash',
    };
    const a = await enqueueOffline({ db: q }, wiring);
    const b = await enqueueOffline({ db: q }, wiring);

    expect(a.id).toBe(b.id);
    expect(a.inserted).toBe(true);
    expect(b.inserted).toBe(false);
    expect(readAllQueueRows(raw)).toHaveLength(1);
  });

  it('different endpoints with same hash do NOT collide (refTable differs)', async () => {
    const { raw, q } = await freshQueueDb();
    await enqueueOffline(
      { db: q },
      { endpoint: 'diagnose', payload: { x: 1 }, inputHash: 'collide' },
    );
    await enqueueOffline(
      { db: q },
      { endpoint: 'identify', payload: { x: 2 }, inputHash: 'collide' },
    );
    expect(readAllQueueRows(raw)).toHaveLength(2);
  });

  it('after prior row is marked done, a fresh enqueue with same hash inserts a NEW row (no zombie dedupe)', async () => {
    // The codex P1 case: user diagnoses photo A successfully, then
    // a week later wants to diagnose photo A again. The second
    // submission must enqueue (or fire and succeed); it must NOT
    // silently coalesce into the prior `done` row.
    const { raw, q } = await freshQueueDb();
    const wiring = {
      endpoint: 'diagnose' as const,
      payload: { image: { uri: 'file:///A.jpg' } },
      inputHash: 'photoA_hash',
    };
    const first = await enqueueOffline({ db: q }, wiring);

    // Mark the first row done (simulating a successful drain).
    raw
      .prepare("UPDATE sync_queue SET status = 'done' WHERE id = ?")
      .run(first.id);

    const second = await enqueueOffline({ db: q }, wiring);
    expect(second.inserted).toBe(true);
    expect(second.id).not.toBe(first.id);

    const rows = readAllQueueRows(raw);
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.status === 'pending')).toHaveLength(1);
    expect(rows.filter((r) => r.status === 'done')).toHaveLength(1);
  });

  it('after prior row is marked failed, a fresh enqueue with same hash inserts a NEW row', async () => {
    const { raw, q } = await freshQueueDb();
    const wiring = {
      endpoint: 'diagnose' as const,
      payload: { image: { uri: 'file:///A.jpg' } },
      inputHash: 'photoA_hash',
    };
    const first = await enqueueOffline({ db: q }, wiring);
    raw
      .prepare("UPDATE sync_queue SET status = 'failed' WHERE id = ?")
      .run(first.id);

    const second = await enqueueOffline({ db: q }, wiring);
    expect(second.inserted).toBe(true);
    expect(second.id).not.toBe(first.id);
  });

  it('while prior row is in_flight, fresh enqueue with same hash dedupes (does not double-fire)', async () => {
    const { raw, q } = await freshQueueDb();
    const wiring = {
      endpoint: 'diagnose' as const,
      payload: { image: { uri: 'file:///A.jpg' } },
      inputHash: 'photoA_hash',
    };
    const first = await enqueueOffline({ db: q }, wiring);
    raw
      .prepare("UPDATE sync_queue SET status = 'in_flight' WHERE id = ?")
      .run(first.id);

    const second = await enqueueOffline({ db: q }, wiring);
    expect(second.inserted).toBe(false);
    expect(second.id).toBe(first.id);
    expect(readAllQueueRows(raw)).toHaveLength(1);
  });
});

describe('safeEnqueue', () => {
  it('returns the enqueueOffline result on success', async () => {
    const { q } = await freshQueueDb();
    const result = await safeEnqueue(
      { db: q },
      { endpoint: 'review', payload: {}, inputHash: 'h' },
    );
    expect(result?.inserted).toBe(true);
  });

  it('swallows persistence errors and returns null', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // Executor whose runAsync throws — simulates disk-full / corrupted db.
      const broken: QueueExecutor = {
        async runAsync() {
          throw new Error('disk full');
        },
        async getFirstAsync() {
          return null;
        },
        async getAllAsync() {
          return [];
        },
        async withExclusiveTransactionAsync(task) {
          // Run the task so the inner runAsync throw surfaces.
          await task();
        },
      };

      const result = await safeEnqueue(
        { db: broken },
        { endpoint: 'consult', payload: { note: 'x' }, inputHash: 'h' },
      );
      expect(result).toBeNull();
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
