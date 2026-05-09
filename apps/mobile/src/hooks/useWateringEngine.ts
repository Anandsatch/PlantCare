/**
 * useWateringEngine — React hook that wraps `computeWateringStatus` with a
 * SQLite read for the plant's most recent `watering_events.watered_at`.
 *
 * Async load window: while the read is in flight (or before it completes
 * after mount), we return 'check_soil' as the safe default. Same fallback
 * the engine uses when `lastWateredAt` is null — the user gets a nudge to
 * look at the soil, never a false-positive 'water' on an unloaded row.
 *
 * The hook avoids races by tracking a `cancelled` flag inside the effect:
 * if the plant.id changes (or the component unmounts) before the SQLite
 * read resolves, the stale result is discarded instead of overwriting
 * fresher state.
 *
 * # Bus subscription (E4-006)
 *
 * Subscribes to `wateringEventsBus` for the same `plant.id`:
 *
 *   - `optimistic` — sets `lastWateredAt` to the optimistic timestamp
 *     synchronously so the chip flips before the INSERT roundtrip
 *     resolves. Marks the value as optimistic so a `commit` re-reads
 *     SQLite to confirm and a `rollback` re-reads to revert.
 *   - `commit` / `rollback` — re-runs the SELECT for the canonical state.
 *
 * The bus is a module-level singleton (see `db/wateringEvents.ts`); the
 * subscription is set up inside the same `useEffect` that performs the
 * initial read so cleanup handles unmount + plant.id change uniformly.
 */
import { useEffect, useRef, useState } from 'react';

import { openDb } from '../db';
import { wateringEventsBus } from '../db/wateringEvents';
import {
  computeWateringStatus,
  type WateringEnginePlant,
  type WateringStatus,
} from '../watering';

/** Plant fields the hook needs. Subset of the SQLite `plants` row. */
export interface UseWateringEnginePlant extends WateringEnginePlant {
  id: string;
}

/**
 * Compute the live watering status for a plant. Re-reads the most recent
 * watering event whenever `plant.id` changes. Returns 'check_soil' during
 * the SQLite load window; once loaded, returns the engine's verdict.
 */
export function useWateringEngine(plant: UseWateringEnginePlant): WateringStatus {
  const [lastWateredAt, setLastWateredAt] = useState<number | null>(null);
  const [loaded, setLoaded] = useState(false);

  // Mirror state into a ref so the bus listener (closed over the initial
  // render's state) sees the latest value when checking for staleness.
  // Refs are write-allowed inside effects without re-render cost; this is
  // the minimum-disruption way to give the listener a fresh read.
  const lastWateredAtRef = useLatestRef(lastWateredAt);

  // Generation counter for read sequencing. Codex P1 — without this, two
  // races are possible:
  //   (a) initial mount: readLatest() starts → optimistic event arrives and
  //       advances lastWateredAt → readLatest() resolves with the *old* DB
  //       state and clobbers the optimistic value back to stale.
  //   (b) rapid mutations: mutation A's commit triggers a re-read → mutation
  //       B fires optimistic before A's read resolves → A's stale read
  //       lands and overwrites B's fresh optimistic ts.
  // Fix: every optimistic emit bumps the generation, and every read captures
  // the generation at start. A read whose generation no longer matches the
  // current one is dropped on resolve. Same pattern as `useDiagnoseRequest`'s
  // `lastCommittedCallIdRef`.
  const readGenerationRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    // New mount / new plantId — fresh generation lineage. Also clear the
    // last-watered state and its mirror ref so a previous plant's value
    // doesn't suppress the new plant's optimistic flip via the
    // `event.wateredAtMs > prev` guard below (codex P2). Without this, a
    // future-timestamp / clock-skew interaction could leave the chip stale
    // until the commit re-query lands.
    readGenerationRef.current = 0;
    setLastWateredAt(null);
    lastWateredAtRef.current = null;

    async function readLatest(): Promise<void> {
      const myGen = readGenerationRef.current;
      try {
        const db = await openDb();
        // Most recent watering event for this plant. Uses
        // idx_water_plant_date (plant_id, watered_at DESC).
        const row = await db.getFirstAsync<{ watered_at: number }>(
          `SELECT watered_at FROM watering_events
           WHERE plant_id = ?
           ORDER BY watered_at DESC
           LIMIT 1`,
          plant.id,
        );
        if (cancelled) return;
        // If an optimistic event bumped the generation while we were
        // awaiting, the optimistic value is fresher than our SQL row.
        // Drop the read; the next commit/rollback will trigger a new
        // readLatest() with a current generation.
        if (readGenerationRef.current !== myGen) return;
        setLastWateredAt(row?.watered_at ?? null);
        setLoaded(true);
      } catch {
        if (cancelled) return;
        if (readGenerationRef.current !== myGen) return;
        // Treat a read failure the same as "no history yet" — better to
        // nudge the user to check the soil than to claim 'water' off
        // potentially stale state. The error gets surfaced through the
        // tan toast in the parent screen (see A-2 interaction states).
        setLastWateredAt(null);
        setLoaded(true);
      }
    }

    void readLatest();

    // Subscribe to the bus for the lifetime of this plant.id. The bus is
    // module-level, so the same subscription survives a re-render of the
    // parent screen but tears down on plant.id change / unmount.
    const unsubscribe = wateringEventsBus.subscribe((event) => {
      if (event.plantId !== plant.id) return;
      if (cancelled) return;
      if (event.kind === 'optimistic') {
        // Bump the generation so any in-flight readLatest() that started
        // before this emit drops its result on resolve. Codex P1 fix.
        readGenerationRef.current += 1;
        // Apply the optimistic value synchronously so the chip flips
        // before the SQL roundtrip. Only advance if the optimistic ts
        // is newer than what we already have — guards against a stale
        // event arriving after a fresher canonical read (defensive; the
        // bus protocol shouldn't produce that ordering, but the cost of
        // the check is one comparison).
        const prev = lastWateredAtRef.current;
        if (prev == null || event.wateredAtMs > prev) {
          lastWateredAtRef.current = event.wateredAtMs;
          setLastWateredAt(event.wateredAtMs);
          setLoaded(true);
        }
      } else {
        // commit | rollback → re-read the canonical state from SQLite.
        // Both branches do the same thing: a re-query overwrites the
        // optimistic value with the truth. On commit, the truth equals
        // the optimistic ts; on rollback, the truth is the prior row.
        // The new readLatest() captures the *current* generation so a
        // subsequent optimistic emit (from a fresh mutation) will
        // correctly invalidate it.
        void readLatest();
      }
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [plant.id]);

  if (!loaded) {
    return 'check_soil';
  }

  return computeWateringStatus({
    plant,
    lastWateredAt,
    nowMs: Date.now(),
  });
}

/**
 * Tiny helper: keep a ref pointed at the latest value without firing a
 * render. Inlined here because it's a one-off; if a third consumer needs
 * it, lift to `src/lib/hooks/useLatestRef.ts`.
 */
function useLatestRef<T>(value: T): { current: T } {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}
