/**
 * API client tests. Drive the client against an injected `fetch` mock so the
 * test surface is the wire shape, not the underlying transport. Goal: every
 * branch in `classifyResponse` plus the network/timeout edges.
 *
 * The tests do NOT use jest's globalThis.fetch interception — they pass
 * `fetch` via DI so each test gets its own fully-controlled mock and the
 * classifier code path matches what production runs.
 */
import { describe, expect, it, jest } from '@jest/globals';

import { createApiClient } from '../client';
import type {
  ConsultRequest,
  DiagnoseResponse,
  IdentifyResponse,
  ReviewRequest,
  ReviewResponse,
  ConsultResponse,
} from '../types';

// ─── Helpers ────────────────────────────────────────────────────────────

const DEVICE_ID = 'test-device-uuid-0001';
const BASE_URL = 'https://plantcare-api.example.workers.dev';

type FetchSpy = jest.Mock<typeof fetch>;

/**
 * Build a Response-like shape sufficient for the classifier. We use the
 * runtime `Response` constructor when the body is small (Node 20+ ships it).
 * For headers we go through a real `Headers` object so case-insensitive
 * lookups work as in production.
 */
function makeResponse(
  status: number,
  body: string | null,
  headers: Record<string, string> = {},
): Response {
  return new Response(body, { status, headers });
}

function makeJsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function clientWithFetch(spy: FetchSpy, overrides: { defaultTimeoutMs?: number } = {}) {
  return createApiClient({
    baseUrl: BASE_URL,
    deviceId: DEVICE_ID,
    fetch: spy as unknown as typeof fetch,
    ...overrides,
  });
}

const SUCCESSFUL_IDENTIFY: IdentifyResponse = {
  species_slug: 'monstera_deliciosa',
  species_label: 'Monstera Deliciosa',
  confidence: 86,
  alternatives: [],
  source: 'free',
  latency_ms: 1234,
};

const SUCCESSFUL_DIAGNOSE: DiagnoseResponse = {
  disease_slug: 'overwatering',
  disease_label: 'Overwatering',
  confidence: 81,
  severity: 'medium',
  fix_steps: ['Skip watering for 5-7 days', 'Check drainage'],
  alternatives: [],
  source: 'free',
  latency_ms: 1100,
};

const SUCCESSFUL_REVIEW: ReviewResponse = {
  headline: 'A steady week, with one bright spot',
  narrative:
    'Your plants leaned on you this week. Steve perked up after Tuesday’s repot, and the rest stayed within their rhythm. A quiet week, mostly. Keep doing what you’re doing.',
  per_plant: [{ species_slug: 'monstera_deliciosa', observation: 'Steady. Skip Sunday.' }],
  confidence: 88,
  source: 'free',
  latency_ms: 950,
};

// ─── Construction guards ────────────────────────────────────────────────

describe('createApiClient (construction)', () => {
  it('throws when neither deviceId nor getDeviceId is provided', () => {
    const spy = jest.fn() as FetchSpy;
    expect(() =>
      createApiClient({ baseUrl: BASE_URL, fetch: spy as unknown as typeof fetch }),
    ).toThrow(/deviceId/);
  });

  it('accepts an injected fetch (DI for tests)', async () => {
    const spy = jest.fn(async () =>
      makeJsonResponse(200, { ok: true, kind: 'success', data: SUCCESSFUL_IDENTIFY }),
    ) as FetchSpy;
    const api = clientWithFetch(spy);
    const result = await api.identify({ image: new Blob(['fake'], { type: 'image/jpeg' }) });
    expect(result.ok).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('rejects an empty deviceId resolved from getDeviceId', async () => {
    const spy = jest.fn(async () =>
      makeJsonResponse(200, { ok: true, kind: 'success', data: SUCCESSFUL_IDENTIFY }),
    ) as FetchSpy;
    const api = createApiClient({
      baseUrl: BASE_URL,
      getDeviceId: () => '',
      fetch: spy as unknown as typeof fetch,
    });
    await expect(
      api.identify({ image: new Blob(['fake'], { type: 'image/jpeg' }) }),
    ).rejects.toThrow(/empty/);
    expect(spy).not.toHaveBeenCalled();
  });
});

// ─── Identify ───────────────────────────────────────────────────────────

describe('identify', () => {
  it('returns ok+data on a 2xx success body, with X-Device-Id header set', async () => {
    const spy = jest.fn(async () =>
      makeJsonResponse(200, { ok: true, kind: 'success', data: SUCCESSFUL_IDENTIFY }),
    ) as FetchSpy;
    const api = clientWithFetch(spy);

    const result = await api.identify({ image: new Blob(['fake'], { type: 'image/jpeg' }) });

    expect(result).toEqual({ ok: true, data: SUCCESSFUL_IDENTIFY });
    const [url, init] = spy.mock.calls[0]!;
    expect(url).toBe(`${BASE_URL}/api/identify`);
    const headers = new Headers((init as RequestInit).headers);
    expect(headers.get('X-Device-Id')).toBe(DEVICE_ID);
    // Multipart Content-Type must NOT be hand-set — runtime FormData adds
    // it with the boundary token. Setting it manually breaks the upload.
    expect(headers.get('Content-Type')).toBeNull();
  });

  it('classifies a fetch TypeError as kind=network', async () => {
    const spy = jest.fn(async () => {
      throw new TypeError('Network request failed');
    }) as FetchSpy;
    const api = clientWithFetch(spy);

    const result = await api.identify({ image: new Blob(['fake'], { type: 'image/jpeg' }) });
    expect(result).toEqual({ ok: false, kind: 'network' });
  });

  it('classifies a hang-past-timeout as kind=timeout (not network)', async () => {
    const spy = jest.fn(
      (input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_, reject) => {
          // Never resolve on its own. Reject when the AbortController
          // fires so the await in the client unwinds.
          const signal = init?.signal;
          if (signal) {
            signal.addEventListener('abort', () => {
              const err = new Error('aborted');
              err.name = 'AbortError';
              reject(err);
            });
          }
        }),
    ) as FetchSpy;
    const api = clientWithFetch(spy, { defaultTimeoutMs: 25 });

    const result = await api.identify({ image: new Blob(['fake'], { type: 'image/jpeg' }) });
    expect(result).toEqual({ ok: false, kind: 'timeout' });
  });

  it('honors a per-call timeoutMs override', async () => {
    const spy = jest.fn(
      (input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }),
    ) as FetchSpy;
    const api = clientWithFetch(spy, { defaultTimeoutMs: 60_000 });

    const start = Date.now();
    const result = await api.identify(
      { image: new Blob(['fake'], { type: 'image/jpeg' }) },
      { timeoutMs: 30 },
    );
    const elapsed = Date.now() - start;

    expect(result).toEqual({ ok: false, kind: 'timeout' });
    // Default is 60s; if the override didn't apply we'd still be hung.
    expect(elapsed).toBeLessThan(1000);
  });

  it('classifies HTTP 500 as kind=server', async () => {
    const spy = jest.fn(async () =>
      makeJsonResponse(500, { ok: false, kind: 'error', message: 'service_unconfigured' }),
    ) as FetchSpy;
    const api = clientWithFetch(spy);

    const result = await api.identify({ image: new Blob(['fake'], { type: 'image/jpeg' }) });
    expect(result).toEqual({
      ok: false,
      kind: 'server',
      message: 'service_unconfigured',
    });
  });

  it('parses Retry-After numeric and returns kind=server with retry_after on 429', async () => {
    const spy = jest.fn(async () =>
      makeJsonResponse(
        429,
        { ok: false, kind: 'rate_limited', retry_after_seconds: 30 },
        { 'Retry-After': '30' },
      ),
    ) as FetchSpy;
    const api = clientWithFetch(spy);

    const result = await api.identify({ image: new Blob(['fake'], { type: 'image/jpeg' }) });
    expect(result).toEqual({ ok: false, kind: 'server', retry_after: 30 });
  });

  it('parses Retry-After HTTP-date format and returns seconds-until', async () => {
    const future = new Date(Date.now() + 60_000).toUTCString();
    const spy = jest.fn(async () =>
      makeResponse(429, null, { 'Retry-After': future }),
    ) as FetchSpy;
    const api = clientWithFetch(spy);

    const result = await api.identify({ image: new Blob(['fake'], { type: 'image/jpeg' }) });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.kind).toBe('server');
    // Allow a few seconds of slack for parse + test scheduling.
    expect(result.retry_after).toBeGreaterThanOrEqual(55);
    expect(result.retry_after).toBeLessThanOrEqual(65);
  });

  it('treats a 200 response with non-JSON body as kind=parse_error', async () => {
    const spy = jest.fn(async () =>
      makeResponse(200, '<html>oops gateway</html>', { 'Content-Type': 'text/html' }),
    ) as FetchSpy;
    const api = clientWithFetch(spy);

    const result = await api.identify({ image: new Blob(['fake'], { type: 'image/jpeg' }) });
    expect(result).toEqual({ ok: false, kind: 'parse_error' });
  });

  it('treats a 200 response with JSON that is not an ApiResult shape as kind=parse_error', async () => {
    const spy = jest.fn(async () =>
      makeJsonResponse(200, { totally: 'unrelated', shape: true }),
    ) as FetchSpy;
    const api = clientWithFetch(spy);

    const result = await api.identify({ image: new Blob(['fake'], { type: 'image/jpeg' }) });
    expect(result).toEqual({ ok: false, kind: 'parse_error' });
  });

  it('handles an empty 4xx body without crashing (kind=server)', async () => {
    const spy = jest.fn(async () => makeResponse(400, '')) as FetchSpy;
    const api = clientWithFetch(spy);

    const result = await api.identify({ image: new Blob(['fake'], { type: 'image/jpeg' }) });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.kind).toBe('server');
  });
});

// ─── Backend → client kind passthrough/mapping ──────────────────────────

describe('backend response kind classification', () => {
  it('maps backend rejected_off_topic to client kind=layer1_reject', async () => {
    const spy = jest.fn(async () =>
      makeJsonResponse(200, {
        ok: false,
        kind: 'rejected_off_topic',
        message: 'Let’s keep this about your plants.',
      }),
    ) as FetchSpy;
    const api = clientWithFetch(spy);

    const result = await api.consult({ note: 'tell me a joke' });
    expect(result).toEqual({
      ok: false,
      kind: 'layer1_reject',
      message: 'Let’s keep this about your plants.',
    });
  });

  it('passes through a backend body that already speaks kind=layer1_reject', async () => {
    const spy = jest.fn(async () =>
      makeJsonResponse(400, { ok: false, kind: 'layer1_reject', message: 'no plant detected' }),
    ) as FetchSpy;
    const api = clientWithFetch(spy);

    const result = await api.diagnose({ image: new Blob(['x'], { type: 'image/jpeg' }) });
    expect(result).toEqual({
      ok: false,
      kind: 'layer1_reject',
      message: 'no plant detected',
    });
  });

  it('passes through a backend body that already speaks kind=low_confidence', async () => {
    const spy = jest.fn(async () =>
      makeJsonResponse(400, { ok: false, kind: 'low_confidence' }),
    ) as FetchSpy;
    const api = clientWithFetch(spy);

    const result = await api.diagnose({ image: new Blob(['x'], { type: 'image/jpeg' }) });
    expect(result).toEqual({ ok: false, kind: 'low_confidence' });
  });

  it('passes through a backend body that already speaks kind=parse_error', async () => {
    const spy = jest.fn(async () =>
      makeJsonResponse(400, { ok: false, kind: 'parse_error', message: 'bad image bytes' }),
    ) as FetchSpy;
    const api = clientWithFetch(spy);

    const result = await api.identify({ image: new Blob(['x'], { type: 'image/jpeg' }) });
    expect(result).toEqual({ ok: false, kind: 'parse_error', message: 'bad image bytes' });
  });

  it('passes through a backend body that already speaks kind=queued (forward-compat)', async () => {
    const spy = jest.fn(async () =>
      makeJsonResponse(202, { ok: false, kind: 'queued' }),
    ) as FetchSpy;
    const api = clientWithFetch(spy);

    const result = await api.diagnose({ image: new Blob(['x'], { type: 'image/jpeg' }) });
    expect(result).toEqual({ ok: false, kind: 'queued' });
  });

  it('maps backend kind=queued (ok=true wire) to client kind=queued (ok=false)', async () => {
    // The backend wire spec says queued is ok:true (the request was
    // *accepted* for async processing). The client ApiResult is locked
    // such that any non-data response is ok:false — the screen needs to
    // know "no data yet" without reading the queue_id field.
    const spy = jest.fn(async () =>
      makeJsonResponse(202, { ok: true, kind: 'queued', queue_id: 'q-123' }),
    ) as FetchSpy;
    const api = clientWithFetch(spy);

    const result = await api.diagnose({ image: new Blob(['x'], { type: 'image/jpeg' }) });
    expect(result).toEqual({ ok: false, kind: 'queued' });
  });
});

// ─── Diagnose: multipart construction ───────────────────────────────────

describe('diagnose', () => {
  it('sends a multipart body with the image field and X-Device-Id header', async () => {
    const spy = jest.fn(async () =>
      makeJsonResponse(200, { ok: true, kind: 'success', data: SUCCESSFUL_DIAGNOSE }),
    ) as FetchSpy;
    const api = clientWithFetch(spy);

    const file = new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: 'image/jpeg' });
    const result = await api.diagnose({ image: file });

    expect(result.ok).toBe(true);
    const [url, init] = spy.mock.calls[0]!;
    expect(url).toBe(`${BASE_URL}/api/diagnose`);
    const body = (init as RequestInit).body;
    expect(body).toBeInstanceOf(FormData);
    const fd = body as FormData;
    const sent = fd.get('image');
    // Node's FormData wraps a Blob into a File; we assert structural
    // equivalence (size + type + bytes) rather than reference equality.
    expect(sent).toBeInstanceOf(Blob);
    const sentBlob = sent as Blob;
    expect(sentBlob.size).toBe(file.size);
    expect(sentBlob.type).toBe(file.type);
    expect(new Uint8Array(await sentBlob.arrayBuffer())).toEqual(
      new Uint8Array(await file.arrayBuffer()),
    );
    const headers = new Headers((init as RequestInit).headers);
    expect(headers.get('X-Device-Id')).toBe(DEVICE_ID);
  });
});

// ─── Consult: JSON body ─────────────────────────────────────────────────

describe('consult', () => {
  it('serializes the JSON body and sets Content-Type=application/json', async () => {
    const data: ConsultResponse = {
      kind: 'recommendation',
      revised_interval_days: 6,
      reasoning: 'Repotted plants need a slightly longer dry-down.',
      confidence: 84,
      source: 'free',
      latency_ms: 700,
    };
    const spy = jest.fn(async () =>
      makeJsonResponse(200, { ok: true, kind: 'success', data }),
    ) as FetchSpy;
    const api = clientWithFetch(spy);

    const input: ConsultRequest = {
      note: 'I just repotted it',
      plant_context: { species_slug: 'monstera_deliciosa', is_indoor: true },
    };
    const result = await api.consult(input);

    expect(result.ok).toBe(true);
    const [url, init] = spy.mock.calls[0]!;
    expect(url).toBe(`${BASE_URL}/api/consult`);
    const headers = new Headers((init as RequestInit).headers);
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(headers.get('X-Device-Id')).toBe(DEVICE_ID);
    expect((init as RequestInit).body).toBe(JSON.stringify(input));
  });

  it('accepts a consult request without plant_context', async () => {
    const spy = jest.fn(async () =>
      makeJsonResponse(200, {
        ok: true,
        kind: 'success',
        data: {
          kind: 'recommendation',
          revised_interval_days: 7,
          reasoning: 'general guidance',
          confidence: 75,
          source: 'free',
          latency_ms: 600,
        },
      }),
    ) as FetchSpy;
    const api = clientWithFetch(spy);

    const result = await api.consult({ note: 'How often should I water this?' });
    expect(result.ok).toBe(true);
    const [, init] = spy.mock.calls[0]!;
    expect((init as RequestInit).body).toBe(
      JSON.stringify({ note: 'How often should I water this?' }),
    );
  });
});

// ─── Review: JSON body ──────────────────────────────────────────────────

describe('review', () => {
  it('serializes the weekly summary + plants array as JSON', async () => {
    const spy = jest.fn(async () =>
      makeJsonResponse(200, { ok: true, kind: 'success', data: SUCCESSFUL_REVIEW }),
    ) as FetchSpy;
    const api = clientWithFetch(spy);

    const input: ReviewRequest = {
      week_summary: { plants_total: 4, watering_events: 9, skip_events: 2, diagnoses: 1 },
      plants: [
        {
          species_slug: 'monstera_deliciosa',
          nickname: 'Steve',
          watering_count: 2,
          skip_count: 0,
          had_diagnosis: false,
        },
      ],
    };
    const result = await api.review(input);

    expect(result.ok).toBe(true);
    const [url, init] = spy.mock.calls[0]!;
    expect(url).toBe(`${BASE_URL}/api/review`);
    const headers = new Headers((init as RequestInit).headers);
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(headers.get('X-Device-Id')).toBe(DEVICE_ID);
    expect((init as RequestInit).body).toBe(JSON.stringify(input));
  });
});

// ─── 5xx with malformed body ────────────────────────────────────────────

describe('error precedence', () => {
  it('5xx with malformed body still returns kind=server (not parse_error)', async () => {
    // Master plan rule: server-side failure beats body-shape failure. The
    // user can't fix a malformed 503 by changing their input.
    const spy = jest.fn(async () =>
      makeResponse(503, '<html>upstream gone</html>', {
        'Content-Type': 'text/html',
      }),
    ) as FetchSpy;
    const api = clientWithFetch(spy);

    const result = await api.identify({ image: new Blob(['x'], { type: 'image/jpeg' }) });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.kind).toBe('server');
  });
});

// ─── Base URL handling ──────────────────────────────────────────────────

describe('baseUrl handling', () => {
  it('strips a trailing slash from baseUrl', async () => {
    const spy = jest.fn(async () =>
      makeJsonResponse(200, { ok: true, kind: 'success', data: SUCCESSFUL_IDENTIFY }),
    ) as FetchSpy;
    const api = createApiClient({
      baseUrl: `${BASE_URL}/`,
      deviceId: DEVICE_ID,
      fetch: spy as unknown as typeof fetch,
    });

    await api.identify({ image: new Blob(['fake'], { type: 'image/jpeg' }) });
    const [url] = spy.mock.calls[0]!;
    expect(url).toBe(`${BASE_URL}/api/identify`);
  });
});

// ─── Codex adversarial review fixes ─────────────────────────────────────
// These tests guard against regressions of the P2 findings from the
// codex review run on this PR.

describe('codex review fixes', () => {
  it('maps backend kind=error (400) to client kind=server, not parse_error', async () => {
    // Codex P2: backend's `kind:'error'` is for server-side request
    // validation (`missing_image`, `invalid_json`, `service_unconfigured`).
    // These are real server-emitted rejections, not malformed responses.
    // `parse_error` would render the wrong copy on screen.
    const spy = jest.fn(async () =>
      makeJsonResponse(400, { ok: false, kind: 'error', message: 'missing_image' }),
    ) as FetchSpy;
    const api = clientWithFetch(spy);

    const result = await api.identify({ image: new Blob(['x'], { type: 'image/jpeg' }) });
    expect(result).toEqual({ ok: false, kind: 'server', message: 'missing_image' });
  });

  it('honors body.retry_after_seconds on a 429 even without a Retry-After header', async () => {
    // Codex P2: backend `rate_limited` shape carries retry hint in
    // body. Header-only parsing would drop the delay.
    const spy = jest.fn(async () =>
      makeJsonResponse(429, { ok: false, kind: 'rate_limited', retry_after_seconds: 45 }),
    ) as FetchSpy;
    const api = clientWithFetch(spy);

    const result = await api.identify({ image: new Blob(['x'], { type: 'image/jpeg' }) });
    expect(result).toEqual({ ok: false, kind: 'server', retry_after: 45 });
  });

  it('prefers Retry-After header over body.retry_after_seconds when both are present', async () => {
    // RFC 7231 makes the header authoritative.
    const spy = jest.fn(async () =>
      makeJsonResponse(
        429,
        { ok: false, kind: 'rate_limited', retry_after_seconds: 99 },
        { 'Retry-After': '12' },
      ),
    ) as FetchSpy;
    const api = clientWithFetch(spy);

    const result = await api.identify({ image: new Blob(['x'], { type: 'image/jpeg' }) });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.retry_after).toBe(12);
  });

  it('classifies a slow getDeviceId() that exceeds timeoutMs as kind=timeout', async () => {
    // Codex P2: device-id resolution must live inside the timeout
    // budget. A hung SQLite read shouldn't be able to bypass it.
    const spy = jest.fn(async () =>
      makeJsonResponse(200, { ok: true, kind: 'success', data: SUCCESSFUL_IDENTIFY }),
    ) as FetchSpy;
    const api = createApiClient({
      baseUrl: BASE_URL,
      // Resolves slower than the timeout — the timeout fires first and
      // the abort controller's signal flips `timedOut`. We surface
      // `kind: 'timeout'` rather than letting the slow lookup hang the
      // entire app (and rather than letting it bypass the budget and
      // succeed late).
      getDeviceId: () =>
        new Promise<string>((resolve) => {
          setTimeout(() => resolve(DEVICE_ID), 200);
        }),
      fetch: spy as unknown as typeof fetch,
      defaultTimeoutMs: 25,
    });

    const result = await api.identify({ image: new Blob(['x'], { type: 'image/jpeg' }) });
    expect(result).toEqual({ ok: false, kind: 'timeout' });
    expect(spy).not.toHaveBeenCalled();
  });
});
