/**
 * `wateringEventsBus` — module-level pub/sub for cross-hook watering changes.
 *
 * # Why a bus, vs. a callback prop
 *
 * `useWateringEngine` is mounted inside `<PlantDetailScreen>`; the new
 * `useMarkWatered` mutation lives in the same screen but does the SQLite
 * INSERT independently. With the existing E4-005 contract — the screen is a
 * pure composite, the parent owns the `wateringEvents` prop — there's no
 * shared state surface that lets the engine learn about the new row without
 * either (a) plumbing a callback through every interested hook or (b) the
 * parent re-querying SQLite and re-passing props on every mutation.
 *
 * (a) is cargo-cult: every consumer of `useWateringEngine` would need a
 * `refresh` prop bolted on. (b) makes the chip + subline flip wait on a
 * round-trip through the parent, which the master plan A-2 spec ("forest
 * CTA confirms in-place; 7-day ledger updates immediately") explicitly
 * rejects. So: a tiny synchronous bus, scoped to the watering surface.
 *
 * # Optimistic update protocol
 *
 * `useMarkWatered.mutate()`:
 *   1. `wateringEventsBus.emitOptimistic(plantId, wateredAtMs)` — fires
 *      synchronously before the INSERT. `useWateringEngine` reads the
 *      optimistic timestamp and re-derives status immediately so the chip
 *      flips before the SQL roundtrip.
 *   2. `INSERT INTO watering_events ... RETURNING *` (atomic write+read,
 *      avoiding the UPDATE-then-SELECT race the master plan locks).
 *   3a. On success → `wateringEventsBus.emitCommit(plantId)`. Subscribers
 *       drop the optimistic value and re-query SQLite for the canonical
 *       state. The optimistic ts and the committed row's `watered_at` will
 *       match (we use the same `Date.now()` for both); the re-query is the
 *       source-of-truth confirmation.
 *   3b. On failure → `wateringEventsBus.emitRollback(plantId)`. Subscribers
 *       drop the optimistic value and re-query. The query returns the same
 *       pre-INSERT state, so the chip flips back to its original verdict.
 *
 * # Concurrency
 *
 * Listeners are invoked synchronously in registration order. The bus does
 * NOT batch or schedule — emits within a React render are inert (because the
 * subscriber's setState lands on the next render anyway), but emits during
 * an event handler trigger React's batched-updates machinery as expected.
 *
 * # Why this is a module-level singleton
 *
 * Two reasons. First, `openDb()` is also a module-level singleton (memoized
 * connection); the bus mirrors that lifecycle so a write and the
 * corresponding read both see the same world. Second, `useWateringEngine`
 * needs to subscribe regardless of which `useMarkWatered` instance fires —
 * a context provider would force the screen to wrap, which the screen tree
 * doesn't currently do. A shared module is simpler and tested via the
 * `_resetForTests()` escape hatch (mirrors `_resetDbCacheForTests`).
 *
 * # V1 scope locks
 *
 * - No EventEmitter / mitt / nanoevents / RxJS. The Set-of-listeners pattern
 *   is ~30 LOC and zero deps.
 * - No global app-wide bus. Scoped to the watering surface; a future
 *   `notesEventsBus` etc. would follow the same shape but live in its own
 *   module (no premature unification).
 * - No persistence. The bus carries transient signals only — the source of
 *   truth is SQLite. Optimistic state lives in subscriber memory and is
 *   reconciled on the next emit.
 */

export type WateringBusEvent =
  /** Mutation has been requested; an INSERT is in flight. Subscribers should
   *  treat `wateredAtMs` as a tentative last-watered until a `commit` or
   *  `rollback` arrives. */
  | { kind: 'optimistic'; plantId: string; wateredAtMs: number }
  /** INSERT succeeded; subscribers should re-query SQLite for the canonical
   *  state and drop any optimistic value for `plantId`. */
  | { kind: 'commit'; plantId: string }
  /** INSERT failed; subscribers should drop the optimistic value and (if
   *  desired) re-query SQLite to surface the pre-INSERT state. */
  | { kind: 'rollback'; plantId: string };

export type WateringBusListener = (event: WateringBusEvent) => void;

/**
 * Module-level Set of listeners. A Set (not an Array) so unsubscribing is
 * O(1) and double-subscribe is a no-op (idiomatic for hooks that subscribe
 * inside `useEffect` and might re-run during fast-refresh).
 */
const listeners: Set<WateringBusListener> = new Set();

/**
 * Subscribe to bus events. Returns the unsubscribe function — same shape
 * as `addEventListener` returns nothing but most React idioms expect a
 * cleanup-fn return so the call site can `useEffect(() => subscribe(...))`.
 */
function subscribe(listener: WateringBusListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function emit(event: WateringBusEvent): void {
  // Snapshot the listener set before iteration so a listener that
  // unsubscribes itself mid-emit doesn't shift the iteration.
  const snapshot = Array.from(listeners);
  for (const fn of snapshot) {
    try {
      fn(event);
    } catch (err) {
      // A listener throwing should not break the emitter or other
      // listeners. Surface in dev; swallow in prod (a thrown listener is a
      // bug in that listener, not a reason to lose the event).
      if (typeof __DEV__ !== 'undefined' && __DEV__) {
        // eslint-disable-next-line no-console
        console.error('wateringEventsBus listener threw:', err);
      }
    }
  }
}

function emitOptimistic(plantId: string, wateredAtMs: number): void {
  emit({ kind: 'optimistic', plantId, wateredAtMs });
}

function emitCommit(plantId: string): void {
  emit({ kind: 'commit', plantId });
}

function emitRollback(plantId: string): void {
  emit({ kind: 'rollback', plantId });
}

/**
 * Test-only escape hatch. Drops every subscription so tests can start from
 * a clean bus. Mirrors `_resetDbCacheForTests` in `db/db.ts`.
 */
function _resetForTests(): void {
  listeners.clear();
}

export const wateringEventsBus = {
  subscribe,
  emitOptimistic,
  emitCommit,
  emitRollback,
  _resetForTests,
};

export type WateringEventsBus = typeof wateringEventsBus;
