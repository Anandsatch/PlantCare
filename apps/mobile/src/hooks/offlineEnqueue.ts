/**
 * Shared offline-enqueue helper for the three LLM request hooks
 * (`useDiagnoseRequest`, `useConsultRequest`, `useIdentifyRequest`).
 *
 * E7-004. Promotes the previous UI-only `network → queued` coercion (E5-006)
 * into real persistence: when the device is offline OR the api-client
 * surfaces `kind: 'network'`, the hook inserts a row into `sync_queue` so
 * the SyncDrainer (E7-002) can replay it on reconnect.
 *
 * ─── Why this lives in `hooks/` and not in `sync/` ───────────────────────
 *
 * The hook layer owns the enqueue *decision* (what payload, what dedupe
 * key, when to short-circuit the network call). The `sync/` layer (E7-001
 * `enqueueRequest`) owns the *persistence* (atomic insert + state
 * machine). Splitting the concern keeps the per-endpoint shape (diagnose
 * carries an image descriptor; consult carries a note + context) at the
 * call site where the types are most expressive.
 *
 * ─── Dedupe key ──────────────────────────────────────────────────────────
 *
 * Two consecutive identical requests fired before the drainer runs MUST
 * collapse to one row. We hash the payload via FNV-1a 32-bit (deterministic,
 * dependency-free, collision-resistant for the request volumes V1 sees:
 * worst case a user fires < 100 distinct queued requests per offline
 * session, vs 2^32 hash space). The `(refTable, refId)` tuple uses the
 * endpoint as refTable so two endpoints with the same payload hash do not
 * collide; the refId is the hex hash.
 *
 * Cross-user collision: V1 ships with one device per app install (no auth,
 * no multi-user). The X-Device-Id header binds backend-side rate limiting
 * to the device; the queue is mobile-local. So "across users" reduces to
 * "the same user, same device, two identical payloads," which is exactly
 * the case we WANT to dedupe.
 *
 * Cross-plant: identical-text consult notes against different plants
 * differ in `plant_context`, which is part of the payload — so they hash
 * differently and don't dedupe. Same photo URI for two different plant
 * diagnose requests would dedupe (and that's correct — same photo, same
 * call; the drain produces one diagnosis result, attached to whichever
 * row owns the photo).
 *
 * ─── Pre-flight vs post-call ─────────────────────────────────────────────
 *
 * Pre-flight (netInfo says offline): SKIP the api-client call entirely
 * and enqueue. This avoids burning the api-client's 20s timeout on a
 * fetch that physically cannot reach the backend, and the radio battery
 * cost of even attempting.
 *
 * Post-call (api-client returns `kind: 'network'`): enqueue THEN return
 * queued. This catches DNS / TLS / captive-portal failures where netInfo
 * still reports online (because the radio is up; the path beyond the
 * radio is broken).
 *
 * The two paths cannot both fire for one user-perceived call: pre-flight
 * short-circuits, so post-call only runs when pre-flight said "go." This
 * is the codex P1 risk surface "double-enqueue" — addressed by
 * short-circuiting, not by a second-pass dedupe (we want the dedupe layer
 * to defend against legitimately-identical user inputs across calls, not
 * paper over a control-flow bug here).
 *
 * ─── Photo URI durability ────────────────────────────────────────────────
 *
 * The diagnose / identify hooks accept a photo URI that the drainer will
 * read on replay. The drainer can run in a fresh app process (the user
 * killed the app between enqueue and reconnect), so the URI MUST point
 * into `FileSystem.documentDirectory` (persistent across launches) — NOT
 * `cacheDirectory` (volatile; iOS purges on memory pressure, Android
 * purges on app-storage clean).
 *
 * The hook layer does NOT enforce this — the photo-pipeline (E5-005)
 * already writes to `documentDirectory`, and adding a runtime URI check
 * here would be a wrong-layer assertion. The risk is tracked via codex
 * adversarial review (P2) and the test suite pins the expected URI
 * shape against the documentDirectory contract.
 */

import {
  type QueueExecutor,
  type QueueKind,
} from '../sync';

/**
 * Configuration the request hooks accept to opt into real enqueueing.
 *
 * Optional. When omitted, the hooks behave exactly as they did pre-E7-004:
 * the offline path returns `{ ok:false, kind:'queued' }` without
 * persistence (the legacy UI-only coercion). Existing screens that don't
 * yet pass a queue config keep working; E7-004 wires real callers.
 *
 * `nowMs` is exposed only for tests. Production reads `Date.now()` at the
 * enqueue site so the persisted `next_attempt_at` / `created_at` are
 * wall-clock UTC ms (E4-002 critical regression contract — no calendar
 * arithmetic anywhere in the queue).
 */
export interface OfflineQueueConfig {
  /**
   * QueueExecutor (E7-001) — typically the same `expo-sqlite` connection
   * the rest of the app uses. Tests inject a `better-sqlite3`-backed
   * adapter (see `__tests__/useDiagnoseRequest.test.tsx`).
   */
  db: QueueExecutor;
  /**
   * Override clock for tests. Production omits.
   */
  nowMs?: () => number;
}

/**
 * What a request hook needs to enqueue: the wire endpoint name (matches
 * `QueueKind` so the drainer's dispatch table can drive it), the payload
 * the drainer will JSON.parse + forward, and a stable input hash for
 * dedupe.
 */
export interface EnqueueWiring<TPayload> {
  endpoint: QueueKind;
  payload: TPayload;
  /**
   * Stable input hash. The hook computes this from its input (photoUri,
   * note + plantContext, etc.) — see `hashStable`. The (endpoint, hash)
   * tuple is the dedupe identity.
   */
  inputHash: string;
}

/**
 * Enqueue a request via the E7-001 CRUD layer. Returns the enqueue result
 * so the hook can attach diagnostic data to a future telemetry event;
 * V1 callers ignore the return.
 *
 * ─── Dedupe semantics (codex P1 from adversarial review) ───────────────
 *
 * `enqueueRequest` (E7-001) dedupes against ANY row with a matching
 * `(ref_table, ref_id)` regardless of status — including rows already
 * `done` or `failed`. That contract is correct for the CRUD primitive
 * but wrong for the hook layer: a user who successfully diagnoses photo
 * A, then a week later wants to diagnose photo A again, must NOT have
 * the second submit silently coalesce into the prior `done` row.
 *
 * Fix at this layer (not the CRUD): only dedupe against rows that are
 * still pending or in_flight. If a prior row went terminal (done /
 * failed), insert a fresh row with a *unique* dedupeKey so the new
 * request is its own queue entry — the natural-key columns stay
 * populated (NOT NULL) without colliding.
 *
 * The unique-key path is the (refTable=endpoint, refId=hash + ':' +
 * attemptNonce) tuple. The attemptNonce is a millisecond timestamp
 * appended to the inputHash; collisions across the SAME ms are
 * impossible because (a) terminal-rows-with-same-base-hash are excluded
 * from the live-dedupe probe ABOVE, and (b) two parallel hooks at the
 * same ms would both see no live row and both insert — at which point
 * a sibling-hook race within < 1ms is so rare we accept the
 * over-enqueue (the drainer's idempotent claim handles the
 * double-fire). The (endpoint, hash, ms) triple defends against the
 * common case while keeping the layer simple.
 *
 * Why not change `enqueueRequest`'s contract: doing so would break
 * `queueCrud.test.ts`'s explicit "any existing row blocks insert"
 * assertion, and other E7-001 callers may rely on the cross-status
 * dedupe semantics. Keeping the CRUD primitive narrow and adding
 * "live-only dedupe" at the hook layer is the smaller blast radius.
 */
export async function enqueueOffline<TPayload>(
  config: OfflineQueueConfig,
  wiring: EnqueueWiring<TPayload>,
): Promise<{ id: string; inserted: boolean }> {
  const refTable = wiring.endpoint;
  const refIdBase = wiring.inputHash;
  const nowMs = config.nowMs ? config.nowMs() : Date.now();
  const payloadJson = JSON.stringify(wiring.payload ?? null);

  // The probe + insert MUST run atomically. Without a single
  // transaction, two parallel hooks (StrictMode double-mount, or
  // Promise.all on a double-tap) could both see "no live row" and both
  // insert — a TOCTOU race that defeats dedupe. The exclusive
  // transaction blocks the second probe until the first commits, so
  // the second observes the freshly-inserted live row and dedupes.
  //
  // We can't reuse `enqueueRequest`'s exclusive transaction directly
  // because its dedupe is cross-status (which is what we're working
  // around — see file header). Instead, we recreate the
  // probe-then-insert pattern with our live-only predicate.
  let result: { id: string; inserted: boolean } | null = null;
  await config.db.withExclusiveTransactionAsync(async () => {
    // Live-only dedupe probe: pending/in_flight only. Done/failed
    // rows do NOT block a fresh enqueue. The probe scans by ref_id
    // exact OR prefix-LIKE to catch the "first pending row of this
    // hash" (refId = base, hypothetical legacy shape) AND the
    // fresh-key path (refId = base:ms-counter).
    const live = await config.db.getFirstAsync<{ id: string }>(
      "SELECT id FROM sync_queue " +
        "WHERE ref_table = ? AND (ref_id = ? OR ref_id LIKE ?) " +
        "AND status IN ('pending', 'in_flight') LIMIT 1",
      [refTable, refIdBase, refIdBase + ':%'],
    );
    if (live) {
      result = { id: live.id, inserted: false };
      return;
    }

    // No live duplicate. Use a unique refId so the cross-status
    // dedupe in `enqueueRequest` doesn't latch onto a prior terminal
    // row with the same base hash. The suffix combines nowMs and a
    // module-scoped monotonic counter; the counter defends against
    // sub-millisecond rapid-fire collisions.
    const refId =
      refIdBase +
      ':' +
      nowMs.toString(36) +
      '-' +
      (++processCounter).toString(36);

    const id = generateId();
    await config.db.runAsync(
      "INSERT INTO sync_queue (" +
        "id, endpoint, payload_json, ref_table, ref_id, " +
        "status, attempt_count, next_attempt_at, created_at, expires_at, last_error" +
        ") VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, NULL)",
      [
        id,
        wiring.endpoint,
        payloadJson,
        refTable,
        refId,
        nowMs,
        nowMs,
        nowMs + TTL_MS_LOCAL,
      ],
    );
    result = { id, inserted: true };
  });
  if (!result) {
    throw new Error('enqueueOffline: transaction completed without setting result');
  }
  return result;
}

/**
 * 7-day TTL in ms — duplicated locally so this module doesn't depend
 * on the CRUD layer's internals beyond `enqueueRequest`. The schema
 * column `expires_at` is informational (the sweeper uses created_at
 * directly per E7-001), so a small drift between this constant and
 * the CRUD's TTL_MS would not change correctness; we keep them in
 * sync intentionally.
 */
const TTL_MS_LOCAL = 7 * 86_400_000;

function generateId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (!c?.randomUUID) {
    throw new Error('crypto.randomUUID unavailable; cannot generate sync_queue id');
  }
  return c.randomUUID();
}

/**
 * Module-scoped monotonic counter appended to refIds to guarantee
 * uniqueness when two enqueues fire in the same millisecond. Reset
 * implicitly when the JS context is destroyed (app kill / test reload).
 *
 * Not a security boundary — collisions across counter wrap-around
 * (after 2^53 enqueues, ~285,000 years at one per microsecond) are
 * impossible for V1's request volume. The same nowMs branch already
 * guards against the cross-status dedupe; this counter only exists so
 * sub-millisecond rapid-fire taps don't collapse.
 */
let processCounter = 0;

/**
 * Wrapper around `enqueueOffline` that swallows persistence errors
 * defensively. The hook layer already has a fallback path: returning
 * `{ ok:false, kind:'queued' }` to the UI is the correct UX even if
 * sync_queue insert failed (the user sees "queued"; the worst case is
 * the request is dropped, identical to pre-E7-004 behavior). Throwing
 * out of this branch would crash the camera / add-note flow on a
 * disk-full or corrupted-db edge case, which is strictly worse.
 *
 * The error is logged via `console.warn` so the test harness can assert
 * the error path triggers; production observability hooks (E13) will
 * upgrade this to a structured event.
 *
 * Codex P3 from adversarial review: a pure throw would let a transient
 * SQLite write error propagate up through the React `setState` callback
 * and leave `status` stuck on 'requesting'. Catching here keeps the
 * status machine consistent.
 */
export async function safeEnqueue<TPayload>(
  config: OfflineQueueConfig,
  wiring: EnqueueWiring<TPayload>,
): Promise<{ id: string; inserted: boolean } | null> {
  try {
    return await enqueueOffline(config, wiring);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[offlineEnqueue] failed to persist ${wiring.endpoint} request:`,
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

/**
 * FNV-1a 32-bit hash of a string, returned as 8-character lowercase hex.
 *
 * Hashes the string's UTF-8 bytes. Crucially NOT `charCodeAt() & 0xff`
 * — that mask collapses all 65,536 UTF-16 code units to 256 buckets,
 * which means a non-ASCII consult note like `"é"` (U+00E9) collides
 * with `"ǩ"` (U+01E9) and any other code unit ending in 0xE9. Codex
 * P2 from re-review.
 *
 * The TextEncoder polyfill is available in Hermes (RN 0.74+) and Node
 * 11+, so both production and the Jest test environment have it. If a
 * future engine drops it, the fallback throws — better to fail loud
 * than silently corrupt the dedupe surface.
 *
 * Deterministic, dependency-free, fast. Collision-resistant for V1's
 * request volumes (a heavy offline session is < 100 distinct requests;
 * the hash space is 2^32 ≈ 4.3 billion). Not cryptographic — we don't
 * need it to be; the dedupe surface only protects against accidental
 * double-tap, not adversarial input.
 *
 * We use FNV-1a (not Math.random or Date.now) because the dedupe key
 * MUST be stable: two consecutive submissions of the SAME input must
 * produce the SAME key, or dedupe fails and we double-enqueue.
 */
export function fnv1a32Hex(s: string): string {
  const enc =
    typeof TextEncoder !== 'undefined' ? new TextEncoder() : undefined;
  if (!enc) {
    throw new Error('TextEncoder is unavailable; cannot compute UTF-8 hash');
  }
  const bytes = enc.encode(s);
  // FNV-1a 32-bit: hash = 2166136261; for each byte, hash = (hash ^ byte) * 16777619 (mod 2^32).
  let hash = 0x811c9dc5; // 2166136261
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i]!;
    // Multiply mod 2^32. Math.imul is the standard JS idiom.
    hash = Math.imul(hash, 0x01000193);
  }
  // Force unsigned 32-bit before hex-stringifying so negative-as-signed
  // values don't render with a '-' sign.
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Stable hash over an arbitrary JSON-serializable input. Sorts object
 * keys recursively before stringifying so `{a:1, b:2}` and `{b:2, a:1}`
 * hash identically — JSON.stringify alone does not sort, and a user
 * tapping submit twice with the same logical input but different key
 * insertion order (e.g. plant_context built two different ways) would
 * otherwise hash differently and bypass dedupe.
 *
 * Arrays are NOT sorted — array order is semantic in V1 payloads (e.g.
 * `fix_steps`), and reordering would change meaning.
 */
export function hashStable(input: unknown): string {
  return fnv1a32Hex(stableStringify(input));
}

function stableStringify(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'number') {
    // Number.isFinite (not typeof === 'number') — codex catch on the
    // numeric branch. NaN / ±Infinity are not JSON-representable; treat
    // them as a sentinel string so they don't poison the hash silently.
    return Number.isFinite(value) ? String(value) : '"__nonfinite__"';
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'undefined') return 'null';
  if (Array.isArray(value)) {
    return '[' + value.map((v) => stableStringify(v)).join(',') + ']';
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return (
      '{' +
      keys
        .map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k]))
        .join(',') +
      '}'
    );
  }
  // bigint / symbol / function — not expected in V1 payloads. Fall back
  // to String() to keep the function total.
  return JSON.stringify(String(value));
}
