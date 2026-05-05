/**
 * useWateringEngine — pure decision function (E4-001).
 *
 * The deterministic core. Given a plant + its last-watered timestamp + the
 * current time, return one of three statuses that drives the A-1 list chip
 * and the A-2 detail chip:
 *
 *   - 'water'      → past the full interval; user should water today
 *   - 'check_soil' → in the bias zone (between half-interval and full
 *                    interval, OR rules disabled and we don't know)
 *   - 'skip'       → before the bias zone; recently watered, leave it alone
 *
 * # Critical invariant — millisecond math, not calendar days
 *
 * All time arithmetic is in unix milliseconds. The function is pure with
 * respect to UTC ms and is NOT influenced by:
 *   - the device's local timezone
 *   - DST forward / backward transitions
 *   - international date line crossings
 *   - Intl calendar fields (Date.getDate, toLocaleDateString, etc.)
 *
 * The watering interval is `intervalDays * 24 * 60 * 60 * 1000`. We compare
 * `nowMs - lastWateredAt` against that. No `new Date(...)` construction. No
 * `setHours(0, 0, 0, 0)` "day bucketing". No `Math.floor((now - then) /
 * 86400000)` calendar-day diffing. The timezone-regression suite
 * (E4-002) enforces this.
 *
 * Why this matters: a user who waters at 12:00 LA time, then flies to
 * Sydney, opens the app at 12:00 Sydney time the next day. Wall-clock
 * "days" lie due to the IDL crossing. ms math says "actually 19 hours
 * elapsed" and behaves correctly. DST transitions create 23h or 25h
 * "days" — same problem, same fix.
 *
 * This function is pure: same `(plant, lastWateredAt, nowMs)` → same
 * status forever. The hook layer (`useWateringEngine`) handles the SQLite
 * read for `lastWateredAt`.
 */
import { getIntervalDays } from './species';

export type WateringStatus = 'water' | 'skip' | 'check_soil';

/**
 * Minimal Plant shape this engine needs. Mirrors the E2-002 SQLite schema
 * for `plants` (id, species_slug, override_interval_days, ...). Defined
 * inline here so the engine doesn't yet depend on a full Plant type
 * (E2-003 PR has not landed in this worktree).
 *
 * When E2-003 adds the canonical `Plant` type, this can be replaced with a
 * `Pick<Plant, 'species_slug' | 'override_interval_days'>` import — the
 * engine only reads those two fields.
 */
export interface WateringEnginePlant {
  species_slug: string;
  /**
   * User-set custom interval in days, or null to fall back to the species
   * default. Wins over the species table — a plant marked
   * `override_interval_days = 3` waters every 3 days regardless of
   * species. See E6-006 "Edit details" sheet.
   */
  override_interval_days: number | null;
}

export interface ComputeWateringStatusInput {
  plant: WateringEnginePlant;
  /** Unix milliseconds when this plant was last watered, or null if never. */
  lastWateredAt: number | null;
  /** Unix milliseconds for "now". Caller passes `Date.now()` from the hook. */
  nowMs: number;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Resolve the effective interval (in days) for a plant. Override wins over
 * species; species_unknown with no override returns null (rules disabled).
 */
function resolveIntervalDays(plant: WateringEnginePlant): number | null {
  if (plant.override_interval_days != null) {
    return plant.override_interval_days;
  }
  if (plant.species_slug === 'species_unknown') {
    return null;
  }
  return getIntervalDays(plant.species_slug);
}

export function computeWateringStatus(input: ComputeWateringStatusInput): WateringStatus {
  const { plant, lastWateredAt, nowMs } = input;

  const intervalDays = resolveIntervalDays(plant);

  // Rules disabled: species we don't know about and the user hasn't set an
  // override. The A-2 ledger shows outline droplets and the chip nudges
  // the user to feel the soil (per master plan: "just-added plant shows 7
  // outline droplets + hint").
  if (intervalDays === null) {
    return 'check_soil';
  }

  // Just-added plant with no watering history: same fallback as rules-
  // disabled. We don't know when this plant was last watered, so we can't
  // compute elapsed time. Don't claim "water now" without evidence.
  if (lastWateredAt === null) {
    return 'check_soil';
  }

  const intervalMs = intervalDays * MS_PER_DAY;
  const elapsedMs = nowMs - lastWateredAt;

  // Past the full interval → water. The boundary (elapsedMs === intervalMs)
  // counts as 'water'; matches the spec ("elapsed = exactly interval →
  // 'water'").
  if (elapsedMs >= intervalMs) {
    return 'water';
  }

  // Below the half-interval → recently watered, leave it alone. Strict <
  // so the boundary at exactly half-interval falls through to
  // 'check_soil' (matches the spec).
  if (elapsedMs < intervalMs / 2) {
    return 'skip';
  }

  // Between half-interval and full-interval → bias toward checking. The
  // engine deliberately under-claims certainty here; the user gets a
  // nudge to look at the soil rather than a confident "water" or "skip".
  return 'check_soil';
}
