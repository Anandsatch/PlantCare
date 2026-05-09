// GET /api/weather?lat=<-90..90>&lon=<-180..180>
//
// Thin Hono wrapper over `getWeather()` (E6-001) — the wrapper owns cache, TTL,
// upstream Open-Meteo URL construction, and discriminated-union error mapping.
// This route's only job is:
//   1. Parse + validate query params (rejecting BEFORE the wrapper call —
//      defense in depth, even though the wrapper itself also validates).
//   2. Map the wrapper's `GetWeatherResult` discriminated union onto HTTP
//      status codes and a stable on-the-wire shape (`WeatherResponse`).
//   3. Surface cache hits via the `x-cache` response header — NEVER in the
//      payload — so the client contract is identical for hits and misses.
//
// Request shape — GET with query params (not POST + body) for two reasons:
//   - It's idempotent + cacheable in HTTP semantic terms; the upstream
//     Open-Meteo API itself is GET, so mirroring that is least-surprise.
//   - The other backend routes are POST because they carry multipart image
//     bodies; weather has no body, and a POST with empty body would muddle
//     the convention.
//
// V1 scope locks (rejected reviewer suggestions):
//   - No route-layer cache. The E6-001 wrapper owns the cache; layering a
//     second cache here would just hide its hit/miss signal from the
//     `x-cache` header and double the staleness budget.
//   - No new rate-limit middleware. Per the master plan + wrangler.toml,
//     V1 keeps rate-limit + budget tracking client-side; the existing routes
//     (/api/identify, /api/diagnose, etc.) carry no server-side limiter
//     either. When sharing begins, a KV-backed token bucket lands as a
//     shared middleware across all routes, not just here.
//   - No geocoding. ZIP → lat/lon happens on the mobile side (E6-003).
//   - No 7-day forecast. V1 = current + 2 days, locked by the wrapper's
//     `forecast_days=2` URL param and the `WeatherResponse` daily tuple type.

import { Hono } from 'hono';
import type { ApiResult, WeatherResponse } from '@plantcare/api-types';
import type { HonoEnv } from '../env';
import { getWeather } from '../lib/openMeteo';

export const weatherRoute = new Hono<HonoEnv>().get('/', async (c) => {
  const latRaw = c.req.query('lat');
  const lonRaw = c.req.query('lon');

  const lat = parseCoordinate(latRaw);
  const lon = parseCoordinate(lonRaw);
  if (lat === null || lat < -90 || lat > 90) {
    return c.json<ApiResult<WeatherResponse>>(
      { ok: false, kind: 'error', message: 'invalid_lat' },
      400,
    );
  }
  if (lon === null || lon < -180 || lon > 180) {
    return c.json<ApiResult<WeatherResponse>>(
      { ok: false, kind: 'error', message: 'invalid_lon' },
      400,
    );
  }

  const result = await getWeather({
    latitude: lat,
    longitude: lon,
    env: c.env,
  });

  switch (result.kind) {
    case 'ok':
    case 'cache_hit': {
      // Surface cache state via header, NOT payload. Mobile shouldn't branch
      // its watering-rules engine on hit vs miss — the data is the data.
      // This header is purely informational (debug, eval harness, ops).
      c.header('x-cache', result.kind === 'cache_hit' ? 'hit' : 'miss');
      const body: WeatherResponse = {
        current: result.current,
        daily: result.daily,
        timezone: result.timezone,
      };
      return c.json<ApiResult<WeatherResponse>>(
        { ok: true, kind: 'success', data: body },
        200,
      );
    }
    case 'rate_limited': {
      // Propagate Retry-After so the mobile api-client backoff (E2-005) can
      // honor upstream's signal. Header value is seconds (RFC 7231); when
      // the wrapper has no value (malformed/missing upstream header), we
      // omit BOTH the header AND the body field rather than fabricate `0`.
      // Mobile's `classifyResponse` does `headerRetryAfter ?? bodyRetryAfter`
      // and `??` does NOT short-circuit on the numeric 0 — a fabricated
      // `retry_after_seconds: 0` would be read as "retry immediately,"
      // exactly the opposite of what we want. The api-types union types
      // `retry_after_seconds` as optional for this reason.
      if (typeof result.retry_after === 'number') {
        c.header('Retry-After', String(result.retry_after));
        return c.json<ApiResult<WeatherResponse>>(
          {
            ok: false,
            kind: 'rate_limited',
            retry_after_seconds: result.retry_after,
          },
          429,
        );
      }
      return c.json<ApiResult<WeatherResponse>>(
        { ok: false, kind: 'rate_limited' },
        429,
      );
    }
    case 'network_error': {
      // 502 — we couldn't reach Open-Meteo. The mobile client treats this
      // the same as any other transient upstream failure: degrade gracefully
      // (no weather modifier in the rules engine) rather than block the UI.
      return c.json<ApiResult<WeatherResponse>>(
        { ok: false, kind: 'error', message: 'upstream_unavailable' },
        502,
      );
    }
    case 'parse_error': {
      // 502 — we reached upstream but couldn't make sense of the response.
      // Same client behavior as network_error; the distinction matters for
      // ops/observability (a parse_error spike means upstream changed shape).
      return c.json<ApiResult<WeatherResponse>>(
        { ok: false, kind: 'error', message: 'upstream_invalid_response' },
        502,
      );
    }
    default: {
      // Exhaustiveness firewall: if a future GetWeatherResult kind lands
      // without a switch arm here, this line stops compiling. Without it,
      // tsconfig's lack of `noImplicitReturns` lets a missing case fall
      // through to `undefined`, which Hono would 500 on at runtime.
      const _exhaustive: never = result;
      return _exhaustive;
    }
  }
});

// Strict numeric parse for query params. `Number(undefined)` → NaN, but
// `Number("")` → 0 and `Number(" ")` → 0, both of which would silently pass a
// `lat ∈ [-90, 90]` range check while clearly being garbage input. This guard
// rejects: undefined, empty string, whitespace-only, and any non-numeric form.
// Returns `null` on rejection; callers do their own range check on the number.
function parseCoordinate(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  // Accept: optional leading +/-, integer or decimal. Reject: hex (0x10),
  // scientific (1e3), trailing junk, whitespace inside the number.
  if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(trimmed)) return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return null;
  return n;
}
