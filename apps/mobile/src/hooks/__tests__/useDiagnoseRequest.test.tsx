/**
 * useDiagnoseRequest tests. Exercise the state machine + the network →
 * queued coercion + the unmount + race-by-call-order guards. Drive the
 * hook against an injected apiClient mock so the surface under test is
 * the hook's behavior, not transport.
 */
import { describe, expect, it, jest } from '@jest/globals';
import { act, renderHook, waitFor } from '@testing-library/react-native';

import type { ApiClient, ApiResult, DiagnoseResponse } from '../../api';
import { useDiagnoseRequest, type NetInfoLike } from '../useDiagnoseRequest';
import { freshQueueDb, readAllQueueRows } from './offlineQueueTestHelpers';

// ─── Test helpers ───────────────────────────────────────────────────────

const SUCCESS_DATA: DiagnoseResponse = {
  disease_slug: 'underwatering',
  disease_label: 'Underwatering',
  confidence: 88,
  severity: 'medium',
  fix_steps: ['Water deeply', 'Check root ball'],
  alternatives: [],
  source: 'paid_escalated',
  latency_ms: 1234,
};

function makeApiClient(
  diagnoseImpl: (
    input: { image: { uri: string } | Blob | { uri: string; name?: string; type?: string } },
  ) => Promise<ApiResult<DiagnoseResponse>>,
): { client: ApiClient; diagnoseSpy: jest.Mock } {
  const diagnoseSpy = jest.fn(diagnoseImpl as never);
  const client: ApiClient = {
    identify: jest.fn() as never,
    diagnose: diagnoseSpy as never,
    consult: jest.fn() as never,
    review: jest.fn() as never,
    weather: jest.fn() as never,
  };
  return { client, diagnoseSpy };
}

function makeNetInfo(connected: boolean | (() => boolean | Promise<boolean>)): NetInfoLike {
  if (typeof connected === 'function') return { isConnected: connected };
  return { isConnected: () => connected };
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe('useDiagnoseRequest', () => {
  it('happy path: online + apiClient.diagnose returns ok → status="success", lastResult.ok=true', async () => {
    const { client } = makeApiClient(async () => ({ ok: true, data: SUCCESS_DATA }));
    const { result } = renderHook(() =>
      useDiagnoseRequest({ apiClient: client, netInfo: makeNetInfo(true) }),
    );

    expect(result.current.status).toBe('idle');
    expect(result.current.lastResult).toBeNull();

    let returned: ApiResult<DiagnoseResponse> | undefined;
    await act(async () => {
      returned = await result.current.diagnose({ photoUri: 'file:///photo.jpg' });
    });

    expect(returned).toEqual({ ok: true, data: SUCCESS_DATA });
    expect(result.current.status).toBe('success');
    expect(result.current.lastResult).toEqual({ ok: true, data: SUCCESS_DATA });
  });

  it('server error: kind:"server" → status="error", lastResult.kind="server"', async () => {
    const { client } = makeApiClient(async () => ({
      ok: false,
      kind: 'server',
      retry_after: 30,
    }));
    const { result } = renderHook(() =>
      useDiagnoseRequest({ apiClient: client, netInfo: makeNetInfo(true) }),
    );

    let returned: ApiResult<DiagnoseResponse> | undefined;
    await act(async () => {
      returned = await result.current.diagnose({ photoUri: 'file:///photo.jpg' });
    });

    expect(returned).toEqual({ ok: false, kind: 'server', retry_after: 30 });
    expect(result.current.status).toBe('error');
    expect(result.current.lastResult).toEqual({
      ok: false,
      kind: 'server',
      retry_after: 30,
    });
  });

  it('low_confidence: NOT coerced to queued → status="error", lastResult.kind="low_confidence"', async () => {
    const { client } = makeApiClient(async () => ({ ok: false, kind: 'low_confidence' }));
    const { result } = renderHook(() =>
      useDiagnoseRequest({ apiClient: client, netInfo: makeNetInfo(true) }),
    );

    await act(async () => {
      await result.current.diagnose({ photoUri: 'file:///photo.jpg' });
    });

    expect(result.current.status).toBe('error');
    expect(result.current.lastResult).toEqual({ ok: false, kind: 'low_confidence' });
  });

  it('timeout: NOT coerced to queued → status="error", lastResult.kind="timeout"', async () => {
    const { client } = makeApiClient(async () => ({ ok: false, kind: 'timeout' }));
    const { result } = renderHook(() =>
      useDiagnoseRequest({ apiClient: client, netInfo: makeNetInfo(true) }),
    );

    await act(async () => {
      await result.current.diagnose({ photoUri: 'file:///photo.jpg' });
    });

    expect(result.current.status).toBe('error');
    expect(result.current.lastResult).toEqual({ ok: false, kind: 'timeout' });
  });

  it('parse_error: NOT coerced to queued → status="error", lastResult.kind="parse_error"', async () => {
    const { client } = makeApiClient(async () => ({ ok: false, kind: 'parse_error' }));
    const { result } = renderHook(() =>
      useDiagnoseRequest({ apiClient: client, netInfo: makeNetInfo(true) }),
    );

    await act(async () => {
      await result.current.diagnose({ photoUri: 'file:///photo.jpg' });
    });

    expect(result.current.status).toBe('error');
    expect(result.current.lastResult).toEqual({ ok: false, kind: 'parse_error' });
  });

  it('layer1_reject: NOT coerced to queued → status="error", lastResult.kind="layer1_reject"', async () => {
    const { client } = makeApiClient(async () => ({
      ok: false,
      kind: 'layer1_reject',
      message: "I don't see a plant here.",
    }));
    const { result } = renderHook(() =>
      useDiagnoseRequest({ apiClient: client, netInfo: makeNetInfo(true) }),
    );

    await act(async () => {
      await result.current.diagnose({ photoUri: 'file:///photo.jpg' });
    });

    expect(result.current.status).toBe('error');
    expect(result.current.lastResult).toEqual({
      ok: false,
      kind: 'layer1_reject',
      message: "I don't see a plant here.",
    });
  });

  it('offline: netInfo says false → status="queued", apiClient.diagnose NOT called', async () => {
    const { client, diagnoseSpy } = makeApiClient(async () => ({
      ok: true,
      data: SUCCESS_DATA,
    }));
    const { result } = renderHook(() =>
      useDiagnoseRequest({ apiClient: client, netInfo: makeNetInfo(false) }),
    );

    let returned: ApiResult<DiagnoseResponse> | undefined;
    await act(async () => {
      returned = await result.current.diagnose({ photoUri: 'file:///photo.jpg' });
    });

    expect(returned).toEqual({ ok: false, kind: 'queued' });
    expect(result.current.status).toBe('queued');
    expect(result.current.lastResult).toEqual({ ok: false, kind: 'queued' });
    expect(diagnoseSpy).not.toHaveBeenCalled();
  });

  it('network kind coerces to queued: online + apiClient returns kind:"network" → status="queued"', async () => {
    const { client } = makeApiClient(async () => ({ ok: false, kind: 'network' }));
    const { result } = renderHook(() =>
      useDiagnoseRequest({ apiClient: client, netInfo: makeNetInfo(true) }),
    );

    let returned: ApiResult<DiagnoseResponse> | undefined;
    await act(async () => {
      returned = await result.current.diagnose({ photoUri: 'file:///photo.jpg' });
    });

    expect(returned).toEqual({ ok: false, kind: 'queued' });
    expect(result.current.status).toBe('queued');
    expect(result.current.lastResult).toEqual({ ok: false, kind: 'queued' });
  });

  it('status transitions: idle → requesting → success', async () => {
    let resolveDiagnose: (r: ApiResult<DiagnoseResponse>) => void = () => {};
    const pending = new Promise<ApiResult<DiagnoseResponse>>((resolve) => {
      resolveDiagnose = resolve;
    });
    const { client } = makeApiClient(() => pending);
    const { result } = renderHook(() =>
      useDiagnoseRequest({ apiClient: client, netInfo: makeNetInfo(true) }),
    );

    expect(result.current.status).toBe('idle');

    let returnedPromise: Promise<ApiResult<DiagnoseResponse>> | undefined;
    act(() => {
      returnedPromise = result.current.diagnose({ photoUri: 'file:///photo.jpg' });
    });

    // status should flip to 'requesting' synchronously after the call
    // initiates (or on the next microtask).
    await waitFor(() => expect(result.current.status).toBe('requesting'));

    await act(async () => {
      resolveDiagnose({ ok: true, data: SUCCESS_DATA });
      await returnedPromise;
    });

    expect(result.current.status).toBe('success');
  });

  it('unmount mid-request: setState NOT called after unmount', async () => {
    let resolveDiagnose: (r: ApiResult<DiagnoseResponse>) => void = () => {};
    const pending = new Promise<ApiResult<DiagnoseResponse>>((resolve) => {
      resolveDiagnose = resolve;
    });
    const { client } = makeApiClient(() => pending);
    const { result, unmount } = renderHook(() =>
      useDiagnoseRequest({ apiClient: client, netInfo: makeNetInfo(true) }),
    );

    let returnedPromise: Promise<ApiResult<DiagnoseResponse>> | undefined;
    act(() => {
      returnedPromise = result.current.diagnose({ photoUri: 'file:///photo.jpg' });
    });

    // Unmount before the in-flight request resolves.
    unmount();

    // Now resolve. If the hook setState's after unmount, React 18+ logs a
    // console warning. We capture console.error and assert nothing fired.
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await act(async () => {
        resolveDiagnose({ ok: true, data: SUCCESS_DATA });
        await returnedPromise;
      });
      // No warning about state updates on an unmounted component.
      const calls = errorSpy.mock.calls.map((args) => String(args[0] ?? ''));
      const offending = calls.filter((m) =>
        /unmounted component|act\(.*\)/i.test(m),
      );
      expect(offending).toHaveLength(0);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('two diagnose() calls in flight resolve independently; lastResult reflects most-recent-by-call-order', async () => {
    // Call 1 will resolve LAST (slow); call 2 will resolve FIRST (fast).
    // We must end with call 2's result, not call 1's, even though call 1
    // resolves later in wall-clock time.
    let resolveCall1: (r: ApiResult<DiagnoseResponse>) => void = () => {};
    let resolveCall2: (r: ApiResult<DiagnoseResponse>) => void = () => {};
    let callIndex = 0;
    const { client } = makeApiClient(() => {
      callIndex += 1;
      const idx = callIndex;
      return new Promise<ApiResult<DiagnoseResponse>>((resolve) => {
        if (idx === 1) resolveCall1 = resolve;
        else resolveCall2 = resolve;
      });
    });

    const { result } = renderHook(() =>
      useDiagnoseRequest({ apiClient: client, netInfo: makeNetInfo(true) }),
    );

    let p1: Promise<ApiResult<DiagnoseResponse>> | undefined;
    let p2: Promise<ApiResult<DiagnoseResponse>> | undefined;
    await act(async () => {
      p1 = result.current.diagnose({ photoUri: 'file:///a.jpg' });
      p2 = result.current.diagnose({ photoUri: 'file:///b.jpg' });
      // Flush the microtasks that resolve `netInfo.isConnected()` so both
      // calls have actually dispatched to apiClient.diagnose.
      await Promise.resolve();
      await Promise.resolve();
    });

    // Resolve call 2 first with one payload.
    const result2: ApiResult<DiagnoseResponse> = {
      ok: true,
      data: { ...SUCCESS_DATA, confidence: 99 },
    };
    await act(async () => {
      resolveCall2(result2);
      await p2;
    });
    expect(result.current.lastResult).toEqual(result2);

    // Now resolve call 1 (older) — it should NOT overwrite call 2's result.
    const result1: ApiResult<DiagnoseResponse> = {
      ok: false,
      kind: 'server',
    };
    await act(async () => {
      resolveCall1(result1);
      await p1;
    });

    // Even though call 1 resolved later, lastResult stays on call 2 (the
    // newer call by initiation order).
    expect(result.current.lastResult).toEqual(result2);
    expect(result.current.status).toBe('success');
  });

  it('plantContext is accepted on the input and the request is dispatched with the photoUri', async () => {
    const { client, diagnoseSpy } = makeApiClient(async () => ({
      ok: true,
      data: SUCCESS_DATA,
    }));
    const { result } = renderHook(() =>
      useDiagnoseRequest({ apiClient: client, netInfo: makeNetInfo(true) }),
    );

    await act(async () => {
      await result.current.diagnose({
        photoUri: 'file:///path/to/photo.jpg',
        plantContext: { species_slug: 'monstera_deliciosa', nickname: 'Bertha' },
      });
    });

    expect(diagnoseSpy).toHaveBeenCalledTimes(1);
    const callArg = diagnoseSpy.mock.calls[0]?.[0] as {
      image: { uri: string };
    };
    expect(callArg.image.uri).toBe('file:///path/to/photo.jpg');
  });

  it('default netInfo (omitted) treats the client as online → forwards to apiClient', async () => {
    const { client, diagnoseSpy } = makeApiClient(async () => ({
      ok: true,
      data: SUCCESS_DATA,
    }));
    const { result } = renderHook(() => useDiagnoseRequest({ apiClient: client }));

    await act(async () => {
      await result.current.diagnose({ photoUri: 'file:///photo.jpg' });
    });

    expect(diagnoseSpy).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe('success');
  });

  it('apiClient.diagnose throwing surfaces as queued (network → coerced)', async () => {
    const { client } = makeApiClient(async () => {
      throw new Error('contract violation: client should not throw');
    });
    const { result } = renderHook(() =>
      useDiagnoseRequest({ apiClient: client, netInfo: makeNetInfo(true) }),
    );

    let returned: ApiResult<DiagnoseResponse> | undefined;
    await act(async () => {
      returned = await result.current.diagnose({ photoUri: 'file:///photo.jpg' });
    });

    // Defensive coercion: thrown error → network → queued.
    expect(returned).toEqual({ ok: false, kind: 'queued' });
    expect(result.current.status).toBe('queued');
  });

  // ─── E7-004: real offline enqueue ────────────────────────────────────
  //
  // The previous block tests the legacy "queued is a UI-only signal"
  // contract — pass NO offlineQueue config and assert the hook still
  // returns kind:'queued' on offline / network. Below, pass a real
  // sync_queue executor and assert rows actually land in SQLite.

  describe('E7-004 offline enqueue', () => {
    it('offline pre-flight: netInfo=false → no api call, sync_queue gets one row, hook returns queued', async () => {
      const { client, diagnoseSpy } = makeApiClient(async () => ({
        ok: true,
        data: SUCCESS_DATA,
      }));
      const { raw, q } = await freshQueueDb();

      const { result } = renderHook(() =>
        useDiagnoseRequest({
          apiClient: client,
          netInfo: makeNetInfo(false),
          offlineQueue: { db: q, nowMs: () => 1_700_000_000_000 },
        }),
      );

      let returned: ApiResult<DiagnoseResponse> | undefined;
      await act(async () => {
        returned = await result.current.diagnose({
          photoUri: 'file:///documentDirectory/photo.jpg',
        });
      });

      expect(returned).toEqual({ ok: false, kind: 'queued' });
      expect(diagnoseSpy).not.toHaveBeenCalled();

      const rows = readAllQueueRows(raw);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.endpoint).toBe('diagnose');
      expect(rows[0]?.ref_table).toBe('diagnose');
      expect(rows[0]?.status).toBe('pending');
      expect(rows[0]?.attempt_count).toBe(0);
      // payload round-trips through JSON.parse without losing the photo URI
      // (codex P1: drainer JSON.parse's this on replay).
      const parsed = JSON.parse(rows[0]!.payload_json) as {
        image: { uri: string };
      };
      expect(parsed.image.uri).toBe('file:///documentDirectory/photo.jpg');
    });

    it('online + apiClient returns kind:network → sync_queue gets one row, hook returns queued', async () => {
      const { client } = makeApiClient(async () => ({ ok: false, kind: 'network' }));
      const { raw, q } = await freshQueueDb();

      const { result } = renderHook(() =>
        useDiagnoseRequest({
          apiClient: client,
          netInfo: makeNetInfo(true),
          offlineQueue: { db: q, nowMs: () => 1_700_000_000_000 },
        }),
      );

      let returned: ApiResult<DiagnoseResponse> | undefined;
      await act(async () => {
        returned = await result.current.diagnose({ photoUri: 'file:///photo.jpg' });
      });

      expect(returned).toEqual({ ok: false, kind: 'queued' });
      const rows = readAllQueueRows(raw);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.endpoint).toBe('diagnose');
      const parsed = JSON.parse(rows[0]!.payload_json) as {
        image: { uri: string };
      };
      expect(parsed.image.uri).toBe('file:///photo.jpg');
    });

    it('online + apiClient returns ok → no sync_queue row, hook returns success', async () => {
      const { client } = makeApiClient(async () => ({ ok: true, data: SUCCESS_DATA }));
      const { raw, q } = await freshQueueDb();

      const { result } = renderHook(() =>
        useDiagnoseRequest({
          apiClient: client,
          netInfo: makeNetInfo(true),
          offlineQueue: { db: q },
        }),
      );

      await act(async () => {
        await result.current.diagnose({ photoUri: 'file:///photo.jpg' });
      });

      expect(result.current.status).toBe('success');
      expect(readAllQueueRows(raw)).toHaveLength(0);
    });

    it.each([
      ['timeout', { ok: false, kind: 'timeout' as const }],
      ['server', { ok: false, kind: 'server' as const, retry_after: 30 }],
      ['parse_error', { ok: false, kind: 'parse_error' as const }],
      ['low_confidence', { ok: false, kind: 'low_confidence' as const }],
      ['layer1_reject', { ok: false, kind: 'layer1_reject' as const }],
    ])(
      'online + non-retryable kind=%s → NO sync_queue row',
      async (_name, apiResult) => {
        const { client } = makeApiClient(async () => apiResult as ApiResult<DiagnoseResponse>);
        const { raw, q } = await freshQueueDb();

        const { result } = renderHook(() =>
          useDiagnoseRequest({
            apiClient: client,
            netInfo: makeNetInfo(true),
            offlineQueue: { db: q },
          }),
        );

        await act(async () => {
          await result.current.diagnose({ photoUri: 'file:///photo.jpg' });
        });

        expect(readAllQueueRows(raw)).toHaveLength(0);
      },
    );

    it('two consecutive identical requests fired before drain → ONE sync_queue row (dedupe)', async () => {
      const { client } = makeApiClient(async () => ({ ok: false, kind: 'network' }));
      const { raw, q } = await freshQueueDb();

      const { result } = renderHook(() =>
        useDiagnoseRequest({
          apiClient: client,
          netInfo: makeNetInfo(true),
          offlineQueue: { db: q },
        }),
      );

      // Two sequential calls with the SAME photoUri — should dedupe via
      // the (refTable='diagnose', refId=hash(photoUri)) tuple.
      await act(async () => {
        await result.current.diagnose({ photoUri: 'file:///same.jpg' });
        await result.current.diagnose({ photoUri: 'file:///same.jpg' });
      });

      expect(readAllQueueRows(raw)).toHaveLength(1);
    });

    it('two consecutive DIFFERENT requests → TWO rows (different photoUri → different hash)', async () => {
      const { client } = makeApiClient(async () => ({ ok: false, kind: 'network' }));
      const { raw, q } = await freshQueueDb();

      const { result } = renderHook(() =>
        useDiagnoseRequest({
          apiClient: client,
          netInfo: makeNetInfo(true),
          offlineQueue: { db: q },
        }),
      );

      await act(async () => {
        await result.current.diagnose({ photoUri: 'file:///a.jpg' });
        await result.current.diagnose({ photoUri: 'file:///b.jpg' });
      });

      const rows = readAllQueueRows(raw);
      expect(rows).toHaveLength(2);
      // Each row's payload references the right URI (no swap).
      const uris = rows
        .map((r) => (JSON.parse(r.payload_json) as { image: { uri: string } }).image.uri)
        .sort();
      expect(uris).toEqual(['file:///a.jpg', 'file:///b.jpg']);
    });

    it('StrictMode double-mount with same submit → ONE sync_queue row', async () => {
      // React StrictMode in dev double-invokes effects; the request hook
      // is not directly affected, but a real call site (a screen)
      // submitting once must not produce two rows. We model the worst
      // case: two diagnose() calls fired in rapid succession from a
      // double-rendered effect, with an offline pre-flight.
      const { client } = makeApiClient(async () => ({ ok: true, data: SUCCESS_DATA }));
      const { raw, q } = await freshQueueDb();

      const { result } = renderHook(() =>
        useDiagnoseRequest({
          apiClient: client,
          netInfo: makeNetInfo(false),
          offlineQueue: { db: q },
        }),
      );

      await act(async () => {
        // Same input, fired twice — same hash, dedupe to one row.
        await Promise.all([
          result.current.diagnose({ photoUri: 'file:///photo.jpg' }),
          result.current.diagnose({ photoUri: 'file:///photo.jpg' }),
        ]);
      });

      expect(readAllQueueRows(raw)).toHaveLength(1);
    });

    it('without offlineQueue config, legacy behavior preserved (no persistence; UI still gets queued)', async () => {
      // Backwards-compat assertion: a caller that hasn't wired the
      // queue still sees kind:'queued' on offline — same as pre-E7-004.
      const { client } = makeApiClient(async () => ({ ok: true, data: SUCCESS_DATA }));
      const { result } = renderHook(() =>
        useDiagnoseRequest({
          apiClient: client,
          netInfo: makeNetInfo(false),
          // offlineQueue intentionally omitted
        }),
      );

      let returned: ApiResult<DiagnoseResponse> | undefined;
      await act(async () => {
        returned = await result.current.diagnose({ photoUri: 'file:///photo.jpg' });
      });

      expect(returned).toEqual({ ok: false, kind: 'queued' });
      expect(result.current.status).toBe('queued');
    });
  });
});
