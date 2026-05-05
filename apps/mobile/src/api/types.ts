/**
 * Mobile-side API types for the four LLM proxy endpoints.
 *
 * Two `ApiResult<T>` shapes coexist in this codebase, by design:
 *
 *   1. The *backend wire* `ApiResult<T>` from `@plantcare/api-types` describes
 *      what the Cloudflare Worker actually puts on the wire as JSON. Its
 *      kinds are `success | queued | error | rate_limited | rejected_off_topic`.
 *
 *   2. The *mobile-client* `ApiResult<T>` defined in this file describes what
 *      every screen sees after the client has classified network conditions
 *      (timeouts, fetch failures, HTTP status codes) and normalized the
 *      backend response. Its kinds are locked by the master plan to
 *      `network | timeout | server | layer1_reject | low_confidence |
 *      parse_error | queued`.
 *
 * Why two: the backend can't know about TCP errors or AbortController; the
 * client can't know about server-side off-topic detection. Each layer owns
 * exactly the concerns it can observe. The mapping between the two happens
 * in `client.ts` and is the only place where the wire shape leaks.
 *
 * The kind enumeration is LOCKED. Reviewers occasionally suggest collapsing
 * 'network' + 'timeout' into 'network_error' — REJECT. They differ in user
 * intent: timeout means "your request was sent and we waited too long" (retry
 * makes sense); network means "we couldn't even reach the lab" (check your
 * connection first). They also differ in retry strategy and in the copy the
 * A-3 error states render. Same goes for 'queued' — even though E7 (sync
 * queue) hasn't shipped yet, the variant is in the type now so E7 won't be a
 * breaking change to every screen.
 */

import type {
  ConsultRequestBody,
  ConsultResponse,
  DiagnoseResponse,
  IdentifyResponse,
  ReviewRequestBody,
  ReviewResponse,
} from '@plantcare/api-types';

/**
 * Discriminated union surfaced to every screen. Locked per master plan.
 *
 * - `network`        — fetch threw before producing a response. Connection
 *                      down, DNS fail, TLS handshake refused.
 * - `timeout`        — AbortController fired before fetch settled. Request
 *                      was on the wire but never finished.
 * - `server`         — HTTP 5xx, or HTTP 429. `retry_after` populated from
 *                      the Retry-After header when available; `message`
 *                      forwarded from the body when parseable.
 * - `layer1_reject`  — backend declined the request structurally (off-topic
 *                      consult note, future Layer-1 image gate). UI shows
 *                      "I don't see a plant here" / "Let's keep this about
 *                      your plants" copy, NOT a retry button.
 * - `low_confidence` — reserved for future backend-driven low-confidence
 *                      signal. The current free→paid router hides this from
 *                      the wire (returns degraded fallback inside `data`),
 *                      but the kind is locked so screens can fork on it
 *                      when a server-side gate ships.
 * - `parse_error`    — body wasn't JSON, or didn't match the expected
 *                      `{ ok, kind, ... }` envelope. Symptom of either
 *                      deploy skew (mobile + backend out of sync) or
 *                      transparent middleware mangling the response.
 * - `queued`         — request was offline-queued by the sync layer (E7).
 *                      `ok: false` because the response data isn't yet
 *                      available, not because the request failed. UI shows
 *                      the tan "syncing" banner instead of an error card.
 *                      Locked into the type now, even though E7 isn't yet
 *                      wired, so adding it later isn't a breaking change.
 */
export type ApiResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      kind:
        | 'network'
        | 'timeout'
        | 'server'
        | 'layer1_reject'
        | 'low_confidence'
        | 'parse_error'
        | 'queued';
      message?: string;
      retry_after?: number;
    };

/**
 * Tuple of every locked error kind, in declaration order. Exhaustiveness
 * helper for tests + a runtime guard the client uses to decide whether a
 * backend-emitted `kind` is one the union accepts verbatim.
 */
export const API_ERROR_KINDS = [
  'network',
  'timeout',
  'server',
  'layer1_reject',
  'low_confidence',
  'parse_error',
  'queued',
] as const;

export type ApiErrorKind = (typeof API_ERROR_KINDS)[number];

// ─── Endpoint request types ─────────────────────────────────────────────

/**
 * Identify: send a single image to learn what species it is.
 * Mobile compresses the photo via `expo-image-manipulator` (E5-005) before
 * passing it in. The client itself doesn't compress — too much policy for
 * a transport layer.
 */
export type IdentifyRequest = {
  /**
   * The image to send. Either a `Blob`/`File` (test path), or a React Native
   * file descriptor `{ uri, name?, type? }` for an on-device photo. RN's
   * FormData accepts both shapes; web/test FormData accepts only the first.
   */
  image: ImageInput;
};

/**
 * Diagnose: send a single image (full plant or affected leaf) to learn
 * what's wrong. Same multipart contract as identify on the wire.
 */
export type DiagnoseRequest = {
  image: ImageInput;
};

/**
 * Consult: free-text question + optional plant context. Reuses the backend
 * request body type verbatim — same JSON shape on the wire, no client-side
 * transformation. Aliased here so screens can `import { ConsultRequest }
 * from '../api'` without reaching across packages.
 */
export type ConsultRequest = ConsultRequestBody;

/**
 * Review: weekly summary + per-plant rows. Same passthrough rationale as
 * ConsultRequest.
 */
export type ReviewRequest = ReviewRequestBody;

/**
 * Image input accepted by `identify` / `diagnose`. Browser/test runners
 * provide a `Blob` (or its `File` subclass); RN provides the URI shape.
 *
 * The shape is intentionally permissive: the runtime FormData polyfill
 * decides whether it can accept the value. Type-narrowing here would just
 * mean every caller carries a cast, which loses safety on a real RN device.
 */
export type ImageInput =
  | Blob
  | { uri: string; name?: string; type?: string };

// ─── Endpoint response re-exports ───────────────────────────────────────
// Identical to `@plantcare/api-types` — re-exported here so callers can
// import everything they need from `../api`. If the backend response shape
// changes, the source-of-truth update happens in `@plantcare/api-types`.
export type {
  ConsultResponse,
  DiagnoseResponse,
  IdentifyResponse,
  ReviewResponse,
};
