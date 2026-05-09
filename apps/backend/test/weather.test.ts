// Tests for GET /api/weather (E6-002).
//
// The route is a thin wrapper around `getWeather()` (E6-001). The wrapper's
// own happy/edge-path coverage already lives in `openMeteo.test.ts` (32 tests
// against the cache layer, URL contract, error paths, input validation,
// payload shape, concurrency, and discriminated-union exhaustiveness). These
// tests focus on the HTTP-boundary concerns that the route OWNS:
//   - query-string parsing (lat / lon presence, type, range, junk-input)
//   - discriminated-union → HTTP status mapping
//   - x-cache header propagation (hit vs miss surfaced via header, NOT body)
//   - Retry-After header propagation on 429
//   - the on-the-wire `WeatherResponse` payload shape doesn't leak the
//     wrapper's internal `kind` / `cached` discriminators
//
// Style mirrors `identify.test.ts`: drive through `SELF.fetch` so the route
// composition (Hono mounting, env binding, header plumbing) is exercised
// end-to-end inside the workerd-like environment. Open-Meteo is intercepted
// via `fetchMock` rather than passing a `fetchImpl` (the route handler doesn't
// expose a DI seam — that's intentional, the wrapper does).
//
// Per-test isolation: each test uses a UNIQUE lat/lon so the KV cache key
// (`weather:${lat.toFixed(2)}:${lon.toFixed(2)}`) doesn't carry over between
// tests. vitest-pool-workers does isolate storage per file by default but not
// per test within a file; rather than relying on framework-level magic, the
// per-test coordinate discipline makes the test boundary explicit.

import { SELF, fetchMock } from 'cloudflare:test';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ApiResult, WeatherResponse } from '@plantcare/api-types';

const URL_BASE = 'https://plantcare-api.test/api/weather';
const OPEN_METEO = 'https://api.open-meteo.com';

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

// Build a query string. Helper exists because we want consistent encoding
// of the lat/lon pair across tests, and because `?lat=&lon=` style empty-
// string cases need a way to pass through `undefined` without URLSearchParams
// silently dropping the key.
function urlOf(opts: { lat?: string; lon?: string }) {
  const parts: string[] = [];
  if (opts.lat !== undefined) parts.push(`lat=${encodeURIComponent(opts.lat)}`);
  if (opts.lon !== undefined) parts.push(`lon=${encodeURIComponent(opts.lon)}`);
  const qs = parts.length ? `?${parts.join('&')}` : '';
  return `${URL_BASE}${qs}`;
}

// Canonical Open-Meteo response for our parameter selection. Mirrors the
// shape used in `openMeteo.test.ts` — same field names, same array shapes,
// same parameter set as the wrapper builds via URLSearchParams.
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

// Intercept Open-Meteo's /v1/forecast with a JSON body. Regex path match so
// the interceptor matches regardless of which lat/lon (and other params) the
// wrapper appends — the URL contract (current= / daily= / timezone= /
// forecast_days=) is already locked in openMeteo.test.ts; duplicating it here
// would couple the route tests to wrapper internals.
function mockMeteoRegex(
  body: object | string,
  status = 200,
  headers?: Record<string, string>,
) {
  fetchMock
    .get(OPEN_METEO)
    .intercept({ path: /^\/v1\/forecast(\?.*)?$/, method: 'GET' })
    .reply(status, body, { headers });
}

// --- happy path ------------------------------------------------------------

describe('GET /api/weather — happy path', () => {
  it('200 with current + 2 daily entries on cache miss', async () => {
    mockMeteoRegex(meteoResponse());
    const res = await SELF.fetch(urlOf({ lat: '34.05', lon: '-118.24' }));
    expect(res.status).toBe(200);
    expect(res.headers.get('x-cache')).toBe('miss');
    const body = (await res.json()) as ApiResult<WeatherResponse>;
    expect(body.ok).toBe(true);
    if (body.ok && body.kind === 'success') {
      expect(body.data.timezone).toBe('America/Los_Angeles');
      expect(body.data.current.temperature_c).toBe(22.4);
      expect(body.data.daily).toHaveLength(2);
      expect(body.data.daily[0].temperature_max_c).toBe(25.1);
      expect(body.data.daily[1].weather_code).toBe(61);
    }
  });

  it('payload does NOT leak the wrapper kind / cached fields', async () => {
    // The route must surface cache state via header only — never as a payload
    // discriminator. A future caching change should not be observable in
    // `body.data`. This locks the contract.
    mockMeteoRegex(meteoResponse());
    const res = await SELF.fetch(urlOf({ lat: '40.71', lon: '-74.00' }));
    const body = (await res.json()) as ApiResult<WeatherResponse>;
    expect(body.ok).toBe(true);
    if (body.ok && body.kind === 'success') {
      const data = body.data as Record<string, unknown>;
      expect(data.kind).toBeUndefined();
      expect(data.cached).toBeUndefined();
    }
  });

  it('x-cache: hit on second call to same coords (KV write happened on first)', async () => {
    // First call: miss → wrapper fetches upstream and writes to KV.
    // Second call: hit → wrapper short-circuits on the KV value, no upstream
    // request fires. fetchMock would assert a pending interceptor if we
    // pre-registered one for the second call — which is exactly the proof
    // we want for "no upstream call on hit."
    mockMeteoRegex(meteoResponse());
    const url = urlOf({ lat: '47.61', lon: '-122.33' });

    const res1 = await SELF.fetch(url);
    expect(res1.status).toBe(200);
    expect(res1.headers.get('x-cache')).toBe('miss');
    await res1.json();

    const res2 = await SELF.fetch(url);
    expect(res2.status).toBe(200);
    expect(res2.headers.get('x-cache')).toBe('hit');
    const body = (await res2.json()) as ApiResult<WeatherResponse>;
    expect(body.ok).toBe(true);
    if (body.ok && body.kind === 'success') {
      // Same payload as miss — cache state is invisible to the consumer.
      expect(body.data.current.temperature_c).toBe(22.4);
      expect(body.data.daily).toHaveLength(2);
    }
  });

  it('boundary lat=90, lon=180 is accepted', async () => {
    mockMeteoRegex(meteoResponse({ timezone: 'UTC' }));
    const res = await SELF.fetch(urlOf({ lat: '90', lon: '180' }));
    expect(res.status).toBe(200);
  });

  it('boundary lat=-90, lon=-180 is accepted', async () => {
    mockMeteoRegex(meteoResponse({ timezone: 'UTC' }));
    const res = await SELF.fetch(urlOf({ lat: '-90', lon: '-180' }));
    expect(res.status).toBe(200);
  });

  it('zero / zero is accepted (Gulf of Guinea)', async () => {
    mockMeteoRegex(meteoResponse({ timezone: 'UTC' }));
    const res = await SELF.fetch(urlOf({ lat: '0', lon: '0' }));
    expect(res.status).toBe(200);
  });
});

// --- input validation ------------------------------------------------------

describe('GET /api/weather — input validation', () => {
  it('400 when lat is missing', async () => {
    const res = await SELF.fetch(urlOf({ lon: '0' }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as ApiResult<WeatherResponse>;
    expect(body).toEqual({ ok: false, kind: 'error', message: 'invalid_lat' });
  });

  it('400 when lon is missing', async () => {
    const res = await SELF.fetch(urlOf({ lat: '0' }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as ApiResult<WeatherResponse>;
    expect(body).toEqual({ ok: false, kind: 'error', message: 'invalid_lon' });
  });

  it('400 when both are missing', async () => {
    const res = await SELF.fetch(URL_BASE);
    expect(res.status).toBe(400);
  });

  it('400 when lat is empty string', async () => {
    // Catches the `Number("") → 0` trap — empty string would clearly be
    // garbage input, but it would silently pass a `lat ∈ [-90, 90]` check.
    const res = await SELF.fetch(urlOf({ lat: '', lon: '0' }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as ApiResult<WeatherResponse>;
    expect(body).toEqual({ ok: false, kind: 'error', message: 'invalid_lat' });
  });

  it('400 when lat is whitespace', async () => {
    // `Number(" ") → 0`. Same trap as the empty-string case.
    const res = await SELF.fetch(urlOf({ lat: '   ', lon: '0' }));
    expect(res.status).toBe(400);
  });

  it('400 when lat is non-numeric', async () => {
    const res = await SELF.fetch(urlOf({ lat: 'abc', lon: '0' }));
    expect(res.status).toBe(400);
  });

  it('400 when lat is hex (rejects 0x10)', async () => {
    // `Number("0x10") → 16`. Without a strict regex, a "0x10" lat would
    // pass the range check.
    const res = await SELF.fetch(urlOf({ lat: '0x10', lon: '0' }));
    expect(res.status).toBe(400);
  });

  it('400 when lat is scientific notation', async () => {
    // `Number("1e3") → 1000`. Range check would reject 1000 anyway, but
    // a `1e1` lat (= 10) would silently pass — strict regex rejects it.
    const res = await SELF.fetch(urlOf({ lat: '1e1', lon: '0' }));
    expect(res.status).toBe(400);
  });

  it('400 when lat > 90', async () => {
    const res = await SELF.fetch(urlOf({ lat: '91', lon: '0' }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as ApiResult<WeatherResponse>;
    expect(body).toEqual({ ok: false, kind: 'error', message: 'invalid_lat' });
  });

  it('400 when lat < -90', async () => {
    const res = await SELF.fetch(urlOf({ lat: '-90.001', lon: '0' }));
    expect(res.status).toBe(400);
  });

  it('400 when lon > 180', async () => {
    const res = await SELF.fetch(urlOf({ lat: '0', lon: '181' }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as ApiResult<WeatherResponse>;
    expect(body).toEqual({ ok: false, kind: 'error', message: 'invalid_lon' });
  });

  it('400 when lon < -180', async () => {
    const res = await SELF.fetch(urlOf({ lat: '0', lon: '-300' }));
    expect(res.status).toBe(400);
  });

  it('input validation fires BEFORE the wrapper / Open-Meteo call', async () => {
    // No `mockMeteoRegex` registered — if the route reached the wrapper and
    // the wrapper tried to fetch upstream, fetchMock's `disableNetConnect`
    // would throw. The test passing on a 400 proves the bail-out happens
    // before any IO.
    const res = await SELF.fetch(urlOf({ lat: '999', lon: '0' }));
    expect(res.status).toBe(400);
  });
});

// --- discriminated union → HTTP mapping ------------------------------------

describe('GET /api/weather — wrapper result mapping', () => {
  it('502 on upstream network error (HTTP 500)', async () => {
    // Wrapper maps non-2xx (non-429) to `network_error`; route maps that to
    // 502 Bad Gateway with a stable error message.
    mockMeteoRegex('upstream blew up', 500);
    const res = await SELF.fetch(urlOf({ lat: '12.34', lon: '56.78' }));
    expect(res.status).toBe(502);
    const body = (await res.json()) as ApiResult<WeatherResponse>;
    expect(body).toEqual({ ok: false, kind: 'error', message: 'upstream_unavailable' });
  });

  it('429 with Retry-After: 42 propagates to the response header', async () => {
    mockMeteoRegex('rate limited', 429, { 'Retry-After': '42' });
    const res = await SELF.fetch(urlOf({ lat: '11.11', lon: '22.22' }));
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('42');
    const body = (await res.json()) as ApiResult<WeatherResponse>;
    expect(body.ok).toBe(false);
    if (!body.ok && body.kind === 'rate_limited') {
      expect(body.retry_after_seconds).toBe(42);
    }
  });

  it('429 without Retry-After omits the header AND the body field (no fabricated 0)', async () => {
    mockMeteoRegex('rate limited', 429);
    const res = await SELF.fetch(urlOf({ lat: '13.33', lon: '24.44' }));
    expect(res.status).toBe(429);
    // Wrapper's parseRetryAfter returns undefined when the upstream header
    // is absent → route omits BOTH the response header AND the body field.
    // A fabricated `retry_after_seconds: 0` would be read by mobile's
    // `classifyResponse` as "retry immediately" (its `??` chain doesn't
    // short-circuit on numeric 0), causing a retry storm against the same
    // rate-limited upstream. This test locks the absence.
    expect(res.headers.get('Retry-After')).toBeNull();
    const body = (await res.json()) as ApiResult<WeatherResponse>;
    expect(body.ok).toBe(false);
    if (!body.ok && body.kind === 'rate_limited') {
      // Field omitted from the wire — it's now optional in the api-types union.
      expect(body.retry_after_seconds).toBeUndefined();
      expect(Object.prototype.hasOwnProperty.call(body, 'retry_after_seconds')).toBe(false);
    }
  });

  it('429 with malformed Retry-After ("0.9") → no header AND no body field propagated', async () => {
    // The wrapper strict-parses Retry-After; "0.9" → undefined. The route
    // reflects that by omitting BOTH the response header AND the body
    // `retry_after_seconds` field. Naive `Number("0.9")` would have floored
    // to 0 → immediate-retry storm; an honest `retry_after_seconds: 0`
    // would have done the same on the body fallback path.
    mockMeteoRegex('rate limited', 429, { 'Retry-After': '0.9' });
    const res = await SELF.fetch(urlOf({ lat: '15.55', lon: '26.66' }));
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBeNull();
    const body = (await res.json()) as ApiResult<WeatherResponse>;
    if (!body.ok && body.kind === 'rate_limited') {
      expect(body.retry_after_seconds).toBeUndefined();
    }
  });

  it('502 on upstream parse_error (valid JSON, wrong shape)', async () => {
    // The wrapper produces parse_error when the JSON is well-formed but the
    // schema doesn't match — the route maps that to 502 with a distinct
    // error message so ops can tell parse_error from network_error spikes.
    mockMeteoRegex({ timezone: 'UTC' /* missing current + daily */ });
    const res = await SELF.fetch(urlOf({ lat: '17.77', lon: '28.88' }));
    expect(res.status).toBe(502);
    const body = (await res.json()) as ApiResult<WeatherResponse>;
    expect(body).toEqual({
      ok: false,
      kind: 'error',
      message: 'upstream_invalid_response',
    });
  });

  it('502 on malformed JSON body', async () => {
    fetchMock
      .get(OPEN_METEO)
      .intercept({ path: /^\/v1\/forecast(\?.*)?$/, method: 'GET' })
      .reply(200, 'this is not json', {
        headers: { 'content-type': 'application/json' },
      });
    const res = await SELF.fetch(urlOf({ lat: '19.99', lon: '30.10' }));
    expect(res.status).toBe(502);
    const body = (await res.json()) as ApiResult<WeatherResponse>;
    expect(body.ok).toBe(false);
    if (!body.ok && body.kind === 'error') {
      expect(body.message).toBe('upstream_invalid_response');
    }
  });
});

// --- payload contract ------------------------------------------------------

describe('GET /api/weather — payload contract', () => {
  it('every daily entry has date / temperature_max_c / temperature_min_c / precipitation_sum_mm / weather_code', async () => {
    mockMeteoRegex(meteoResponse());
    const res = await SELF.fetch(urlOf({ lat: '21.21', lon: '32.32' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as ApiResult<WeatherResponse>;
    expect(body.ok).toBe(true);
    if (body.ok && body.kind === 'success') {
      expect(body.data.daily).toHaveLength(2);
      for (const d of body.data.daily) {
        expect(typeof d.date).toBe('string');
        expect(typeof d.temperature_max_c).toBe('number');
        expect(typeof d.temperature_min_c).toBe('number');
        expect(typeof d.precipitation_sum_mm).toBe('number');
        expect(typeof d.weather_code).toBe('number');
      }
    }
  });

  it('current carries time / temperature_c / relative_humidity_pct / precipitation_mm / weather_code', async () => {
    mockMeteoRegex(meteoResponse());
    const res = await SELF.fetch(urlOf({ lat: '23.23', lon: '34.34' }));
    const body = (await res.json()) as ApiResult<WeatherResponse>;
    if (body.ok && body.kind === 'success') {
      const cur = body.data.current;
      expect(typeof cur.time).toBe('string');
      expect(typeof cur.temperature_c).toBe('number');
      expect(typeof cur.relative_humidity_pct).toBe('number');
      expect(typeof cur.precipitation_mm).toBe('number');
      expect(typeof cur.weather_code).toBe('number');
    }
  });

  it('preserves the local-tz timezone string from upstream', async () => {
    mockMeteoRegex(meteoResponse({ timezone: 'Asia/Tokyo' }));
    const res = await SELF.fetch(urlOf({ lat: '35.68', lon: '139.69' }));
    const body = (await res.json()) as ApiResult<WeatherResponse>;
    if (body.ok && body.kind === 'success') {
      expect(body.data.timezone).toBe('Asia/Tokyo');
    }
  });
});
