// Tests for the Open-Meteo wrapper + KV cache (E6-001).
//
// Style mirrors `openrouter.test.ts`: inject `fetchImpl` and a stub KV
// namespace into the wrapper rather than going through `SELF.fetch` +
// fetchMock. The wrapper has no Hono context — it's a pure module — so the
// dependency-injection style keeps tests deterministic and lightning-fast,
// and lets us assert on the exact KV writes without poking at miniflare's
// internals.

import { describe, expect, it, vi } from 'vitest';
import { buildCacheKey, getWeather, type GetWeatherResult } from '../src/lib/openMeteo';

// --- helpers ---------------------------------------------------------------

type StubKV = {
  store: Map<string, { value: string; expirationTtl?: number }>;
  get: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
};

function makeKV(initial?: Record<string, string>): StubKV {
  const store = new Map<string, { value: string; expirationTtl?: number }>();
  if (initial) {
    for (const [k, v] of Object.entries(initial)) store.set(k, { value: v });
  }
  const get = vi.fn(async (key: string) => store.get(key)?.value ?? null);
  const put = vi.fn(
    async (
      key: string,
      value: string,
      options?: { expirationTtl?: number },
    ) => {
      store.set(key, { value, expirationTtl: options?.expirationTtl });
    },
  );
  return { store, get, put };
}

function asEnv(kv: StubKV) {
  return { WEATHER_CACHE: kv as unknown as KVNamespace };
}

// Canonical Open-Meteo response shape for our parameter selection.
function meteoResponse(opts?: {
  timezone?: string;
  currentTemp?: number;
  weatherCode?: number;
}) {
  return {
    latitude: 34.05,
    longitude: -118.24,
    timezone: opts?.timezone ?? 'America/Los_Angeles',
    timezone_abbreviation: 'PDT',
    current: {
      time: '2026-05-06T12:00',
      interval: 900,
      temperature_2m: opts?.currentTemp ?? 22.4,
      relative_humidity_2m: 55,
      precipitation: 0,
      weather_code: opts?.weatherCode ?? 0,
    },
    current_units: { temperature_2m: '°C' },
    daily: {
      time: ['2026-05-06', '2026-05-07'],
      temperature_2m_max: [25.1, 23.0],
      temperature_2m_min: [14.2, 13.5],
      precipitation_sum: [0, 1.2],
      weather_code: [0, 61],
    },
    daily_units: { temperature_2m_max: '°C' },
  };
}

function jsonResponse(body: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

const LA = { latitude: 34.05, longitude: -118.24 };

// --- cache key derivation --------------------------------------------------

describe('buildCacheKey', () => {
  it('renders 2-decimal precision with sign-preserved longitude', () => {
    expect(buildCacheKey(34.0522, -118.2437)).toBe('weather:34.05:-118.24');
  });

  it('preserves negative latitude (southern hemisphere)', () => {
    expect(buildCacheKey(-33.8688, 151.2093)).toBe('weather:-33.87:151.21');
  });

  it('handles zero lat with non-zero lon (equator/Africa)', () => {
    expect(buildCacheKey(0, 9.4)).toBe('weather:0.00:9.40');
  });

  it('does not collapse near-duplicate coords across the rounding boundary', () => {
    // Two coords ~600m apart should hash to the same cell — the design
    // intent is "neighbors share a cache entry."
    expect(buildCacheKey(34.054, -118.244)).toBe(buildCacheKey(34.055, -118.243));
  });
});

// --- cache hit / miss / expiry ---------------------------------------------

describe('getWeather — cache layer', () => {
  it('returns cached value without firing fetch on a fresh hit', async () => {
    const now = 1_800_000_000_000;
    const cached = {
      v: 1,
      expires_at_ms: now + 30 * 60 * 1000, // 30 minutes from now
      timezone: 'America/Los_Angeles',
      current: {
        time: '2026-05-06T11:30',
        temperature_c: 20.1,
        relative_humidity_pct: 60,
        precipitation_mm: 0,
        weather_code: 0,
      },
      daily: [
        {
          date: '2026-05-06',
          temperature_max_c: 24,
          temperature_min_c: 14,
          precipitation_sum_mm: 0,
          weather_code: 0,
        },
        {
          date: '2026-05-07',
          temperature_max_c: 22,
          temperature_min_c: 13,
          precipitation_sum_mm: 0.5,
          weather_code: 51,
        },
      ],
    };
    const kv = makeKV({
      [buildCacheKey(LA.latitude, LA.longitude)]: JSON.stringify(cached),
    });
    const fetchImpl = vi.fn();

    const res = await getWeather({
      ...LA,
      env: asEnv(kv),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      nowMs: () => now,
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(res.kind).toBe('cache_hit');
    if (res.kind === 'cache_hit') {
      expect(res.cached).toBe(true);
      expect(res.current.temperature_c).toBe(20.1);
      expect(res.daily[1].weather_code).toBe(51);
      expect(res.timezone).toBe('America/Los_Angeles');
    }
  });

  it('on cache miss → fetches → parses → writes to KV with TTL → returns ok', async () => {
    const kv = makeKV();
    const fetchImpl = vi.fn(async () => jsonResponse(meteoResponse()));

    const res = await getWeather({
      ...LA,
      env: asEnv(kv),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(res.kind).toBe('ok');
    if (res.kind === 'ok') {
      expect(res.cached).toBe(false);
      expect(res.current.temperature_c).toBe(22.4);
      expect(res.daily).toHaveLength(2);
      expect(res.daily[0].temperature_max_c).toBe(25.1);
      expect(res.daily[1].weather_code).toBe(61);
    }

    // Verify the write happened with the right key + TTL.
    expect(kv.put).toHaveBeenCalledTimes(1);
    const [putKey, putValue, putOpts] = kv.put.mock.calls[0];
    expect(putKey).toBe(buildCacheKey(LA.latitude, LA.longitude));
    expect(putOpts).toEqual({ expirationTtl: 3600 });
    const stored = JSON.parse(putValue as string);
    expect(stored.v).toBe(1);
    expect(typeof stored.expires_at_ms).toBe('number');
  });

  it('on expired cache entry → fetches fresh and overwrites KV', async () => {
    const now = 1_800_000_000_000;
    const stale = {
      v: 1,
      expires_at_ms: now - 60_000, // expired one minute ago
      timezone: 'America/Los_Angeles',
      current: {
        time: '2026-05-06T10:00',
        temperature_c: 5,
        relative_humidity_pct: 90,
        precipitation_mm: 0,
        weather_code: 0,
      },
      daily: [
        {
          date: '2026-05-06',
          temperature_max_c: 6,
          temperature_min_c: 1,
          precipitation_sum_mm: 0,
          weather_code: 0,
        },
        {
          date: '2026-05-07',
          temperature_max_c: 7,
          temperature_min_c: 2,
          precipitation_sum_mm: 0,
          weather_code: 0,
        },
      ],
    };
    const kv = makeKV({
      [buildCacheKey(LA.latitude, LA.longitude)]: JSON.stringify(stale),
    });
    const fetchImpl = vi.fn(async () => jsonResponse(meteoResponse()));

    const res = await getWeather({
      ...LA,
      env: asEnv(kv),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      nowMs: () => now,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(res.kind).toBe('ok');
    if (res.kind === 'ok') {
      expect(res.cached).toBe(false);
      // Fresh value, not the stale 5°C.
      expect(res.current.temperature_c).toBe(22.4);
    }
    expect(kv.put).toHaveBeenCalledTimes(1);
  });

  it('cache write failure does not poison the response', async () => {
    const kv = makeKV();
    kv.put.mockImplementation(async () => {
      throw new Error('KV write boom');
    });
    const fetchImpl = vi.fn(async () => jsonResponse(meteoResponse()));

    const res = await getWeather({
      ...LA,
      env: asEnv(kv),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    // Caller still gets the parsed payload; the cache is an optimization.
    expect(res.kind).toBe('ok');
  });
});

// --- request URL contract --------------------------------------------------

describe('getWeather — request URL', () => {
  it('builds the URL with current= and daily= field selection + timezone=auto + forecast_days=2', async () => {
    const kv = makeKV();
    let capturedUrl = '';
    const fetchImpl = vi.fn(async (url: unknown) => {
      capturedUrl = String(url);
      return jsonResponse(meteoResponse());
    });

    await getWeather({
      ...LA,
      env: asEnv(kv),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(capturedUrl).toContain('https://api.open-meteo.com/v1/forecast?');
    expect(capturedUrl).toContain('latitude=34.05');
    expect(capturedUrl).toContain('longitude=-118.24');
    // URLSearchParams encodes the comma-separated list.
    expect(capturedUrl).toMatch(/current=temperature_2m[^&]*relative_humidity_2m/);
    expect(capturedUrl).toMatch(/daily=temperature_2m_max[^&]*temperature_2m_min/);
    expect(capturedUrl).toContain('timezone=auto');
    expect(capturedUrl).toContain('forecast_days=2');
  });
});

// --- error paths -----------------------------------------------------------

describe('getWeather — error paths', () => {
  it('network thrown error → kind=network_error', async () => {
    const kv = makeKV();
    const fetchImpl = vi.fn(async () => {
      throw new Error('ENOTFOUND api.open-meteo.com');
    });

    const res = await getWeather({
      ...LA,
      env: asEnv(kv),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(res.kind).toBe('network_error');
    if (res.kind === 'network_error') {
      expect(res.message).toContain('ENOTFOUND');
    }
    expect(kv.put).not.toHaveBeenCalled();
  });

  it('HTTP 429 with Retry-After → kind=rate_limited with seconds', async () => {
    const kv = makeKV();
    const fetchImpl = vi.fn(
      async () =>
        new Response('rate limited', {
          status: 429,
          headers: { 'Retry-After': '42' },
        }),
    );

    const res = await getWeather({
      ...LA,
      env: asEnv(kv),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(res.kind).toBe('rate_limited');
    if (res.kind === 'rate_limited') {
      expect(res.retry_after).toBe(42);
    }
    expect(kv.put).not.toHaveBeenCalled();
  });

  it('HTTP 429 without Retry-After → kind=rate_limited with no retry_after', async () => {
    const kv = makeKV();
    const fetchImpl = vi.fn(
      async () => new Response('rate limited', { status: 429 }),
    );

    const res = await getWeather({
      ...LA,
      env: asEnv(kv),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(res.kind).toBe('rate_limited');
    if (res.kind === 'rate_limited') {
      expect(res.retry_after).toBeUndefined();
    }
  });

  it('HTTP 500 → kind=network_error (non-2xx that is not 429)', async () => {
    const kv = makeKV();
    const fetchImpl = vi.fn(async () => new Response('boom', { status: 500 }));

    const res = await getWeather({
      ...LA,
      env: asEnv(kv),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(res.kind).toBe('network_error');
    if (res.kind === 'network_error') {
      expect(res.message).toContain('500');
    }
    expect(kv.put).not.toHaveBeenCalled();
  });

  it('malformed JSON body → kind=parse_error', async () => {
    const kv = makeKV();
    const fetchImpl = vi.fn(
      async () =>
        new Response('this is not json', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );

    const res = await getWeather({
      ...LA,
      env: asEnv(kv),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(res.kind).toBe('parse_error');
    expect(kv.put).not.toHaveBeenCalled();
  });

  it('valid JSON but wrong shape → kind=parse_error', async () => {
    const kv = makeKV();
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        timezone: 'America/Los_Angeles',
        // missing current + daily
      }),
    );

    const res = await getWeather({
      ...LA,
      env: asEnv(kv),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(res.kind).toBe('parse_error');
    if (res.kind === 'parse_error') {
      expect(res.message).toContain('shape');
    }
    expect(kv.put).not.toHaveBeenCalled();
  });

  it('daily array with only 1 day → kind=parse_error (V1 lock: must be 2 days)', async () => {
    const kv = makeKV();
    const truncated = meteoResponse();
    truncated.daily.time = ['2026-05-06'];
    truncated.daily.temperature_2m_max = [25.1];
    truncated.daily.temperature_2m_min = [14.2];
    truncated.daily.precipitation_sum = [0];
    truncated.daily.weather_code = [0];
    const fetchImpl = vi.fn(async () => jsonResponse(truncated));

    const res = await getWeather({
      ...LA,
      env: asEnv(kv),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(res.kind).toBe('parse_error');
  });
});

// --- defensive input validation -------------------------------------------

describe('getWeather — input validation (defensive, BEFORE network)', () => {
  it('lat > 90 → parse_error and never fires fetch or KV', async () => {
    const kv = makeKV();
    const fetchImpl = vi.fn();

    const res = await getWeather({
      latitude: 91,
      longitude: 0,
      env: asEnv(kv),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(res.kind).toBe('parse_error');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(kv.get).not.toHaveBeenCalled();
    expect(kv.put).not.toHaveBeenCalled();
  });

  it('lat < -90 → parse_error', async () => {
    const kv = makeKV();
    const fetchImpl = vi.fn();
    const res = await getWeather({
      latitude: -91,
      longitude: 0,
      env: asEnv(kv),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.kind).toBe('parse_error');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('lon > 180 or < -180 → parse_error', async () => {
    const kv = makeKV();
    const fetchImpl = vi.fn();
    const r1 = await getWeather({
      latitude: 0,
      longitude: 181,
      env: asEnv(kv),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const r2 = await getWeather({
      latitude: 0,
      longitude: -181,
      env: asEnv(kv),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(r1.kind).toBe('parse_error');
    expect(r2.kind).toBe('parse_error');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('NaN / Infinity coords → parse_error', async () => {
    const kv = makeKV();
    const fetchImpl = vi.fn();
    const r1 = await getWeather({
      latitude: Number.NaN,
      longitude: 0,
      env: asEnv(kv),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const r2 = await getWeather({
      latitude: 0,
      longitude: Number.POSITIVE_INFINITY,
      env: asEnv(kv),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(r1.kind).toBe('parse_error');
    expect(r2.kind).toBe('parse_error');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('zero lat + zero lon (Gulf of Guinea) is valid', async () => {
    const kv = makeKV();
    const fetchImpl = vi.fn(async () => jsonResponse(meteoResponse()));
    const res = await getWeather({
      latitude: 0,
      longitude: 0,
      env: asEnv(kv),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.kind).toBe('ok');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('exact boundary coords (lat=90, lon=-180) are valid', async () => {
    const kv = makeKV();
    const fetchImpl = vi.fn(async () => jsonResponse(meteoResponse()));
    const res = await getWeather({
      latitude: 90,
      longitude: -180,
      env: asEnv(kv),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.kind).toBe('ok');
  });
});

// --- forecast shape contract -----------------------------------------------

describe('getWeather — payload shape', () => {
  it('returns 2 daily entries each with min/max/precip/code/date', async () => {
    const kv = makeKV();
    const fetchImpl = vi.fn(async () => jsonResponse(meteoResponse()));

    const res = await getWeather({
      ...LA,
      env: asEnv(kv),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(res.kind).toBe('ok');
    if (res.kind === 'ok') {
      expect(res.daily).toHaveLength(2);
      for (const d of res.daily) {
        expect(typeof d.date).toBe('string');
        expect(typeof d.temperature_max_c).toBe('number');
        expect(typeof d.temperature_min_c).toBe('number');
        expect(typeof d.precipitation_sum_mm).toBe('number');
        expect(typeof d.weather_code).toBe('number');
      }
    }
  });

  it('preserves the local-tz timezone string returned by Open-Meteo', async () => {
    const kv = makeKV();
    const fetchImpl = vi.fn(async () =>
      jsonResponse(meteoResponse({ timezone: 'Asia/Tokyo' })),
    );

    const res = await getWeather({
      latitude: 35.68,
      longitude: 139.69,
      env: asEnv(kv),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(res.kind).toBe('ok');
    if (res.kind === 'ok') {
      expect(res.timezone).toBe('Asia/Tokyo');
    }
  });
});

// --- concurrency -----------------------------------------------------------

describe('getWeather — concurrency', () => {
  it('two concurrent calls for the same key may both fetch (V1 accepts the race)', async () => {
    // V1 design decision (documented in the wrapper header): we accept the
    // single-flight race rather than introducing a per-key promise dedupe
    // table that would survive across requests in a Worker. The test locks
    // the V1 contract: both calls return successfully and both produce a
    // valid `ok` result. After the race, KV converges on a fresh value.
    const kv = makeKV();
    const fetchImpl = vi.fn(async () => jsonResponse(meteoResponse()));

    const [a, b] = await Promise.all([
      getWeather({
        ...LA,
        env: asEnv(kv),
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
      getWeather({
        ...LA,
        env: asEnv(kv),
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ]);

    expect(a.kind).toBe('ok');
    expect(b.kind).toBe('ok');
    // The race is allowed; we don't over-constrain to exactly 1 or 2.
    expect(fetchImpl.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(fetchImpl.mock.calls.length).toBeLessThanOrEqual(2);
  });
});

// Compile-time exhaustiveness on the discriminated union — guards against a
// future hand that collapses the union into a single `error` kind.
describe('GetWeatherResult — discriminated union exhaustiveness', () => {
  it('every kind has a unique discriminant string', () => {
    const kinds: GetWeatherResult['kind'][] = [
      'ok',
      'cache_hit',
      'network_error',
      'rate_limited',
      'parse_error',
    ];
    expect(new Set(kinds).size).toBe(kinds.length);
  });
});
