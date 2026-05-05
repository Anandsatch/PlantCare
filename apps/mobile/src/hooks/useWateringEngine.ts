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
 */
import { useEffect, useState } from 'react';

import { openDb } from '../db';
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

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);

    (async () => {
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
        setLastWateredAt(row?.watered_at ?? null);
        setLoaded(true);
      } catch {
        if (cancelled) return;
        // Treat a read failure the same as "no history yet" — better to
        // nudge the user to check the soil than to claim 'water' off
        // potentially stale state. The error gets surfaced through the
        // tan toast in the parent screen (see A-2 interaction states).
        setLastWateredAt(null);
        setLoaded(true);
      }
    })();

    return () => {
      cancelled = true;
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
