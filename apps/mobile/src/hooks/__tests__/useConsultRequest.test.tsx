/**
 * useConsultRequest tests. Mirrors useDiagnoseRequest's coverage shape so
 * the parallel-hook contract stays honest. Drives the hook against an
 * injected apiClient mock — the surface under test is the hook's state
 * machine + coercion semantics, not transport.
 */
import { describe, expect, it, jest } from '@jest/globals';
import { act, renderHook, waitFor } from '@testing-library/react-native';

import type { ApiClient, ApiResult, ConsultResponse } from '../../api';
import { useConsultRequest } from '../useConsultRequest';
import type { NetInfoLike } from '../useDiagnoseRequest';

const RECOMMENDATION: ConsultResponse = {
  kind: 'recommendation',
  revised_interval_days: 7,
  reasoning: 'Hold off on watering for 3 more days while it recovers.',
  confidence: 86,
  source: 'paid_escalated',
  latency_ms: 1234,
};

function makeApiClient(
  consultImpl: (
    body: { note: string; plant_context?: unknown },
  ) => Promise<ApiResult<ConsultResponse>>,
): { client: ApiClient; consultSpy: jest.Mock } {
  const consultSpy = jest.fn(consultImpl as never);
  const client: ApiClient = {
    identify: jest.fn() as never,
    diagnose: jest.fn() as never,
    consult: consultSpy as never,
    review: jest.fn() as never,

    weather: jest.fn() as never,
  };
  return { client, consultSpy };
}

function makeNetInfo(
  connected: boolean | (() => boolean | Promise<boolean>),
): NetInfoLike {
  if (typeof connected === 'function') return { isConnected: connected };
  return { isConnected: () => connected };
}

describe('useConsultRequest', () => {
  it('happy path: ok → status=success, lastResult.ok=true', async () => {
    const { client } = makeApiClient(async () => ({
      ok: true,
      data: RECOMMENDATION,
    }));
    const { result } = renderHook(() =>
      useConsultRequest({ apiClient: client, netInfo: makeNetInfo(true) }),
    );

    expect(result.current.status).toBe('idle');
    expect(result.current.lastResult).toBeNull();

    let returned: ApiResult<ConsultResponse> | undefined;
    await act(async () => {
      returned = await result.current.consult({ note: 'Just repotted Steve' });
    });

    expect(returned).toEqual({ ok: true, data: RECOMMENDATION });
    expect(result.current.status).toBe('success');
    expect(result.current.lastResult).toEqual({ ok: true, data: RECOMMENDATION });
  });

  it('layer1_reject (off-topic) NOT coerced to queued → status=error, kind=layer1_reject', async () => {
    const { client } = makeApiClient(async () => ({
      ok: false,
      kind: 'layer1_reject',
      message: 'off-topic note',
    }));
    const { result } = renderHook(() =>
      useConsultRequest({ apiClient: client, netInfo: makeNetInfo(true) }),
    );

    await act(async () => {
      await result.current.consult({ note: 'best pasta recipe?' });
    });

    expect(result.current.status).toBe('error');
    expect(result.current.lastResult).toEqual({
      ok: false,
      kind: 'layer1_reject',
      message: 'off-topic note',
    });
  });

  it('low_confidence NOT coerced to queued', async () => {
    const { client } = makeApiClient(async () => ({
      ok: false,
      kind: 'low_confidence',
    }));
    const { result } = renderHook(() =>
      useConsultRequest({ apiClient: client, netInfo: makeNetInfo(true) }),
    );

    await act(async () => {
      await result.current.consult({ note: 'leaves yellow' });
    });

    expect(result.current.status).toBe('error');
    expect(result.current.lastResult).toEqual({ ok: false, kind: 'low_confidence' });
  });

  it('timeout NOT coerced to queued', async () => {
    const { client } = makeApiClient(async () => ({ ok: false, kind: 'timeout' }));
    const { result } = renderHook(() =>
      useConsultRequest({ apiClient: client, netInfo: makeNetInfo(true) }),
    );

    await act(async () => {
      await result.current.consult({ note: 'leaves drooping' });
    });

    expect(result.current.status).toBe('error');
    expect(result.current.lastResult).toEqual({ ok: false, kind: 'timeout' });
  });

  it('server NOT coerced to queued; retry_after preserved', async () => {
    const { client } = makeApiClient(async () => ({
      ok: false,
      kind: 'server',
      retry_after: 30,
    }));
    const { result } = renderHook(() =>
      useConsultRequest({ apiClient: client, netInfo: makeNetInfo(true) }),
    );

    await act(async () => {
      await result.current.consult({ note: 'help' });
    });

    expect(result.current.status).toBe('error');
    expect(result.current.lastResult).toEqual({
      ok: false,
      kind: 'server',
      retry_after: 30,
    });
  });

  it('parse_error NOT coerced to queued', async () => {
    const { client } = makeApiClient(async () => ({ ok: false, kind: 'parse_error' }));
    const { result } = renderHook(() =>
      useConsultRequest({ apiClient: client, netInfo: makeNetInfo(true) }),
    );

    await act(async () => {
      await result.current.consult({ note: 'help' });
    });

    expect(result.current.status).toBe('error');
    expect(result.current.lastResult).toEqual({ ok: false, kind: 'parse_error' });
  });

  it('offline (netInfo=false) short-circuits → queued, apiClient.consult NOT called', async () => {
    const { client, consultSpy } = makeApiClient(async () => ({
      ok: true,
      data: RECOMMENDATION,
    }));
    const { result } = renderHook(() =>
      useConsultRequest({ apiClient: client, netInfo: makeNetInfo(false) }),
    );

    let returned: ApiResult<ConsultResponse> | undefined;
    await act(async () => {
      returned = await result.current.consult({ note: 'Just repotted' });
    });

    expect(returned).toEqual({ ok: false, kind: 'queued' });
    expect(result.current.status).toBe('queued');
    expect(consultSpy).not.toHaveBeenCalled();
  });

  it('network kind coerced to queued (online + apiClient returns kind:network)', async () => {
    const { client } = makeApiClient(async () => ({ ok: false, kind: 'network' }));
    const { result } = renderHook(() =>
      useConsultRequest({ apiClient: client, netInfo: makeNetInfo(true) }),
    );

    let returned: ApiResult<ConsultResponse> | undefined;
    await act(async () => {
      returned = await result.current.consult({ note: 'leaves drooping' });
    });

    expect(returned).toEqual({ ok: false, kind: 'queued' });
    expect(result.current.status).toBe('queued');
  });

  it('status transitions: idle → requesting → success', async () => {
    let resolve: (r: ApiResult<ConsultResponse>) => void = () => {};
    const pending = new Promise<ApiResult<ConsultResponse>>((r) => {
      resolve = r;
    });
    const { client } = makeApiClient(() => pending);
    const { result } = renderHook(() =>
      useConsultRequest({ apiClient: client, netInfo: makeNetInfo(true) }),
    );

    expect(result.current.status).toBe('idle');

    let p: Promise<ApiResult<ConsultResponse>> | undefined;
    act(() => {
      p = result.current.consult({ note: 'Just repotted' });
    });

    await waitFor(() => expect(result.current.status).toBe('requesting'));

    await act(async () => {
      resolve({ ok: true, data: RECOMMENDATION });
      await p;
    });

    expect(result.current.status).toBe('success');
  });

  it('unmount mid-request: setState NOT called after unmount', async () => {
    let resolve: (r: ApiResult<ConsultResponse>) => void = () => {};
    const pending = new Promise<ApiResult<ConsultResponse>>((r) => {
      resolve = r;
    });
    const { client } = makeApiClient(() => pending);
    const { result, unmount } = renderHook(() =>
      useConsultRequest({ apiClient: client, netInfo: makeNetInfo(true) }),
    );

    let p: Promise<ApiResult<ConsultResponse>> | undefined;
    act(() => {
      p = result.current.consult({ note: 'Just repotted' });
    });

    unmount();

    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await act(async () => {
        resolve({ ok: true, data: RECOMMENDATION });
        await p;
      });
      const calls = errorSpy.mock.calls.map((args) => String(args[0] ?? ''));
      const offending = calls.filter((m) =>
        /unmounted component|act\(.*\)/i.test(m),
      );
      expect(offending).toHaveLength(0);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('two consult() calls in flight: lastResult reflects most-recent-by-call-order', async () => {
    let resolveCall1: (r: ApiResult<ConsultResponse>) => void = () => {};
    let resolveCall2: (r: ApiResult<ConsultResponse>) => void = () => {};
    let idx = 0;
    const { client } = makeApiClient(() => {
      idx += 1;
      const i = idx;
      return new Promise<ApiResult<ConsultResponse>>((resolve) => {
        if (i === 1) resolveCall1 = resolve;
        else resolveCall2 = resolve;
      });
    });
    const { result } = renderHook(() =>
      useConsultRequest({ apiClient: client, netInfo: makeNetInfo(true) }),
    );

    let p1: Promise<ApiResult<ConsultResponse>> | undefined;
    let p2: Promise<ApiResult<ConsultResponse>> | undefined;
    await act(async () => {
      p1 = result.current.consult({ note: 'one' });
      p2 = result.current.consult({ note: 'two' });
      await Promise.resolve();
      await Promise.resolve();
    });

    const r2: ApiResult<ConsultResponse> = {
      ok: true,
      data: { ...RECOMMENDATION, confidence: 99 },
    };
    await act(async () => {
      resolveCall2(r2);
      await p2;
    });
    expect(result.current.lastResult).toEqual(r2);

    const r1: ApiResult<ConsultResponse> = { ok: false, kind: 'server' };
    await act(async () => {
      resolveCall1(r1);
      await p1;
    });
    expect(result.current.lastResult).toEqual(r2);
    expect(result.current.status).toBe('success');
  });

  it('apiClient.consult throwing surfaces as queued (network → coerced)', async () => {
    const { client } = makeApiClient(async () => {
      throw new Error('contract violation: client should not throw');
    });
    const { result } = renderHook(() =>
      useConsultRequest({ apiClient: client, netInfo: makeNetInfo(true) }),
    );

    let returned: ApiResult<ConsultResponse> | undefined;
    await act(async () => {
      returned = await result.current.consult({ note: 'Just repotted' });
    });

    expect(returned).toEqual({ ok: false, kind: 'queued' });
    expect(result.current.status).toBe('queued');
  });

  it('forwards plant_context only when provided; trims note before dispatch', async () => {
    const { client, consultSpy } = makeApiClient(async () => ({
      ok: true,
      data: RECOMMENDATION,
    }));
    const { result } = renderHook(() =>
      useConsultRequest({ apiClient: client, netInfo: makeNetInfo(true) }),
    );

    await act(async () => {
      await result.current.consult({
        note: '   Just repotted   \n',
        plantContext: { species_slug: 'monstera_deliciosa', is_indoor: true },
      });
    });
    expect(consultSpy).toHaveBeenCalledTimes(1);
    expect(consultSpy.mock.calls[0]?.[0]).toEqual({
      note: 'Just repotted',
      plant_context: { species_slug: 'monstera_deliciosa', is_indoor: true },
    });

    consultSpy.mockClear();
    await act(async () => {
      await result.current.consult({ note: 'leaves drooping' });
    });
    expect(consultSpy).toHaveBeenCalledTimes(1);
    // No plant_context key when omitted (the wire body should be minimal).
    expect(consultSpy.mock.calls[0]?.[0]).toEqual({ note: 'leaves drooping' });
  });

  it('empty / whitespace-only note short-circuits to parse_error without calling apiClient', async () => {
    const { client, consultSpy } = makeApiClient(async () => ({
      ok: true,
      data: RECOMMENDATION,
    }));
    const { result } = renderHook(() =>
      useConsultRequest({ apiClient: client, netInfo: makeNetInfo(true) }),
    );

    let returned: ApiResult<ConsultResponse> | undefined;
    await act(async () => {
      returned = await result.current.consult({ note: '   \n  ' });
    });
    expect(returned).toEqual({ ok: false, kind: 'parse_error' });
    expect(consultSpy).not.toHaveBeenCalled();
    expect(result.current.status).toBe('error');
  });

  it('reset() clears state and prevents stale in-flight commit from clobbering', async () => {
    let resolveCall1: (r: ApiResult<ConsultResponse>) => void = () => {};
    const pending = new Promise<ApiResult<ConsultResponse>>((r) => {
      resolveCall1 = r;
    });
    const { client } = makeApiClient(() => pending);
    const { result } = renderHook(() =>
      useConsultRequest({ apiClient: client, netInfo: makeNetInfo(true) }),
    );

    let p: Promise<ApiResult<ConsultResponse>> | undefined;
    act(() => {
      p = result.current.consult({ note: 'one' });
    });
    await waitFor(() => expect(result.current.status).toBe('requesting'));

    act(() => {
      result.current.reset();
    });
    expect(result.current.status).toBe('idle');
    expect(result.current.lastResult).toBeNull();

    // Now resolve call1 — it should NOT clobber idle/null because reset()
    // bumped the committed-call-id past it.
    await act(async () => {
      resolveCall1({ ok: true, data: RECOMMENDATION });
      await p;
    });
    expect(result.current.status).toBe('idle');
    expect(result.current.lastResult).toBeNull();
  });

  it('default netInfo (omitted) treats client as online → forwards to apiClient', async () => {
    const { client, consultSpy } = makeApiClient(async () => ({
      ok: true,
      data: RECOMMENDATION,
    }));
    const { result } = renderHook(() => useConsultRequest({ apiClient: client }));

    await act(async () => {
      await result.current.consult({ note: 'Just repotted' });
    });
    expect(consultSpy).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe('success');
  });
});
