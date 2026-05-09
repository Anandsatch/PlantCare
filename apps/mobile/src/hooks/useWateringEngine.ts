/**
 * useWateringEngine — React hook that wraps `computeWateringStatus` with a
 * SQLite read for the plant's most recent `watering_events.watered_at`.
 *
 * v2 (E6-005) adds two optional inputs threaded straight to the engine:
 *   - `is_indoor` (boolean): false enables the weather modifier when
 *     `override_interval_days` is null. Defaults to `true` at the engine
 *     boundary if the plant row doesn't carry the field — backwards
 *     compatible with v1 callers that don't read `is_indoor` from SQLite.
 *   - `weather` (WateringEngineWeather | null): a 2-day forecast snapshot.
 *     Null / undefined → no modifier (graceful degrade when the weather
 *     API is unreachable, the user denied location, or the request is
 *     queued for later).
 *
 * The engine itself owns the precedence rules (override > indoor > weather)
 * and the threshold math (5mm precip → +2 days, 30°C max → -1 day, clamp
 * to [1, 30]). This hook just plumbs the inputs through.
 *
 * Async load window: while the SQLite read is in flight (or before it
 * completes after mount), we return 'check_soil' as the safe default.
 * Same fallback the engine uses when `lastWateredAt` is null — the user
 * gets a nudge to look at the soil, never a false-positive 'water' on an
 * unloaded row.
 *
 * The hook avoids races by tracking a `cancelled` flag inside the effect:
 * if the plant.id changes (or the component unmounts) before the SQLite
 * read resolves, the stale result is discarded instead of overwriting
 * fresher state. The weather argument is passed in fresh on every render
 * (callers feed it from `useWeather()` or pass null) and does NOT trigger
 * a re-fetch — only `plant.id` does.
 */
import { useEffect, useState } from 'react';

import { openDb } from '../db';
import {
  computeWateringStatus,
  type WateringEnginePlant,
  type WateringEngineWeather,
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
 *
 * @param plant Plant row (with optional v2 fields `is_indoor` and
 *              `override_interval_days`). v1 callers passing only
 *              `{ id, species_slug, override_interval_days }` get
 *              identical behavior to E4-001 — `is_indoor` defaults to
 *              `true` (no weather modifier).
 * @param weather Optional 2-day forecast. Only consulted by the engine
 *                when the plant is outdoor with no override. Null or
 *                undefined → no modifier (graceful degrade).
 */
export function useWateringEngine(
  plant: UseWateringEnginePlant,
  weather: WateringEngineWeather | null = null,
): WateringStatus {
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
    weather,
  });
}
