// Open-Meteo wrapper with KV-backed cache.
//
// Public surface: `getWeather({ latitude, longitude, env, fetchImpl?, nowMs? })`.
// Returns a discriminated union — never throws — so route handlers can render
// a deterministic fallback path on any failure mode without try/catch noise.
//
// Cache key: `weather:${lat.toFixed(2)}:${lon.toFixed(2)}`. Two-decimal rounding
// gives a ~1.1km grid (1 deg lat ≈ 111 km, so 0.01 deg ≈ 1.1km). Plant-care
// decisions don't care about sub-km weather variation, and the rounding lets
// neighbors share cache entries — important on Cloudflare's free KV tier where
// reads are billed and writes are scarce. Finer precision (toFixed(3) or
// rounding bands) was rejected per V1 scope locks; coarser would skip across
// city-scale microclimates.
//
// TTL: 3600s (1 hour) — locked by the master plan. Open-Meteo updates the
// `current_weather` block hourly anyway, and rules-engine consumers (E6-005)
// re-evaluate watering decisions at most a few times per day. KV's
// `expirationTtl` walks an entry out of storage automatically; we ALSO carry
// `expires_at_ms` in the value so a server clock skew + KV TTL drift can't
// hand back stale data on the read path.
//
// Validation: hand-rolled type guards over the parsed JSON. The backend already
// uses this style in `src/llm/safe-json.ts`; pulling in zod just for one shape
// would add a peer dep for a wrapper that should be ~200 lines.
//
// V1 scope locks (rejected reviewer suggestions):
//   - No provider abstraction layer. Open-Meteo is the only provider in V1.
//   - No retry/backoff. The mobile api-client (E2-005) owns retry semantics
//     for the upstream caller; this wrapper is single-shot.
//   - No 7-day forecast. V1 is current + 2 days.
//   - No geocoding. ZIP→lat/lon is E6-002's API endpoint concern.
//   - No timezone math here. `timezone=auto` keeps daily entries
//     local-relative; the engine consuming this data lives on-device where
//     the local-tz/UTC-ms boundary is already established.

const OPEN_METEO_URL = 'https://api.open-meteo.com/v1/forecast';
const CACHE_TTL_SECONDS = 3600; // 1 hour — master-plan lock
const CACHE_KEY_PREFIX = 'weather:';

export type DailyEntry = {
  /** ISO date in the location's local timezone (e.g. "2026-05-06"). */
  date: string;
  temperature_max_c: number;
  temperature_min_c: number;
  precipitation_sum_mm: number;
  /** WMO weather interpretation code. https://open-meteo.com/en/docs */
  weather_code: number;
};

export type CurrentWeather = {
  /** ISO timestamp in the location's local timezone. */
  time: string;
  temperature_c: number;
  relative_humidity_pct: number;
  precipitation_mm: number;
  weather_code: number;
};

export type WeatherPayload = {
  current: CurrentWeather;
  daily: [DailyEntry, DailyEntry];
  /** Resolved timezone string, e.g. "America/Los_Angeles". */
  timezone: string;
};

export type GetWeatherResult =
  | ({ kind: 'ok'; cached: false } & WeatherPayload)
  | ({ kind: 'cache_hit'; cached: true } & WeatherPayload)
  | { kind: 'network_error'; message: string }
  | { kind: 'rate_limited'; retry_after?: number }
  | { kind: 'parse_error'; message: string };

export type GetWeatherArgs = {
  latitude: number;
  longitude: number;
  /** KV binding for the cache. */
  env: { WEATHER_CACHE: KVNamespace };
  /** Injection seam for tests. */
  fetchImpl?: typeof fetch;
  /** Injection seam for tests; defaults to `Date.now()`. */
  nowMs?: () => number;
};

type CacheEnvelope = WeatherPayload & {
  /** UTC ms after which the entry is stale. Defense in depth alongside KV TTL. */
  expires_at_ms: number;
  /** Schema version — bump if the payload shape changes so old entries don't deserialize wrong. */
  v: 1;
};

export async function getWeather(args: GetWeatherArgs): Promise<GetWeatherResult> {
  const { latitude, longitude, env } = args;
  const fetchImpl = args.fetchImpl ?? fetch;
  const now = args.nowMs ?? (() => Date.now());

  // 1. Defensive input validation BEFORE any IO. An invalid lat/lon should
  //    fail fast — never burn a KV read or a network call on input the
  //    upstream service will reject anyway.
  if (!isValidCoordinate(latitude, longitude)) {
    return {
      kind: 'parse_error',
      message: `invalid_coordinates: lat=${latitude} lon=${longitude}`,
    };
  }

  const cacheKey = buildCacheKey(latitude, longitude);

  // 2. Cache read. KV read is cheap; on hit we return without touching the
  //    network. The `expires_at_ms` check is belt-and-suspenders alongside KV
  //    TTL — KV's expiration is eventually consistent at the edge, so a value
  //    can technically come back after its TTL has elapsed.
  const cached = await readCache(env.WEATHER_CACHE, cacheKey);
  if (cached && cached.expires_at_ms > now()) {
    return {
      kind: 'cache_hit',
      cached: true,
      current: cached.current,
      daily: cached.daily,
      timezone: cached.timezone,
    };
  }

  // 3. Cache miss / expired → fetch.
  const url = buildRequestUrl(latitude, longitude);
  let res: Response;
  try {
    res = await fetchImpl(url, { method: 'GET' });
  } catch (e) {
    return { kind: 'network_error', message: errorMessage(e) };
  }

  if (res.status === 429) {
    const retryAfter = parseRetryAfter(res.headers.get('Retry-After'));
    return retryAfter !== undefined
      ? { kind: 'rate_limited', retry_after: retryAfter }
      : { kind: 'rate_limited' };
  }

  if (!res.ok) {
    return {
      kind: 'network_error',
      message: `open_meteo_http_${res.status}`,
    };
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch (e) {
    return { kind: 'parse_error', message: `body_not_json: ${errorMessage(e)}` };
  }

  const payload = normalizeResponse(json);
  if (!payload) {
    return { kind: 'parse_error', message: 'response_shape_mismatch' };
  }

  // 4. Write to KV ONLY after a successful parse — never cache garbage. Even
  //    if KV is down or throws, we still return the parsed payload to the
  //    caller (the cache is an optimization, not a correctness barrier).
  const envelope: CacheEnvelope = {
    ...payload,
    expires_at_ms: now() + CACHE_TTL_SECONDS * 1000,
    v: 1,
  };
  try {
    await env.WEATHER_CACHE.put(cacheKey, JSON.stringify(envelope), {
      expirationTtl: CACHE_TTL_SECONDS,
    });
  } catch {
    // Swallow: KV write failure shouldn't kill the request. Logging hook
    // is observability/* — the wrangler.toml `[observability]` block
    // already captures uncaught exceptions, but this is intentionally
    // caught.
  }

  return {
    kind: 'ok',
    cached: false,
    current: payload.current,
    daily: payload.daily,
    timezone: payload.timezone,
  };
}

// --- helpers ---------------------------------------------------------------

function isValidCoordinate(lat: number, lon: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= -90 &&
    lat <= 90 &&
    lon >= -180 &&
    lon <= 180
  );
}

export function buildCacheKey(lat: number, lon: number): string {
  // toFixed(2) on negative numbers preserves the sign ("-118.24"), which is
  // what we want — the key has to round-trip uniquely for both hemispheres.
  // toFixed avoids the Number → string locale formatting trap where some
  // locales render "-118,24" with a comma decimal.
  return `${CACHE_KEY_PREFIX}${lat.toFixed(2)}:${lon.toFixed(2)}`;
}

function buildRequestUrl(lat: number, lon: number): string {
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    current: 'temperature_2m,relative_humidity_2m,precipitation,weather_code',
    daily: 'temperature_2m_max,temperature_2m_min,precipitation_sum,weather_code',
    timezone: 'auto',
    forecast_days: '2',
  });
  return `${OPEN_METEO_URL}?${params.toString()}`;
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  // Open-Meteo (and most CF-fronted APIs) emit Retry-After as integer seconds.
  // RFC 7231 also permits an HTTP-date; we don't support that form (the api
  // we wrap doesn't emit it, and parsing dates here adds attack surface).
  const n = Number(header);
  if (Number.isFinite(n) && n >= 0) return Math.floor(n);
  return undefined;
}

async function readCache(
  kv: KVNamespace,
  key: string,
): Promise<CacheEnvelope | null> {
  let raw: string | null;
  try {
    raw = await kv.get(key);
  } catch {
    // KV read failure is treated as a miss — we still try the network.
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isCacheEnvelope(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function isCacheEnvelope(x: unknown): x is CacheEnvelope {
  if (!isRecord(x)) return false;
  if (x.v !== 1) return false;
  if (typeof x.expires_at_ms !== 'number') return false;
  if (typeof x.timezone !== 'string') return false;
  if (!isCurrentWeather(x.current)) return false;
  if (!isDailyTuple(x.daily)) return false;
  return true;
}

function isCurrentWeather(x: unknown): x is CurrentWeather {
  if (!isRecord(x)) return false;
  return (
    typeof x.time === 'string' &&
    typeof x.temperature_c === 'number' &&
    typeof x.relative_humidity_pct === 'number' &&
    typeof x.precipitation_mm === 'number' &&
    typeof x.weather_code === 'number'
  );
}

function isDailyEntry(x: unknown): x is DailyEntry {
  if (!isRecord(x)) return false;
  return (
    typeof x.date === 'string' &&
    typeof x.temperature_max_c === 'number' &&
    typeof x.temperature_min_c === 'number' &&
    typeof x.precipitation_sum_mm === 'number' &&
    typeof x.weather_code === 'number'
  );
}

function isDailyTuple(x: unknown): x is [DailyEntry, DailyEntry] {
  return Array.isArray(x) && x.length === 2 && isDailyEntry(x[0]) && isDailyEntry(x[1]);
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

// Map the raw Open-Meteo response onto our internal shape. The Open-Meteo
// response uses `current.temperature_2m` etc; we normalize to
// `current.temperature_c` so consumers don't have to know about the WMO field
// naming convention. The `daily` block in the upstream is a column-major shape
// (parallel arrays); we transpose to a row-major tuple so consumers don't have
// to index by position across four arrays.
function normalizeResponse(raw: unknown): WeatherPayload | null {
  if (!isRecord(raw)) return null;

  const current = raw.current;
  const daily = raw.daily;
  const timezone = raw.timezone;
  if (typeof timezone !== 'string') return null;
  if (!isRecord(current) || !isRecord(daily)) return null;

  const cur: CurrentWeather = {
    time: typeof current.time === 'string' ? current.time : '',
    temperature_c: numOrNaN(current.temperature_2m),
    relative_humidity_pct: numOrNaN(current.relative_humidity_2m),
    precipitation_mm: numOrNaN(current.precipitation),
    weather_code: numOrNaN(current.weather_code),
  };
  if (!isCurrentWeather(cur) || !cur.time) return null;
  if (!Number.isFinite(cur.temperature_c)) return null;

  const dates = daily.time;
  const tmax = daily.temperature_2m_max;
  const tmin = daily.temperature_2m_min;
  const psum = daily.precipitation_sum;
  const codes = daily.weather_code;
  if (
    !Array.isArray(dates) ||
    !Array.isArray(tmax) ||
    !Array.isArray(tmin) ||
    !Array.isArray(psum) ||
    !Array.isArray(codes)
  ) {
    return null;
  }
  if (dates.length < 2) return null;

  const dailyTuple: [DailyEntry, DailyEntry] = [
    {
      date: String(dates[0] ?? ''),
      temperature_max_c: numOrNaN(tmax[0]),
      temperature_min_c: numOrNaN(tmin[0]),
      precipitation_sum_mm: numOrNaN(psum[0]),
      weather_code: numOrNaN(codes[0]),
    },
    {
      date: String(dates[1] ?? ''),
      temperature_max_c: numOrNaN(tmax[1]),
      temperature_min_c: numOrNaN(tmin[1]),
      precipitation_sum_mm: numOrNaN(psum[1]),
      weather_code: numOrNaN(codes[1]),
    },
  ];
  if (!isDailyEntry(dailyTuple[0]) || !isDailyEntry(dailyTuple[1])) return null;
  if (!dailyTuple[0].date || !dailyTuple[1].date) return null;

  return { current: cur, daily: dailyTuple, timezone };
}

function numOrNaN(x: unknown): number {
  return typeof x === 'number' && Number.isFinite(x) ? x : NaN;
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
