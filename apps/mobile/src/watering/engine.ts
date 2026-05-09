/**
 * useWateringEngine — pure decision function (E4-001 + E6-005 v2).
 *
 * The deterministic core. Given a plant + its last-watered timestamp + the
 * current time (and, in v2, an optional weather snapshot), return one of
 * three statuses that drives the A-1 list chip and the A-2 detail chip:
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
 * # v2 weather modifier (E6-005)
 *
 * When (and ONLY when) `is_indoor === false` AND `override_interval_days`
 * is null AND a `weather` snapshot is provided, the resolved species
 * interval is adjusted by the forecast:
 *
 *   - sum of `daily[0].precipitation_sum_mm + daily[1].precipitation_sum_mm`
 *     > 5mm  → +2 days (rain coming, skip a watering)
 *   - max of `daily[0].temperature_max_c, daily[1].temperature_max_c`
 *     > 30°C → -1 day (heat stress, water sooner)
 *   - both can apply: net effect (rain + heat = +2 - 1 = +1 day)
 *
 * The modified interval is clamped to `[1, 30]` days — never below 1 (a
 * sub-day interval would constantly fire 'water' for a freshly-watered
 * plant) and never above 30 (a month-long interval defeats the engine's
 * purpose; if the species really wants 35 days, the user sets an override).
 *
 * Worked example: monstera (default 7 days), outdoor, no override, weather
 * forecast = (today 4mm + tomorrow 5mm precipitation = 9mm sum, today max
 * 32°C). 9mm > 5mm → +2; 32°C > 30°C → -1. Modified interval = 7 + 2 - 1 =
 * 8 days. The user sees one extra day of "skip" / "check_soil" verdicts,
 * matching the rain-incoming reality.
 *
 * # Precedence — locked
 *
 * 1. `override_interval_days != null` → use override as-is. Weather and
 *    `is_indoor` are IGNORED. The user explicitly chose a custom interval;
 *    second-guessing them would defeat the override.
 * 2. Otherwise if `is_indoor === true` (the schema default) → use the
 *    species default. Weather is IGNORED. Indoor microclimates are stable;
 *    rain doesn't reach the pot, and indoor temperature tracks the
 *    thermostat, not the outdoor max.
 * 3. Otherwise (`is_indoor === false` AND override null) → apply the
 *    weather modifier above. If `weather` is null (couldn't fetch, location
 *    denied, queued for later), fall back to the unmodified species default
 *    — degrade gracefully rather than withhold a verdict.
 *
 * This function is pure: same `(plant, lastWateredAt, nowMs, weather)` →
 * same status forever. The hook layer (`useWateringEngine`) handles the
 * SQLite read for `lastWateredAt` and the API call for `weather`.
 */
import { getIntervalDays } from './species';

export type WateringStatus = 'water' | 'skip' | 'check_soil';

/**
 * 2-day forecast snapshot consumed by the weather modifier. Subset of
 * `WeatherResponse` from `@plantcare/api-types` — defined locally so the
 * engine module doesn't depend on the API package directly. The hook
 * layer (`useWeather` / `useWateringEngine`) does the mapping.
 *
 * Tuple-typed at exactly two entries to lock the V1 "current + 2 days"
 * scope. Indexing past `[1]` is a compile error.
 */
export type WateringEngineWeatherDaily = {
  /** Maximum forecast temperature in Celsius for the day. */
  temperature_max_c: number;
  /** Cumulative precipitation in millimeters for the day. */
  precipitation_sum_mm: number;
};

export type WateringEngineWeather = {
  daily: [WateringEngineWeatherDaily, WateringEngineWeatherDaily];
};

/**
 * Minimal Plant shape this engine needs. Mirrors the E2-002 SQLite schema
 * for `plants` (id, species_slug, override_interval_days, is_indoor, ...).
 *
 * `is_indoor` defaults to `true` at the engine boundary when omitted: the
 * v1 callers (E4-001) didn't pass it, and the safer fallback for an
 * unknown plant is "no weather modifier" (treat it like a houseplant) so
 * we don't accidentally extend or shorten an outdoor plant's interval
 * because the caller forgot to thread the field through.
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
  /**
   * `true` = indoor (default; weather modifier is skipped). `false` =
   * outdoor (weather modifier applies when override is null). Optional
   * for backwards compatibility with v1 callers — undefined coerces to
   * `true` (the schema default and the safer no-modifier path).
   */
  is_indoor?: boolean;
}

export interface ComputeWateringStatusInput {
  plant: WateringEnginePlant;
  /** Unix milliseconds when this plant was last watered, or null if never. */
  lastWateredAt: number | null;
  /** Unix milliseconds for "now". Caller passes `Date.now()` from the hook. */
  nowMs: number;
  /**
   * Optional 2-day forecast for the plant's location. Only consulted when
   * `is_indoor === false` AND `override_interval_days` is null. Null /
   * undefined → no modifier applied (graceful degrade when the weather
   * API failed or the user denied location).
   */
  weather?: WateringEngineWeather | null;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Locked thresholds (master plan + ticket E6-005). */
export const PRECIPITATION_THRESHOLD_MM = 5;
export const HEAT_THRESHOLD_C = 30;
/** Modified interval is clamped to this band. */
export const MIN_INTERVAL_DAYS = 1;
export const MAX_INTERVAL_DAYS = 30;

/**
 * Resolve the effective interval (in days) for a plant. Override wins over
 * species; species_unknown with no override returns null (rules disabled).
 */
function resolveSpeciesIntervalDays(plant: WateringEnginePlant): number | null {
  if (plant.override_interval_days != null) {
    return plant.override_interval_days;
  }
  if (plant.species_slug === 'species_unknown') {
    return null;
  }
  return getIntervalDays(plant.species_slug);
}

/**
 * Apply the v2 weather modifier to a base interval (in days). Returns the
 * adjusted interval, clamped to `[MIN_INTERVAL_DAYS, MAX_INTERVAL_DAYS]`.
 *
 * Pre-condition (enforced by `computeWateringStatus`): caller has already
 * verified `is_indoor === false` AND `override_interval_days` is null AND
 * `weather` is non-null. This function does NOT re-check those — it just
 * does the math.
 *
 * Exported for direct unit testing of the cap (no current species + modifier
 * combination naturally reaches the [1, 30] clamp, but the clamp is
 * structural protection against a future species table or threshold change
 * that would otherwise underflow / overflow).
 */
export function applyWeatherModifier(
  baseIntervalDays: number,
  weather: WateringEngineWeather,
): number {
  const cumulativePrecipMm =
    weather.daily[0].precipitation_sum_mm + weather.daily[1].precipitation_sum_mm;
  const maxTempC = Math.max(
    weather.daily[0].temperature_max_c,
    weather.daily[1].temperature_max_c,
  );

  let modifier = 0;
  if (cumulativePrecipMm > PRECIPITATION_THRESHOLD_MM) {
    modifier += 2;
  }
  if (maxTempC > HEAT_THRESHOLD_C) {
    modifier -= 1;
  }

  const modified = baseIntervalDays + modifier;
  // Clamp into [1, 30]. Math.max/min not Math.min/max because we want a
  // FLOOR of MIN before a CEILING of MAX — order matters when MIN > MAX
  // would otherwise produce nonsense (it can't here, but defensive).
  return Math.min(MAX_INTERVAL_DAYS, Math.max(MIN_INTERVAL_DAYS, modified));
}

/**
 * Resolve the effective interval (in days) including the v2 weather
 * modifier when applicable. Returns null when rules are disabled
 * (species_unknown with no override).
 */
function resolveEffectiveIntervalDays(
  plant: WateringEnginePlant,
  weather: WateringEngineWeather | null | undefined,
): number | null {
  // Precedence step 1: override wins over everything (species + weather).
  // Returning early here is what makes "override beats weather" a structural
  // invariant rather than a check we have to remember to do later.
  if (plant.override_interval_days != null) {
    return plant.override_interval_days;
  }

  const speciesInterval = resolveSpeciesIntervalDays(plant);
  if (speciesInterval === null) {
    return null;
  }

  // Precedence step 2: indoor (default-true) ignores weather. The schema
  // default is 1/true; v1 callers don't pass `is_indoor`, so undefined
  // also takes this branch — the safe no-modifier path.
  const isIndoor = plant.is_indoor ?? true;
  if (isIndoor) {
    return speciesInterval;
  }

  // Precedence step 3: outdoor + override null. Apply weather if present;
  // degrade to species default if weather is null (couldn't fetch).
  if (weather == null) {
    return speciesInterval;
  }

  return applyWeatherModifier(speciesInterval, weather);
}

export function computeWateringStatus(input: ComputeWateringStatusInput): WateringStatus {
  const { plant, lastWateredAt, nowMs, weather = null } = input;

  const intervalDays = resolveEffectiveIntervalDays(plant, weather);

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
