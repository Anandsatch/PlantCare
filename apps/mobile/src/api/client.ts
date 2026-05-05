/**
 * PlantCare API client. Single source of truth for transport, timeout,
 * and error classification across all four LLM proxy endpoints.
 *
 * Surface:
 *   const api = createApiClient({ baseUrl, deviceId })
 *   const r = await api.identify({ image })
 *   if (r.ok) { ... } else switch (r.kind) { ... }
 *
 * Design choices (see master plan, lines 682-705):
 *   - Discriminated union via `ApiResult<T>` is the *only* failure surface
 *     screens see. Every fetch path lands in exactly one of the locked
 *     kinds. No `unknown` / `other` fallthrough — adding one would let new
 *     failure modes ship silently. If a kind doesn't fit, the right answer
 *     is to extend the union and update every screen's switch.
 *   - No retry / no backoff lives in this layer. Per V1 scope locks, retry
 *     is owned by E7 (sync queue). The client surfaces `kind` faithfully and
 *     exits.
 *   - `queued` is part of the type but never emitted *by the client itself*
 *     in this PR. The variant is reserved for the wire (backend may send
 *     `kind:'queued'` with a queue_id when E7's server-side queue lands)
 *     and for E7's mobile sync drainer, which will short-circuit fetches
 *     when offline and return `{ ok: false, kind: 'queued' }` directly.
 *   - No axios. RN ships `fetch`, `FormData`, `AbortController`. Adding a
 *     transport library buys nothing and adds bundle weight + a version
 *     surface that drifts from RN's globals.
 *
 * Dependency injection:
 *   - `fetch` and `getDeviceId` are injectable for tests + future use cases
 *     (Maestro replay, offline simulation). Production code passes neither
 *     and gets the RN globals + a static deviceId.
 */

import type {
  ApiErrorKind,
  ApiResult,
  ConsultRequest,
  ConsultResponse,
  DiagnoseRequest,
  DiagnoseResponse,
  IdentifyRequest,
  IdentifyResponse,
  ReviewRequest,
  ReviewResponse,
} from './types';
import { API_ERROR_KINDS } from './types';

/**
 * Default request timeout in milliseconds. Tuned to the master plan's 20s
 * budget for the slow path (free → paid escalation + image upload over a
 * weak cell connection). Per-call `timeoutMs` overrides this.
 */
export const DEFAULT_TIMEOUT_MS = 20_000;

export type ApiClientConfig = {
  /**
   * Origin + path prefix of the Cloudflare Worker, e.g.
   * "https://plantcare-api.plantcare.workers.dev". Trailing slash is
   * tolerated.
   */
  baseUrl: string;
  /**
   * The device's stable UUID. Generated once at first launch; persisted in
   * SQLite. Sent on every request as `X-Device-Id` so the backend can
   * scope rate-limit + escalation budget per device. Either `deviceId` or
   * `getDeviceId` must be provided (the latter for cases where the UUID
   * isn't available at construction time, e.g. async SQLite read).
   */
  deviceId?: string;
  /** Override for the runtime fetch (tests, instrumentation). */
  fetch?: typeof fetch;
  /** Lazy alternative to `deviceId`. Resolved on each call. */
  getDeviceId?: () => string | Promise<string>;
  /** Default per-call timeout. Per-call `timeoutMs` overrides. */
  defaultTimeoutMs?: number;
};

export type RequestOptions = {
  /** Override the client's default timeout for this single call. */
  timeoutMs?: number;
};

export type ApiClient = {
  identify: (input: IdentifyRequest, opts?: RequestOptions) => Promise<ApiResult<IdentifyResponse>>;
  diagnose: (input: DiagnoseRequest, opts?: RequestOptions) => Promise<ApiResult<DiagnoseResponse>>;
  consult: (input: ConsultRequest, opts?: RequestOptions) => Promise<ApiResult<ConsultResponse>>;
  review: (input: ReviewRequest, opts?: RequestOptions) => Promise<ApiResult<ReviewResponse>>;
};

/**
 * Construct an API client. Returned object holds onto config; methods are
 * pre-bound and safe to destructure.
 */
export function createApiClient(config: ApiClientConfig): ApiClient {
  const baseUrl = stripTrailingSlash(config.baseUrl);
  const fetchImpl = config.fetch ?? globalThis.fetch;
  const defaultTimeoutMs = config.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;

  // Eagerly fail at construction if we have nothing that can produce a
  // device id — this is a programming error, not a runtime user condition.
  // Returning a soft `kind: 'parse_error'` from every method would hide it.
  if (!config.deviceId && !config.getDeviceId) {
    throw new Error(
      "createApiClient: 'deviceId' or 'getDeviceId' is required. The X-Device-Id header is sent on every request and the backend rejects calls without it.",
    );
  }
  if (typeof fetchImpl !== 'function') {
    throw new Error(
      "createApiClient: no fetch available. Pass `fetch` in config when running outside an environment with a global fetch.",
    );
  }

  async function resolveDeviceId(): Promise<string> {
    const value = config.getDeviceId ? await config.getDeviceId() : config.deviceId;
    if (!value || typeof value !== 'string') {
      throw new Error(
        "createApiClient: deviceId resolved to an empty value. Refusing to send a request without X-Device-Id.",
      );
    }
    return value;
  }

  async function send<T>(
    path: string,
    init: RequestInit & { timeoutMs?: number },
  ): Promise<ApiResult<T>> {
    const timeoutMs = init.timeoutMs ?? defaultTimeoutMs;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    let timedOut = false;
    // Listen on the abort event rather than checking `controller.signal.reason`
    // post-hoc: the AbortError thrown from `fetch` carries no reliable identity
    // we can switch on, so we record the timeout flag synchronously when the
    // timer fires.
    const onAbort = () => {
      timedOut = true;
    };
    controller.signal.addEventListener('abort', onAbort);

    try {
      // Device-id resolution lives inside the timeout budget. A hung
      // SQLite read or a slow async resolver must not be able to bypass
      // `timeoutMs`. We check `timedOut` both on throw (resolver
      // rejected) and on success (resolver returned but the timer
      // already fired during the await). An *empty* / missing device id
      // throws synchronously — that's a programming error (caller hasn't
      // seeded the deviceId before calling), not a runtime user
      // condition, and we want the caller to see the stack rather than
      // a soft network error.
      let deviceId: string;
      try {
        deviceId = await resolveDeviceId();
      } catch (err) {
        if (timedOut) return { ok: false, kind: 'timeout' };
        throw err;
      }
      if (timedOut) return { ok: false, kind: 'timeout' };
      const headers = new Headers(init.headers);
      headers.set('X-Device-Id', deviceId);

      let response: Response;
      try {
        response = await fetchImpl(`${baseUrl}${path}`, {
          ...init,
          headers,
          signal: controller.signal,
        });
      } catch (err) {
        // Distinguish timeout-driven abort from network failure. The
        // `timedOut` flag is set inside our own onabort handler before
        // fetch's promise rejects, so we can switch on it cleanly.
        if (timedOut) return { ok: false, kind: 'timeout' };
        // Otherwise it's a network failure (DNS, TLS, refused, RN's
        // "Network request failed"). RN throws a TypeError; abort thrown
        // from external sources also lands here, which is the right bucket
        // for the user — couldn't reach the lab.
        void err;
        return { ok: false, kind: 'network' };
      }

      return await classifyResponse<T>(response);
    } finally {
      clearTimeout(timeoutId);
      controller.signal.removeEventListener('abort', onAbort);
    }
  }

  return {
    async identify(input, opts) {
      const body = buildImageFormData(input.image);
      return send<IdentifyResponse>('/api/identify', {
        method: 'POST',
        // Don't set Content-Type on multipart — the runtime sets it with
        // the boundary token. Setting it manually breaks the upload.
        body,
        timeoutMs: opts?.timeoutMs,
      });
    },

    async diagnose(input, opts) {
      const body = buildImageFormData(input.image);
      return send<DiagnoseResponse>('/api/diagnose', {
        method: 'POST',
        body,
        timeoutMs: opts?.timeoutMs,
      });
    },

    async consult(input, opts) {
      return send<ConsultResponse>('/api/consult', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
        timeoutMs: opts?.timeoutMs,
      });
    },

    async review(input, opts) {
      return send<ReviewResponse>('/api/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
        timeoutMs: opts?.timeoutMs,
      });
    },
  };
}

// ─── Internals ──────────────────────────────────────────────────────────

function stripTrailingSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}

/**
 * Build multipart body for image endpoints. RN's FormData accepts the
 * `{ uri, name, type }` descriptor verbatim; web's FormData expects a
 * `Blob`/`File`. The image input type allows both; we pass through.
 */
function buildImageFormData(image: unknown): FormData {
  const fd = new FormData();
  // The backend route reads the field name 'image' (see
  // apps/backend/src/routes/_imageUpload.ts). Don't change this without
  // updating both sides.
  fd.append('image', image as Blob);
  return fd;
}

const KNOWN_ERROR_KINDS = new Set<string>(API_ERROR_KINDS);

/**
 * Classify a `Response` into the locked `ApiResult<T>` shape.
 *
 * Status-code precedence (highest first):
 *   1. 429 → 'server' with `retry_after` from header (rate_limited per
 *      master plan note: post-V1, rate_limited becomes its own kind; for
 *      now 429 surfaces as server + retry_after).
 *   2. 5xx → 'server'. Body parse is best-effort; we never fail-out a
 *      classification because the body was empty.
 *   3. 4xx → trust the body's `kind` if it's one of the locked client
 *      kinds, otherwise map known backend kinds (rate_limited,
 *      rejected_off_topic, error) into client kinds, otherwise
 *      'parse_error'.
 *   4. 2xx → `{ ok: true, data }` if body is `{ ok: true, kind: 'success',
 *      data }`; `{ ok: false, kind: 'queued' }` if body is `{ ok: true,
 *      kind: 'queued' }`; pass-through if body's `kind` is already a
 *      client kind; otherwise 'parse_error'.
 */
async function classifyResponse<T>(response: Response): Promise<ApiResult<T>> {
  const status = response.status;
  const retryAfter = parseRetryAfter(response.headers.get('Retry-After'));

  // Read body once. We tolerate empty + non-JSON bodies; absence isn't a
  // crash, it's a signal.
  const bodyText = await safeReadText(response);
  const bodyJson = safeParseJson(bodyText);

  // 429 wins regardless of body. Retry-After header is the canonical
  // signal, but a backend that only sets `retry_after_seconds` in the
  // body (the wire-level `rate_limited` shape, see
  // packages/api-types/src/index.ts) shouldn't lose its delay hint.
  // Header preferred when both are present — RFC 7231 says the header is
  // authoritative; the body field is a convenience for callers that
  // can't read headers.
  if (status === 429) {
    const message = pickMessage(bodyJson);
    const bodyRetryAfter =
      bodyJson && typeof bodyJson === 'object' &&
      typeof (bodyJson as { retry_after_seconds?: unknown }).retry_after_seconds === 'number'
        ? ((bodyJson as { retry_after_seconds: number }).retry_after_seconds)
        : undefined;
    return errorResult('server', {
      message,
      retry_after: retryAfter ?? bodyRetryAfter,
    });
  }

  if (status >= 500) {
    const message = pickMessage(bodyJson);
    return errorResult('server', { message, retry_after: retryAfter });
  }

  if (status >= 400) {
    // 4xx with a body that already speaks the client union? Trust it.
    const passthrough = passthroughIfClientKind(bodyJson);
    if (passthrough) return passthrough as ApiResult<T>;

    // Otherwise map known backend kinds.
    const mapped = mapBackendErrorBody(bodyJson, retryAfter);
    if (mapped) return mapped as ApiResult<T>;

    // Empty or unrecognized 4xx body. The backend should always emit a
    // structured error, so an unstructured 4xx is a deploy-skew or
    // middleware-mangling signal — server-side, but not retryable. Surface
    // as 'server' rather than 'parse_error' so the user sees a "we'll be
    // back" copy instead of a "your request was malformed" copy.
    return errorResult('server', { retry_after: retryAfter });
  }

  // 2xx territory. Anything that isn't shape-conformant is parse_error.
  if (!bodyJson || typeof bodyJson !== 'object') {
    return errorResult('parse_error');
  }

  // Already-client-kind passthrough (forward-compat with backends that
  // adopt the client union directly).
  const passthrough = passthroughIfClientKind(bodyJson);
  if (passthrough) return passthrough as ApiResult<T>;

  const wire = bodyJson as Record<string, unknown>;

  if (wire.ok === true && wire.kind === 'success' && 'data' in wire) {
    return { ok: true, data: wire.data as T };
  }

  if (wire.ok === true && wire.kind === 'queued') {
    return { ok: false, kind: 'queued' };
  }

  if (wire.ok === false && wire.kind === 'rejected_off_topic') {
    return errorResult('layer1_reject', {
      message: typeof wire.message === 'string' ? wire.message : undefined,
    });
  }

  // 2xx with a backend-shaped error body (e.g. error/rate_limited returned
  // with a 200 status by an over-eager edge layer). Honor the body kind.
  const mapped = mapBackendErrorBody(wire, retryAfter);
  if (mapped) return mapped as ApiResult<T>;

  return errorResult('parse_error');
}

/**
 * Build an error variant of `ApiResult<T>` without spread-attaching
 * undefined fields — a `message: undefined` key turns up in JSON logs and
 * test snapshots, which is not what we want.
 */
function errorResult(
  kind: ApiErrorKind,
  extras: { message?: string; retry_after?: number } = {},
): ApiResult<never> {
  const out: ApiResult<never> = { ok: false, kind };
  if (extras.message !== undefined) (out as { message?: string }).message = extras.message;
  if (extras.retry_after !== undefined)
    (out as { retry_after?: number }).retry_after = extras.retry_after;
  return out;
}

/**
 * If the body already looks like a client `ApiResult<T>` (its `kind` is one
 * of the locked client kinds), return it. Lets the backend graduate to the
 * client union later without a client release.
 *
 * Only validates shape; trusts the kind. The contract is: if you emit a
 * client kind on the wire, you accept the client semantics.
 */
function passthroughIfClientKind(body: unknown): ApiResult<unknown> | null {
  if (!body || typeof body !== 'object') return null;
  const wire = body as Record<string, unknown>;
  if (wire.ok === true && 'data' in wire) {
    // Backwards-compat: a body of { ok: true, data } without a `kind` is
    // also acceptable, but we don't take this path for that — only for
    // bodies that name the client kind.
    return null;
  }
  if (wire.ok !== false || typeof wire.kind !== 'string') return null;
  if (!KNOWN_ERROR_KINDS.has(wire.kind)) return null;
  const out: ApiResult<unknown> = { ok: false, kind: wire.kind as ApiErrorKind };
  if (typeof wire.message === 'string') (out as { message: string }).message = wire.message;
  if (typeof wire.retry_after === 'number')
    (out as { retry_after: number }).retry_after = wire.retry_after;
  return out;
}

/**
 * Map known backend error kinds (`rate_limited`, `rejected_off_topic`,
 * `error`) to client kinds:
 *
 *   - `rate_limited`     → `server` + retry_after
 *   - `rejected_off_topic` → `layer1_reject`
 *   - `error`            → `server` (backend-side validation, not a
 *                          malformed response — see comment in the
 *                          mapping below)
 *
 * Returns null if the body doesn't carry a recognized backend error
 * envelope.
 */
function mapBackendErrorBody(
  body: unknown,
  headerRetryAfter: number | undefined,
): ApiResult<never> | null {
  if (!body || typeof body !== 'object') return null;
  const wire = body as Record<string, unknown>;
  if (wire.ok !== false || typeof wire.kind !== 'string') return null;

  switch (wire.kind) {
    case 'rate_limited': {
      const bodyRetryAfter =
        typeof wire.retry_after_seconds === 'number'
          ? wire.retry_after_seconds
          : undefined;
      return errorResult('server', {
        retry_after: bodyRetryAfter ?? headerRetryAfter,
      });
    }
    case 'rejected_off_topic':
      return errorResult('layer1_reject', {
        message: typeof wire.message === 'string' ? wire.message : undefined,
      });
    case 'error':
      // Backend's `kind: 'error'` is for server-side validation failures
      // (`missing_image`, `invalid_json`, `service_unconfigured`,
      // `missing_or_invalid_device_id`) — see apps/backend/src/routes/
      // _imageUpload.ts, _consultRequest.ts, _reviewRequest.ts. These are
      // *real* server-emitted errors, not malformed response shapes;
      // `parse_error` would mislead the screen into rendering a "garbled
      // response" copy when in fact the user's request was rejected.
      // `server` is the right bucket: structured server-side rejection.
      return errorResult('server', {
        message: typeof wire.message === 'string' ? wire.message : undefined,
      });
    default:
      return null;
  }
}

/**
 * Best-effort body read. A response body that throws or hangs midway
 * doesn't crash the classifier; it just leaves us with an empty string
 * which the JSON parser will reject.
 */
async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

function safeParseJson(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function pickMessage(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const v = (body as { message?: unknown }).message;
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/**
 * Parse a Retry-After header. RFC 7231 allows both delta-seconds and an
 * HTTP-date. Mobile callers want a number-of-seconds, so we normalize:
 *
 *   - Numeric like "30" → 30
 *   - HTTP-date like "Tue, 04 May 2026 16:00:00 GMT" → seconds until then,
 *     clamped at 0 (no negative retries) and ignored if it doesn't parse.
 *
 * Returns undefined for missing / unparseable values rather than 0 — 0
 * would semantically mean "retry immediately," which a missing header
 * doesn't promise.
 */
function parseRetryAfter(headerValue: string | null): number | undefined {
  if (!headerValue) return undefined;
  const trimmed = headerValue.trim();
  if (!trimmed) return undefined;

  // Pure-numeric branch first: avoids Date.parse interpreting "30" as some
  // platform-default date.
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number.parseInt(trimmed, 10);
    return Number.isFinite(seconds) ? seconds : undefined;
  }

  const targetMs = Date.parse(trimmed);
  if (!Number.isFinite(targetMs)) return undefined;
  const deltaSeconds = Math.max(0, Math.round((targetMs - Date.now()) / 1000));
  return deltaSeconds;
}
