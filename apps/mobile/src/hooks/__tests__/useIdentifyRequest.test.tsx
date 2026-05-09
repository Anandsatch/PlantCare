/**
 * useIdentifyRequest tests. Parallel coverage to useDiagnoseRequest — same
 * state machine, same coercion rules. Pinned here so a future refactor
 * that *does* unify the two hooks can't drop a contract on the floor.
 */
import { describe, expect, it, jest } from '@jest/globals';
import { act, renderHook, waitFor } from '@testing-library/react-native';

import type { ApiClient, ApiResult, IdentifyResponse } from '../../api';
import { useIdentifyRequest, type NetInfoLike } from '../useIdentifyRequest';

const SUCCESS_DATA: IdentifyResponse = {
  species_slug: 'monstera_deliciosa',
  species_label: 'Monstera Deliciosa',
  confidence: 92,
  alternatives: [],
  source: 'free',
  latency_ms: 850,
};

function makeApiClient(
  identifyImpl: (input: {
    image: { uri: string } | Blob | { uri: string; name?: string; type?: string };
  }) => Promise<ApiResult<IdentifyResponse>>,
): { client: ApiClient; identifySpy: jest.Mock } {
  const identifySpy = jest.fn(identifyImpl as never);
  const client: ApiClient = {
    identify: identifySpy as never,
    diagnose: jest.fn() as never,
    consult: jest.fn() as never,
    review: jest.fn() as never,

    weather: jest.fn() as never,
  };
  return { client, identifySpy };
}

function makeNetInfo(connected: boolean): NetInfoLike {
  return { isConnected: () => connected };
}

describe('useIdentifyRequest', () => {
  it('happy path online → status="success", lastResult.ok=true', async () => {
    const { client } = makeApiClient(async () => ({ ok: true, data: SUCCESS_DATA }));
    const { result } = renderHook(() =>
      useIdentifyRequest({ apiClient: client, netInfo: makeNetInfo(true) }),
    );

    expect(result.current.status).toBe('idle');

    await act(async () => {
      await result.current.identify({ photoUri: 'file:///photo.jpg' });
    });

    expect(result.current.status).toBe('success');
    expect(result.current.lastResult).toEqual({ ok: true, data: SUCCESS_DATA });
  });

  it('offline → status="queued"; apiClient.identify NOT called', async () => {
    const { client, identifySpy } = makeApiClient(async () => ({
      ok: true,
      data: SUCCESS_DATA,
    }));
    const { result } = renderHook(() =>
      useIdentifyRequest({ apiClient: client, netInfo: makeNetInfo(false) }),
    );

    await act(async () => {
      await result.current.identify({ photoUri: 'file:///photo.jpg' });
    });

    expect(result.current.status).toBe('queued');
    expect(result.current.lastResult).toEqual({ ok: false, kind: 'queued' });
    expect(identifySpy).not.toHaveBeenCalled();
  });

  it('network kind coerced to queued (not surfaced as error)', async () => {
    const { client } = makeApiClient(async () => ({ ok: false, kind: 'network' }));
    const { result } = renderHook(() =>
      useIdentifyRequest({ apiClient: client, netInfo: makeNetInfo(true) }),
    );

    await act(async () => {
      await result.current.identify({ photoUri: 'file:///photo.jpg' });
    });

    expect(result.current.status).toBe('queued');
    expect(result.current.lastResult).toEqual({ ok: false, kind: 'queued' });
  });

  it('timeout NOT coerced to queued → status="error"', async () => {
    const { client } = makeApiClient(async () => ({ ok: false, kind: 'timeout' }));
    const { result } = renderHook(() =>
      useIdentifyRequest({ apiClient: client, netInfo: makeNetInfo(true) }),
    );

    await act(async () => {
      await result.current.identify({ photoUri: 'file:///photo.jpg' });
    });

    expect(result.current.status).toBe('error');
    expect(result.current.lastResult).toEqual({ ok: false, kind: 'timeout' });
  });

  it('parse_error preserved (not collapsed to error/queued)', async () => {
    const { client } = makeApiClient(async () => ({ ok: false, kind: 'parse_error' }));
    const { result } = renderHook(() =>
      useIdentifyRequest({ apiClient: client, netInfo: makeNetInfo(true) }),
    );

    await act(async () => {
      await result.current.identify({ photoUri: 'file:///photo.jpg' });
    });

    expect(result.current.status).toBe('error');
    expect(result.current.lastResult).toEqual({ ok: false, kind: 'parse_error' });
  });

  it('apiClient throwing → defensive coercion to queued', async () => {
    const { client } = makeApiClient(async () => {
      throw new Error('boom');
    });
    const { result } = renderHook(() =>
      useIdentifyRequest({ apiClient: client, netInfo: makeNetInfo(true) }),
    );

    await act(async () => {
      await result.current.identify({ photoUri: 'file:///photo.jpg' });
    });

    expect(result.current.status).toBe('queued');
    expect(result.current.lastResult).toEqual({ ok: false, kind: 'queued' });
  });

  it('status transitions: idle → requesting → success', async () => {
    let resolveIdentify: (r: ApiResult<IdentifyResponse>) => void = () => {};
    const pending = new Promise<ApiResult<IdentifyResponse>>((resolve) => {
      resolveIdentify = resolve;
    });
    const { client } = makeApiClient(() => pending);
    const { result } = renderHook(() =>
      useIdentifyRequest({ apiClient: client, netInfo: makeNetInfo(true) }),
    );

    expect(result.current.status).toBe('idle');

    let returnedPromise: Promise<ApiResult<IdentifyResponse>> | undefined;
    act(() => {
      returnedPromise = result.current.identify({ photoUri: 'file:///photo.jpg' });
    });

    await waitFor(() => expect(result.current.status).toBe('requesting'));

    await act(async () => {
      resolveIdentify({ ok: true, data: SUCCESS_DATA });
      await returnedPromise;
    });

    expect(result.current.status).toBe('success');
  });

  it('race: older call resolving later does NOT overwrite newer call', async () => {
    let resolveCall1: (r: ApiResult<IdentifyResponse>) => void = () => {};
    let resolveCall2: (r: ApiResult<IdentifyResponse>) => void = () => {};
    let callIndex = 0;
    const { client } = makeApiClient(() => {
      callIndex += 1;
      const idx = callIndex;
      return new Promise<ApiResult<IdentifyResponse>>((resolve) => {
        if (idx === 1) resolveCall1 = resolve;
        else resolveCall2 = resolve;
      });
    });

    const { result } = renderHook(() =>
      useIdentifyRequest({ apiClient: client, netInfo: makeNetInfo(true) }),
    );

    let p1: Promise<ApiResult<IdentifyResponse>> | undefined;
    let p2: Promise<ApiResult<IdentifyResponse>> | undefined;
    await act(async () => {
      p1 = result.current.identify({ photoUri: 'file:///a.jpg' });
      p2 = result.current.identify({ photoUri: 'file:///b.jpg' });
      await Promise.resolve();
      await Promise.resolve();
    });

    const result2: ApiResult<IdentifyResponse> = {
      ok: true,
      data: { ...SUCCESS_DATA, confidence: 99 },
    };
    await act(async () => {
      resolveCall2(result2);
      await p2;
    });
    expect(result.current.lastResult).toEqual(result2);

    const result1: ApiResult<IdentifyResponse> = { ok: false, kind: 'server' };
    await act(async () => {
      resolveCall1(result1);
      await p1;
    });

    expect(result.current.lastResult).toEqual(result2);
  });
});
