/**
 * useWeather — mobile-side wrapper around `GET /api/weather?lat=&lon=`.
 *
 * Surface (mirrors `useDiagnoseRequest`):
 *   const { fetchWeather, status, lastResult } = useWeather({ apiClient });
 *   const result = await fetchWeather({ latitude, longitude });
 *   if (result.kind === 'ok') { use result.data } else switch (result.kind) { ... }
 *
 * Returned discriminated union (LOCKED — do NOT collapse):
 *   - 'ok'             — 200 with payload, fresh from upstream.
 *   - 'cache_hit'      — RESERVED forward-compat. The contract signal is
 *                        the `x-cache: hit` response header on the wire,
 *                        but the api client's `send()` path does not
 *                        propagate response headers through `ApiResult`,
 *                        so this hook NEVER emits `cache_hit` today. The
 *                        kind stays in the union so a future api-client
 *                        change that surfaces the header (or a backend
 *                        that mirrors the kind into the body) is NOT a
 *                        breaking type change for screens that switch on
 *                        `result.kind`. Tests assert the unreachability
 *                        explicitly so this comment can't drift out of
 *                        sync with the implementation.
 *   - 'rate_limited'   — emitted when the api client surfaces `kind:
 *                        'server'` with `retry_after` populated. The
 *                        client's classifier (`client.ts:classifyResponse`)
 *                        ALWAYS sets `retry_after` for 429 (header or body
 *                        `retry_after_seconds`) and only OPTIONALLY sets
 *                        it for 5xx (when the response carries a
 *                        Retry-After header — uncommon for plain 503s).
 *                        We accept the rare 5xx-with-Retry-After
 *                        misclassification because the rules engine
 *                        treats both cases the same (skip the modifier
 *                        on this call) and the rate-limit signal is what
 *                        diagnostic consumers + telemetry care about.
 *                        Post-V1, when the api client adds a first-class
 *                        `rate_limited` variant, the classifier here
 *                        becomes a one-line passthrough without a
 *                        breaking type change for consumers.
 *   - 'network_error'  — fetch threw before producing a response (DNS,
 *                        TLS, captive portal, server unreachable). The
 *                        api client's `kind: 'network'` and `kind: 'timeout'`
 *                        both land here for the rules engine — both are
 *                        "we couldn't get fresh weather, fall back to no
 *                        modifier" from the engine's POV. We keep them
 *                        distinct in the api client (different copy in
 *                        diagnose UI) but collapse them at this hook
 *                        boundary because the rules engine is the only
 *                        consumer and it does not differentiate.
 *   - 'parse_error'    — body wasn't shape-conformant (deploy skew).
 *   - 'queued'         — offline / network-degraded path. Same coercion
 *                        pattern as `useDiagnoseRequest`: `network` →
 *                        `queued` so the rules engine sees a "no weather
 *                        right now, degrade gracefully" signal rather than
 *                        an error. Per master plan line 346: any
 *                        LLM/network-dependent action taken offline gets
 *                        the tan banner + saved-for-later semantics.
 *
 * V1 scope locks honored here:
 *   - No actual sync_queue persistence — same forward-compat placeholder
 *     as useDiagnoseRequest. E7-004 will wire real persistence under this
 *     branch without changing the hook's external contract.
 *   - No NetInfo dependency. The hook accepts a `netInfo` injection point
 *     that defaults to "always online"; the api client's `network` kind
 *     handles the actual offline detection today.
 *   - No retry / backoff. The api client surfaces failures faithfully and
 *     this hook coerces them into the locked union.
 *   - No cache here. The backend's KV cache (E6-001) is the only cache;
 *     a second cache at the hook level would just hide the hit/miss
 *     signal and double the staleness budget.
 *
 * Race semantics:
 *   Same call-counter pattern as useDiagnoseRequest. If `fetchWeather()`
 *   is called while a previous call is in-flight, both run independently
 *   but only the most-recent-by-call-order result is committed to state.
 *
 * Unmount safety:
 *   `mountedRef` guards setState after unmount, identical to
 *   useDiagnoseRequest.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import type { ApiClient, ApiResult, WeatherResponse } from '../api';

/**
 * Connectivity probe. The default implementation always reports online —
 * fine for V1 because the api client itself emits `kind: 'network'` when
 * a fetch throws, and we coerce that to `queued`. E7-003 will wire a real
 * `@react-native-community/netinfo` subscription via this same prop.
 */
export type NetInfoLike = {
  isConnected: () => boolean | Promise<boolean>;
};

const DEFAULT_NET_INFO: NetInfoLike = {
  isConnected: () => true,
};

export type UseWeatherConfig = {
  /**
   * Required. The api client to call. Kept injectable rather than
   * defaulting to a singleton so callers (screens, tests) make the
   * dependency visible at the construction site.
   */
  apiClient: ApiClient;
  /**
   * Optional connectivity probe. Defaults to "always online" — the api
   * client's `network` kind handles the actual offline detection today.
   */
  netInfo?: NetInfoLike;
};

export type WeatherFetchInput = {
  /** Decimal latitude, range [-90, 90]. Caller is responsible for range. */
  latitude: number;
  /** Decimal longitude, range [-180, 180]. */
  longitude: number;
};

/**
 * Discriminated union returned by `fetchWeather()`. The kind set is
 * LOCKED — see the module header for the rationale on each variant.
 */
export type WeatherFetchResult =
  | { kind: 'ok'; data: WeatherResponse }
  | { kind: 'cache_hit'; data: WeatherResponse }
  | { kind: 'rate_limited'; retry_after_seconds?: number }
  | { kind: 'network_error'; message?: string }
  | { kind: 'parse_error' }
  | { kind: 'queued' };

export type WeatherStatus =
  | 'idle'
  | 'requesting'
  | 'success'
  | 'cache_hit'
  | 'rate_limited'
  | 'error'
  | 'queued';

export type UseWeatherReturn = {
  fetchWeather: (input: WeatherFetchInput) => Promise<WeatherFetchResult>;
  status: WeatherStatus;
  lastResult: WeatherFetchResult | null;
};

/**
 * Hook factory. Returns a stable `fetchWeather` callback (memoized via
 * useCallback against the injected apiClient + netInfo) plus the current
 * status and the most-recent result.
 */
export function useWeather(config: UseWeatherConfig): UseWeatherReturn {
  const { apiClient, netInfo = DEFAULT_NET_INFO } = config;

  const [status, setStatus] = useState<WeatherStatus>('idle');
  const [lastResult, setLastResult] = useState<WeatherFetchResult | null>(null);

  // Track mount state so we don't setState after unmount. React 18+ logs a
  // warning rather than throwing, but the warning is correct.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Monotonic counter that tags each fetchWeather() call. When a response
  // resolves, we only commit it to state if its id matches the latest
  // STARTED call — comparing to the latest started (not the latest
  // committed) catches the race where call #1 starts, call #2 starts,
  // call #1 resolves first (would otherwise commit stale data), then
  // call #2 resolves (would correct it but only after a render-window
  // of stale state). The codex P2 catch (during E6-005 review) was the
  // earlier draft used a "last committed" ref, which let a stale call
  // briefly win the commit before a newer call's resolution overwrote
  // it. Comparing to the latest started call eliminates the stale
  // window entirely.
  const callCounterRef = useRef(0);

  const fetchWeather = useCallback(
    async (input: WeatherFetchInput): Promise<WeatherFetchResult> => {
      const callId = ++callCounterRef.current;

      if (mountedRef.current) {
        setStatus('requesting');
      }

      const online = await netInfo.isConnected();
      if (!online) {
        // TODO(E7-004): persist to sync_queue. Today this is a pure
        // signal — the rules engine sees `queued` and skips the modifier.
        const queuedResult: WeatherFetchResult = { kind: 'queued' };
        commitResult(queuedResult, callId);
        return queuedResult;
      }

      let raw: ApiResult<WeatherResponse>;
      try {
        raw = await apiClient.weather({
          latitude: input.latitude,
          longitude: input.longitude,
        });
      } catch (err) {
        // Defensive: the api client's contract is "never throws, always
        // returns ApiResult." If a future change breaks that contract,
        // we'd rather not crash the rules engine. Treat as network →
        // coerce to queued, same as useDiagnoseRequest.
        void err;
        raw = { ok: false, kind: 'network' };
      }

      const result = classifyApiResult(raw);
      commitResult(result, callId);
      return result;
    },
    [apiClient, netInfo],
  );

  /**
   * Commit a result to state if (a) the component is still mounted and
   * (b) this call is THE latest started call. Otherwise drop the result
   * silently — comparing to `callCounterRef.current` (the latest started
   * id) means a stale older call resolving while a newer call is still
   * in-flight gets dropped, preventing the brief render-window where
   * stale data would have committed and then been overwritten.
   */
  function commitResult(result: WeatherFetchResult, callId: number): void {
    if (!mountedRef.current) return;
    if (callId !== callCounterRef.current) return;
    setLastResult(result);
    setStatus(statusForKind(result.kind));
  }

  return { fetchWeather, status, lastResult };
}

/**
 * Map a `WeatherFetchResult.kind` onto the externally-visible status
 * value. Kept as a switch so a new union variant fails to compile here
 * (exhaustiveness) rather than silently landing in 'error'.
 */
function statusForKind(kind: WeatherFetchResult['kind']): WeatherStatus {
  switch (kind) {
    case 'ok':
      return 'success';
    case 'cache_hit':
      return 'cache_hit';
    case 'rate_limited':
      return 'rate_limited';
    case 'network_error':
    case 'parse_error':
      return 'error';
    case 'queued':
      return 'queued';
    default: {
      // Exhaustiveness firewall: a new kind that doesn't add a switch
      // arm here stops compiling.
      const _exhaustive: never = kind;
      void _exhaustive;
      return 'error';
    }
  }
}

/**
 * Classify the api client's wire-level `ApiResult<WeatherResponse>` onto
 * the hook's locked discriminated union. The hook union is intentionally
 * NOT identical to the api client's union — the rules engine is the only
 * consumer and it cares about a different set of distinctions:
 *
 *   - ok            → kind: 'ok'
 *   - timeout       → kind: 'queued' (same coercion as useDiagnoseRequest;
 *                     the rules engine treats "we couldn't get fresh
 *                     weather" as "skip the modifier" regardless of which
 *                     transport failure caused it)
 *   - network       → kind: 'queued' (offline / DNS / TLS / captive
 *                     portal — indistinguishable from offline to the user)
 *   - server +
 *     retry_after   → kind: 'rate_limited' (429 → server+retry_after is
 *                     the canonical rate-limit shape per
 *                     `client.ts:classifyResponse`; we re-surface the
 *                     `retry_after_seconds` so consumers can render a
 *                     "try again in N seconds" hint).
 *   - server (no
 *     retry_after)  → kind: 'network_error' (transient upstream failure;
 *                     degrade gracefully on this call).
 *   - layer1_reject → kind: 'network_error' (shouldn't happen for weather
 *                     — there's no off-topic gate on a lat/lon query —
 *                     but we map it defensively rather than throw)
 *   - low_confidence → kind: 'network_error' (also shouldn't happen; same
 *                      defensive map)
 *   - parse_error   → kind: 'parse_error'
 *   - queued        → kind: 'queued'
 *
 * Note on the 5xx + Retry-After edge case: a 503 with a Retry-After
 * header would land here as `server + retry_after`, indistinguishable
 * from a 429 at this layer. We accept the misclassification because (a)
 * the rules engine treats `rate_limited` and `network_error` the same
 * (skip the modifier on this call) and (b) consumers that surface the
 * rate-limit signal want the `retry_after_seconds` either way. Post-V1,
 * when the api client adds a first-class `rate_limited` variant, this
 * function becomes a one-line passthrough.
 */
function classifyApiResult(
  raw: ApiResult<WeatherResponse>,
): WeatherFetchResult {
  if (raw.ok) {
    // Runtime shape check on the upstream payload. The api client's
    // `parse_error` kind already guards against unparseable JSON and
    // wrong-shape envelopes, but it relies on the type system + a
    // `pickResponseData()` body-extraction step rather than a
    // structural validator on the WeatherResponse fields. Defense-in-
    // depth: if a future deploy-skew lands a payload where `daily[0]`
    // or `daily[1]` is missing or malformed, the engine layer would
    // crash on `weather.daily[1].precipitation_sum_mm`. Map that to
    // `parse_error` here so the rules engine degrades gracefully
    // (skip the modifier) rather than throwing into a render. The
    // codex P2 catch (during E6-005 review) was that an earlier draft
    // returned `kind: 'ok'` unconditionally on `raw.ok`, trusting the
    // wire shape end-to-end.
    if (!isValidWeatherShape(raw.data)) {
      return { kind: 'parse_error' };
    }
    return { kind: 'ok', data: raw.data };
  }

  switch (raw.kind) {
    case 'network':
    case 'timeout':
      // Network → queued coercion. See module header on V1 UX:
      // an offline / unreachable backend means the rules engine
      // skips the weather modifier, NOT that the user sees an
      // error card.
      return { kind: 'queued' };
    case 'server':
      // 429 always carries `retry_after` (header or body
      // retry_after_seconds; see client.ts:classifyResponse). 5xx only
      // carries it when the upstream sets a Retry-After header — rare
      // enough that we accept the rare misclassification of a
      // 503-with-Retry-After as `rate_limited`. The rules engine treats
      // either case the same (skip the modifier on this call); consumers
      // that fork on `rate_limited` get the retry hint.
      if (typeof raw.retry_after === 'number') {
        return { kind: 'rate_limited', retry_after_seconds: raw.retry_after };
      }
      return raw.message
        ? { kind: 'network_error', message: raw.message }
        : { kind: 'network_error' };
    case 'parse_error':
      return { kind: 'parse_error' };
    case 'queued':
      return { kind: 'queued' };
    case 'layer1_reject':
    case 'low_confidence':
      // These shouldn't happen on a lat/lon query. Map defensively to
      // network_error so the rules engine degrades gracefully rather
      // than letting an unexpected kind escape.
      return raw.message
        ? { kind: 'network_error', message: raw.message }
        : { kind: 'network_error' };
    default: {
      // Exhaustiveness firewall.
      const _exhaustive: never = raw.kind;
      void _exhaustive;
      return { kind: 'network_error' };
    }
  }
}

/**
 * Structural validator for the `WeatherResponse` shape consumed by
 * `useWateringEngine` (specifically `data.daily[0]` and `data.daily[1]`).
 * Returns `true` only when both daily entries carry finite numeric
 * `precipitation_sum_mm` and `temperature_max_c` fields — the exact
 * subset the rules engine reads. The full WeatherResponse has more
 * fields (current weather, daily min temp, weather codes, timezone),
 * but the engine only depends on these four; a deploy-skew payload
 * missing the unrelated fields shouldn't fail the validator.
 *
 * NaN / Infinity are rejected via `Number.isFinite` (not just
 * `typeof === 'number'`) — a malformed upstream that JSON-encoded
 * `null` into a numeric field would deserialize as `null`, but a
 * future relaxed schema that accepts `NaN` would otherwise sneak
 * through and crash the threshold comparators.
 */
function isValidWeatherShape(data: unknown): data is WeatherResponse {
  if (data === null || typeof data !== 'object') return false;
  const candidate = data as { daily?: unknown };
  if (!Array.isArray(candidate.daily) || candidate.daily.length < 2) {
    return false;
  }
  return isValidDailyEntry(candidate.daily[0]) && isValidDailyEntry(candidate.daily[1]);
}

function isValidDailyEntry(entry: unknown): boolean {
  if (entry === null || typeof entry !== 'object') return false;
  const e = entry as {
    precipitation_sum_mm?: unknown;
    temperature_max_c?: unknown;
  };
  return (
    typeof e.precipitation_sum_mm === 'number' &&
    Number.isFinite(e.precipitation_sum_mm) &&
    typeof e.temperature_max_c === 'number' &&
    Number.isFinite(e.temperature_max_c)
  );
}
