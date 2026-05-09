/**
 * useWeather tests. Drive the hook against an injected apiClient mock so
 * the surface under test is the hook's classification + state machine,
 * not transport. Covers the discriminated union the hook exposes
 * (ok / cache_hit / rate_limited / network_error / parse_error / queued)
 * and the network-and-timeout-coerced-to-queued semantics.
 */
import { describe, expect, it, jest } from '@jest/globals';
import { act, renderHook } from '@testing-library/react-native';

import type { ApiClient, ApiResult, WeatherResponse } from '../../api';
import { useWeather } from '../useWeather';
import type { NetInfoLike } from '../useDiagnoseRequest';

// ─── Test helpers ───────────────────────────────────────────────────────

const SUCCESS_DATA: WeatherResponse = {
  current: {
    time: '2026-05-08T12:00',
    temperature_c: 22,
    relative_humidity_pct: 50,
    precipitation_mm: 0,
    weather_code: 0,
  },
  daily: [
    {
      date: '2026-05-08',
      temperature_max_c: 25,
      temperature_min_c: 15,
      precipitation_sum_mm: 0,
      weather_code: 0,
    },
    {
      date: '2026-05-09',
      temperature_max_c: 26,
      temperature_min_c: 16,
      precipitation_sum_mm: 1.2,
      weather_code: 1,
    },
  ],
  timezone: 'America/Los_Angeles',
};

function makeApiClient(
  weatherImpl: (
    input: { latitude: number; longitude: number },
  ) => Promise<ApiResult<WeatherResponse>>,
): { client: ApiClient; weatherSpy: jest.Mock } {
  const weatherSpy = jest.fn(weatherImpl as never);
  const client: ApiClient = {
    identify: jest.fn() as never,
    diagnose: jest.fn() as never,
    consult: jest.fn() as never,
    review: jest.fn() as never,
    weather: weatherSpy as never,
  };
  return { client, weatherSpy };
}

function makeNetInfo(connected: boolean | (() => boolean | Promise<boolean>)): NetInfoLike {
  if (typeof connected === 'function') return { isConnected: connected };
  return { isConnected: () => connected };
}

const COORDS = { latitude: 37.7749, longitude: -122.4194 };

// ─── Tests ──────────────────────────────────────────────────────────────

describe('useWeather', () => {
  it('happy path: ok response → kind="ok", status="success"', async () => {
    const { client } = makeApiClient(async () => ({ ok: true, data: SUCCESS_DATA }));
    const { result } = renderHook(() => useWeather({ apiClient: client, netInfo: makeNetInfo(true) }));

    expect(result.current.status).toBe('idle');
    expect(result.current.lastResult).toBeNull();

    let returned;
    await act(async () => {
      returned = await result.current.fetchWeather(COORDS);
    });

    expect(returned).toEqual({ kind: 'ok', data: SUCCESS_DATA });
    expect(result.current.status).toBe('success');
    expect(result.current.lastResult).toEqual({ kind: 'ok', data: SUCCESS_DATA });
  });

  it('rate_limited: server + retry_after → kind="rate_limited", status="rate_limited"', async () => {
    // The api client folds 429 into `kind: 'server'` with `retry_after`.
    // The hook re-extracts that into the distinct `rate_limited` kind so
    // the rules engine sees the signal.
    const { client } = makeApiClient(async () => ({
      ok: false,
      kind: 'server',
      retry_after: 42,
    }));
    const { result } = renderHook(() => useWeather({ apiClient: client, netInfo: makeNetInfo(true) }));

    let returned;
    await act(async () => {
      returned = await result.current.fetchWeather(COORDS);
    });

    expect(returned).toEqual({ kind: 'rate_limited', retry_after_seconds: 42 });
    expect(result.current.status).toBe('rate_limited');
  });

  it('server 5xx without retry_after → kind="network_error", status="error"', async () => {
    const { client } = makeApiClient(async () => ({
      ok: false,
      kind: 'server',
      message: 'upstream_unavailable',
    }));
    const { result } = renderHook(() => useWeather({ apiClient: client, netInfo: makeNetInfo(true) }));

    let returned;
    await act(async () => {
      returned = await result.current.fetchWeather(COORDS);
    });

    expect(returned).toEqual({ kind: 'network_error', message: 'upstream_unavailable' });
    expect(result.current.status).toBe('error');
  });

  it('network → kind="queued" (offline coercion), status="queued"', async () => {
    // Same coercion as useDiagnoseRequest: a fetch that throws (DNS,
    // TLS, captive portal) is indistinguishable from offline to the
    // user, and the rules engine wants the "skip the modifier" signal,
    // not an error card.
    const { client } = makeApiClient(async () => ({ ok: false, kind: 'network' }));
    const { result } = renderHook(() => useWeather({ apiClient: client, netInfo: makeNetInfo(true) }));

    let returned;
    await act(async () => {
      returned = await result.current.fetchWeather(COORDS);
    });

    expect(returned).toEqual({ kind: 'queued' });
    expect(result.current.status).toBe('queued');
  });

  it('timeout → kind="queued" (same coercion as network)', async () => {
    const { client } = makeApiClient(async () => ({ ok: false, kind: 'timeout' }));
    const { result } = renderHook(() => useWeather({ apiClient: client, netInfo: makeNetInfo(true) }));

    let returned;
    await act(async () => {
      returned = await result.current.fetchWeather(COORDS);
    });

    expect(returned).toEqual({ kind: 'queued' });
  });

  it('parse_error → kind="parse_error", status="error"', async () => {
    const { client } = makeApiClient(async () => ({ ok: false, kind: 'parse_error' }));
    const { result } = renderHook(() => useWeather({ apiClient: client, netInfo: makeNetInfo(true) }));

    let returned;
    await act(async () => {
      returned = await result.current.fetchWeather(COORDS);
    });

    expect(returned).toEqual({ kind: 'parse_error' });
    expect(result.current.status).toBe('error');
  });

  it('queued from api client → kind="queued" passthrough', async () => {
    const { client } = makeApiClient(async () => ({ ok: false, kind: 'queued' }));
    const { result } = renderHook(() => useWeather({ apiClient: client, netInfo: makeNetInfo(true) }));

    let returned;
    await act(async () => {
      returned = await result.current.fetchWeather(COORDS);
    });

    expect(returned).toEqual({ kind: 'queued' });
    expect(result.current.status).toBe('queued');
  });

  it('netInfo offline → returns queued without ever calling the api client', async () => {
    const { client, weatherSpy } = makeApiClient(async () => ({ ok: true, data: SUCCESS_DATA }));
    const { result } = renderHook(() =>
      useWeather({ apiClient: client, netInfo: makeNetInfo(false) }),
    );

    let returned;
    await act(async () => {
      returned = await result.current.fetchWeather(COORDS);
    });

    expect(returned).toEqual({ kind: 'queued' });
    expect(weatherSpy).not.toHaveBeenCalled();
    expect(result.current.status).toBe('queued');
  });

  it('apiClient.weather throws → coerces to queued (defensive)', async () => {
    // The api client's contract says it never throws, but we defend
    // against a future regression.
    const { client } = makeApiClient(() => {
      throw new Error('boom');
    });
    const { result } = renderHook(() => useWeather({ apiClient: client, netInfo: makeNetInfo(true) }));

    let returned;
    await act(async () => {
      returned = await result.current.fetchWeather(COORDS);
    });

    expect(returned).toEqual({ kind: 'queued' });
  });

  it('layer1_reject (defensive map) → kind="network_error"', async () => {
    // Shouldn't happen on a lat/lon query, but if it does, we degrade
    // gracefully rather than letting an unexpected kind escape.
    const { client } = makeApiClient(async () => ({
      ok: false,
      kind: 'layer1_reject',
      message: 'no plant detected',
    }));
    const { result } = renderHook(() => useWeather({ apiClient: client, netInfo: makeNetInfo(true) }));

    let returned;
    await act(async () => {
      returned = await result.current.fetchWeather(COORDS);
    });

    expect(returned).toEqual({ kind: 'network_error', message: 'no plant detected' });
  });

  it('discriminated union: switches on result.kind without a default branch (no collapse)', async () => {
    // Locks the contract: the union has six distinct kinds. Collapsing
    // 'network_error' and 'parse_error' into a generic 'error' is a
    // common reviewer suggestion the hook contract REJECTS; this test
    // proves the kinds are surfaced distinctly.
    const cases: Array<{ raw: ApiResult<WeatherResponse>; expectKind: string }> = [
      { raw: { ok: true, data: SUCCESS_DATA }, expectKind: 'ok' },
      { raw: { ok: false, kind: 'server', retry_after: 1 }, expectKind: 'rate_limited' },
      { raw: { ok: false, kind: 'server' }, expectKind: 'network_error' },
      { raw: { ok: false, kind: 'network' }, expectKind: 'queued' },
      { raw: { ok: false, kind: 'parse_error' }, expectKind: 'parse_error' },
    ];

    for (const c of cases) {
      const { client } = makeApiClient(async () => c.raw);
      const { result } = renderHook(() => useWeather({ apiClient: client, netInfo: makeNetInfo(true) }));
      let returned;
      await act(async () => {
        returned = await result.current.fetchWeather(COORDS);
      });
      expect(returned!.kind).toBe(c.expectKind);
    }
  });

  it('latitude + longitude flow through to api client unchanged', async () => {
    const { client, weatherSpy } = makeApiClient(async () => ({ ok: true, data: SUCCESS_DATA }));
    const { result } = renderHook(() =>
      useWeather({ apiClient: client, netInfo: makeNetInfo(true) }),
    );

    await act(async () => {
      await result.current.fetchWeather({ latitude: 51.5, longitude: -0.12 });
    });

    expect(weatherSpy).toHaveBeenCalledWith({ latitude: 51.5, longitude: -0.12 });
  });

  it('race-by-start-order: older call resolving FIRST while a newer is in-flight does NOT win the commit', async () => {
    // Codex P2 catch (E6-005 finishing pass): an earlier draft compared
    // resolution order against the last *committed* call id, which let a
    // stale older call briefly win the commit when it resolved before
    // the newer call resolved (sequence: call#1 starts, call#2 starts,
    // call#1 resolves first → would commit stale; call#2 resolves later
    // → would correct it). The fix compares against the latest *started*
    // call id, eliminating the stale render window entirely.
    let resolveFirst: (v: ApiResult<WeatherResponse>) => void = () => undefined;
    const firstPromise = new Promise<ApiResult<WeatherResponse>>((r) => {
      resolveFirst = r;
    });
    let resolveSecond: (v: ApiResult<WeatherResponse>) => void = () => undefined;
    const secondPromise = new Promise<ApiResult<WeatherResponse>>((r) => {
      resolveSecond = r;
    });

    let callIdx = 0;
    const { client } = makeApiClient(async () => {
      callIdx += 1;
      if (callIdx === 1) return firstPromise;
      return secondPromise;
    });
    const { result } = renderHook(() => useWeather({ apiClient: client, netInfo: makeNetInfo(true) }));

    // Start both calls in-flight. Don't await — they're both pending.
    let firstReturned: Promise<unknown> | undefined;
    let secondReturned: Promise<unknown> | undefined;
    await act(async () => {
      firstReturned = result.current.fetchWeather(COORDS);
      secondReturned = result.current.fetchWeather(COORDS);
    });

    // Resolve the OLDER call first with a distinct stale payload. With
    // the codex-fixed race guard, this MUST be dropped — it's not the
    // latest started call.
    await act(async () => {
      resolveFirst({ ok: false, kind: 'server', message: 'stale' });
      await firstReturned;
    });
    // Status should still be 'requesting' — neither call has won the commit.
    expect(result.current.status).toBe('requesting');
    expect(result.current.lastResult).toBeNull();

    // Now resolve the newer call with fresh data. It should commit.
    await act(async () => {
      resolveSecond({ ok: true, data: SUCCESS_DATA });
      await secondReturned;
    });
    expect(result.current.lastResult).toEqual({ kind: 'ok', data: SUCCESS_DATA });
    expect(result.current.status).toBe('success');
  });

  it('malformed ok payload (missing daily[1]) → kind="parse_error" not "ok"', async () => {
    // Codex P2 catch (E6-005 finishing pass): an earlier draft returned
    // `kind: 'ok'` unconditionally on `raw.ok === true`. A deploy-skew
    // payload missing `daily[1]` would reach `engine.ts` and crash on
    // `weather.daily[1].precipitation_sum_mm`. The runtime shape
    // validator catches this and surfaces parse_error so the rules
    // engine degrades gracefully (skips the modifier).
    const malformed = {
      ...SUCCESS_DATA,
      daily: [SUCCESS_DATA.daily[0]] as unknown as typeof SUCCESS_DATA.daily,
    };
    const { client } = makeApiClient(async () => ({ ok: true, data: malformed }));
    const { result } = renderHook(() => useWeather({ apiClient: client, netInfo: makeNetInfo(true) }));

    let returned;
    await act(async () => {
      returned = await result.current.fetchWeather(COORDS);
    });

    expect(returned).toEqual({ kind: 'parse_error' });
    expect(result.current.status).toBe('error');
  });

  it('malformed ok payload (NaN precipitation_sum_mm) → kind="parse_error"', async () => {
    // NaN squeaks through `typeof === 'number'` checks; the validator
    // requires Number.isFinite. A NaN here would otherwise reach
    // applyWeatherModifier and pollute the threshold comparators.
    const malformed = {
      ...SUCCESS_DATA,
      daily: [
        { ...SUCCESS_DATA.daily[0], precipitation_sum_mm: NaN },
        SUCCESS_DATA.daily[1],
      ] as typeof SUCCESS_DATA.daily,
    };
    const { client } = makeApiClient(async () => ({ ok: true, data: malformed }));
    const { result } = renderHook(() => useWeather({ apiClient: client, netInfo: makeNetInfo(true) }));

    let returned;
    await act(async () => {
      returned = await result.current.fetchWeather(COORDS);
    });

    expect(returned).toEqual({ kind: 'parse_error' });
  });

  it('malformed ok payload (daily entry not an object) → kind="parse_error"', async () => {
    const malformed = {
      ...SUCCESS_DATA,
      daily: [SUCCESS_DATA.daily[0], null as unknown] as unknown as typeof SUCCESS_DATA.daily,
    };
    const { client } = makeApiClient(async () => ({ ok: true, data: malformed }));
    const { result } = renderHook(() => useWeather({ apiClient: client, netInfo: makeNetInfo(true) }));

    let returned;
    await act(async () => {
      returned = await result.current.fetchWeather(COORDS);
    });

    expect(returned).toEqual({ kind: 'parse_error' });
  });

  it('race-by-call-order: older call resolving later does NOT clobber newer call', async () => {
    // First call resolves slow (after the second). Second call resolves
    // fast. The hook should commit the second's result and ignore the
    // first's late arrival.
    let resolveFirst: (v: ApiResult<WeatherResponse>) => void = () => undefined;
    const firstPromise = new Promise<ApiResult<WeatherResponse>>((r) => {
      resolveFirst = r;
    });

    let callIdx = 0;
    const { client } = makeApiClient(async () => {
      callIdx += 1;
      if (callIdx === 1) return firstPromise;
      return { ok: true, data: SUCCESS_DATA };
    });
    const { result } = renderHook(() => useWeather({ apiClient: client, netInfo: makeNetInfo(true) }));

    let firstReturned: Promise<unknown> | undefined;
    await act(async () => {
      firstReturned = result.current.fetchWeather(COORDS);
    });
    // Now fire the second call (resolves immediately).
    await act(async () => {
      await result.current.fetchWeather(COORDS);
    });
    expect(result.current.lastResult).toEqual({ kind: 'ok', data: SUCCESS_DATA });

    // Now resolve the first call — late arrival. Must NOT clobber.
    await act(async () => {
      resolveFirst({
        ok: false,
        kind: 'server',
        retry_after: 99,
      });
      await firstReturned;
    });
    expect(result.current.lastResult).toEqual({ kind: 'ok', data: SUCCESS_DATA });
    expect(result.current.status).toBe('success');
  });
});
