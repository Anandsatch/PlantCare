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
});
