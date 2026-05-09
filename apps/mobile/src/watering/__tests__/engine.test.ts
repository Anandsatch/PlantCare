/**
 * Pure-function unit tests for `computeWateringStatus`.
 *
 * Companion file `timezone-regression.test.ts` carries the E4-002
 * critical regression. This file is the boundary + state-table coverage:
 * just-added plants, override winning over species, the half-interval +
 * full-interval boundaries, and the unknown-species fallback.
 *
 * All tests construct `lastWateredAt` and `nowMs` as plain unix
 * milliseconds — no `new Date(...)` constructors, no DST math. The
 * engine is pure with respect to ms; the regression file proves that.
 */
import {
  applyWeatherModifier,
  computeWateringStatus,
  HEAT_THRESHOLD_C,
  MAX_INTERVAL_DAYS,
  MIN_INTERVAL_DAYS,
  PRECIPITATION_THRESHOLD_MM,
  type WateringEnginePlant,
  type WateringEngineWeather,
} from '../engine';

const DAY_MS = 24 * 60 * 60 * 1000;

function plant(overrides: Partial<WateringEnginePlant> = {}): WateringEnginePlant {
  return {
    species_slug: 'monstera_deliciosa', // 7-day interval
    override_interval_days: null,
    ...overrides,
  };
}

describe('computeWateringStatus — null + boundary states', () => {
  it("returns 'check_soil' when lastWateredAt is null (just-added plant, no history)", () => {
    expect(
      computeWateringStatus({ plant: plant(), lastWateredAt: null, nowMs: 1_000_000_000_000 }),
    ).toBe('check_soil');
  });

  it("returns 'water' when elapsedMs strictly exceeds intervalMs", () => {
    // 8 days > 7-day interval
    expect(
      computeWateringStatus({
        plant: plant(),
        lastWateredAt: 1_000_000_000_000,
        nowMs: 1_000_000_000_000 + 8 * DAY_MS,
      }),
    ).toBe('water');
  });

  it("returns 'water' at the exact full-interval boundary (== interval → water)", () => {
    expect(
      computeWateringStatus({
        plant: plant(), // 7 days
        lastWateredAt: 1_000_000_000_000,
        nowMs: 1_000_000_000_000 + 7 * DAY_MS,
      }),
    ).toBe('water');
  });

  it("returns 'check_soil' at the exact half-interval boundary (== interval/2 → check_soil, NOT skip)", () => {
    expect(
      computeWateringStatus({
        plant: plant(), // 7 days → half = 3.5 days
        lastWateredAt: 1_000_000_000_000,
        nowMs: 1_000_000_000_000 + 3.5 * DAY_MS,
      }),
    ).toBe('check_soil');
  });

  it("returns 'skip' just below the half-interval boundary", () => {
    expect(
      computeWateringStatus({
        plant: plant(), // 7 days → half = 3.5 days
        lastWateredAt: 1_000_000_000_000,
        nowMs: 1_000_000_000_000 + 3.5 * DAY_MS - 1, // 1ms shy of half
      }),
    ).toBe('skip');
  });

  it("returns 'check_soil' just below the full-interval boundary", () => {
    expect(
      computeWateringStatus({
        plant: plant(),
        lastWateredAt: 1_000_000_000_000,
        nowMs: 1_000_000_000_000 + 7 * DAY_MS - 1, // 1ms shy of full
      }),
    ).toBe('check_soil');
  });

  it("returns 'check_soil' deep in the bias zone (5 days into a 7-day interval)", () => {
    expect(
      computeWateringStatus({
        plant: plant(),
        lastWateredAt: 1_000_000_000_000,
        nowMs: 1_000_000_000_000 + 5 * DAY_MS,
      }),
    ).toBe('check_soil');
  });

  it("returns 'skip' for a tiny elapsed time (1ms into a 1-day interval)", () => {
    expect(
      computeWateringStatus({
        plant: plant({ override_interval_days: 1 }),
        lastWateredAt: 1_000_000_000_000,
        nowMs: 1_000_000_000_000 + 1, // 1ms — far below half-day
      }),
    ).toBe('skip');
  });
});

describe('computeWateringStatus — species_unknown fallback', () => {
  it("returns 'check_soil' for species_unknown with no override, regardless of elapsed time", () => {
    // Even way past any reasonable interval — without a known species or
    // override, the engine refuses to claim 'water'.
    expect(
      computeWateringStatus({
        plant: { species_slug: 'species_unknown', override_interval_days: null },
        lastWateredAt: 1_000_000_000_000,
        nowMs: 1_000_000_000_000 + 30 * DAY_MS,
      }),
    ).toBe('check_soil');
  });

  it("returns 'water' for species_unknown WITH override_interval_days when elapsed > override", () => {
    // override unlocks the rules: species_unknown + override=10 → behaves
    // like a 10-day species.
    expect(
      computeWateringStatus({
        plant: { species_slug: 'species_unknown', override_interval_days: 10 },
        lastWateredAt: 1_000_000_000_000,
        nowMs: 1_000_000_000_000 + 11 * DAY_MS,
      }),
    ).toBe('water');
  });

  it("returns 'check_soil' for an unknown slug not in SPECIES_INTERVAL_DAYS, no override", () => {
    // Unknown to the lookup table (not 'species_unknown' literal, just
    // missing). Same fallback.
    expect(
      computeWateringStatus({
        plant: { species_slug: 'cactus_genericus', override_interval_days: null },
        lastWateredAt: 1_000_000_000_000,
        nowMs: 1_000_000_000_000 + 30 * DAY_MS,
      }),
    ).toBe('check_soil');
  });
});

describe('computeWateringStatus — override precedence', () => {
  it("override wins over species default (override=3 < species=10, elapsed 5 days → 'water')", () => {
    // Pothos default = 10 days. Override = 3 days. 5 days elapsed should
    // be 'water' (past the 3-day override) — proving override is the
    // source of truth, not a max with the species default.
    expect(
      computeWateringStatus({
        plant: { species_slug: 'pothos_aureum', override_interval_days: 3 },
        lastWateredAt: 1_000_000_000_000,
        nowMs: 1_000_000_000_000 + 5 * DAY_MS,
      }),
    ).toBe('water');
  });

  it("override wins over species default (override=20 > species=7, elapsed 8 days → 'check_soil')", () => {
    // Monstera default = 7 days; under that interval at 8 days elapsed
    // we'd see 'water'. Override = 20 days flips it: 8 days is 40% of 20,
    // which is below half-interval (50%), so 'skip' would be expected at
    // exactly that boundary. 8/20 = 0.4 < 0.5 → 'skip'.
    expect(
      computeWateringStatus({
        plant: { species_slug: 'monstera_deliciosa', override_interval_days: 20 },
        lastWateredAt: 1_000_000_000_000,
        nowMs: 1_000_000_000_000 + 8 * DAY_MS,
      }),
    ).toBe('skip');
  });

  it("override of 1 day, elapsed 12 hours → 'check_soil' (between half and full)", () => {
    expect(
      computeWateringStatus({
        plant: { species_slug: 'species_unknown', override_interval_days: 1 },
        lastWateredAt: 1_000_000_000_000,
        nowMs: 1_000_000_000_000 + 12 * 60 * 60 * 1000, // 12h, == half of 1 day
      }),
    ).toBe('check_soil');
  });
});

// ─── E6-005 v2: weather modifier (engine layer) ──────────────────────────

const mildWeather = (): WateringEngineWeather => ({
  daily: [
    { temperature_max_c: 20, precipitation_sum_mm: 0 },
    { temperature_max_c: 20, precipitation_sum_mm: 0 },
  ],
});

const stormy = (): WateringEngineWeather => ({
  daily: [
    { temperature_max_c: 32, precipitation_sum_mm: 4 },
    { temperature_max_c: 33, precipitation_sum_mm: 5 }, // sum 9mm > 5
  ],
});

describe('E6-005 — locked thresholds + cap constants', () => {
  it('exports the master-plan-locked thresholds', () => {
    // Locking these as exported constants prevents a future "let's tune
    // the threshold" change from quietly drifting away from the master
    // plan + ticket spec. A change here MUST be a documented unlock.
    expect(PRECIPITATION_THRESHOLD_MM).toBe(5);
    expect(HEAT_THRESHOLD_C).toBe(30);
    expect(MIN_INTERVAL_DAYS).toBe(1);
    expect(MAX_INTERVAL_DAYS).toBe(30);
  });
});

describe('E6-005 — applyWeatherModifier (pure function)', () => {
  it('no rain + no heat → returns base interval unchanged', () => {
    expect(applyWeatherModifier(7, mildWeather())).toBe(7);
  });

  it('cumulative precipitation > 5mm → +2 days', () => {
    const rainy: WateringEngineWeather = {
      daily: [
        { temperature_max_c: 20, precipitation_sum_mm: 4 },
        { temperature_max_c: 20, precipitation_sum_mm: 4 }, // 8mm > 5
      ],
    };
    expect(applyWeatherModifier(7, rainy)).toBe(9);
  });

  it('cumulative precipitation == 5mm exactly → NO modifier (strict >)', () => {
    const drizzle: WateringEngineWeather = {
      daily: [
        { temperature_max_c: 20, precipitation_sum_mm: 2.5 },
        { temperature_max_c: 20, precipitation_sum_mm: 2.5 }, // sum exactly 5
      ],
    };
    expect(applyWeatherModifier(7, drizzle)).toBe(7);
  });

  it('max temperature > 30°C → -1 day', () => {
    const hot: WateringEngineWeather = {
      daily: [
        { temperature_max_c: 31, precipitation_sum_mm: 0 },
        { temperature_max_c: 30, precipitation_sum_mm: 0 },
      ],
    };
    expect(applyWeatherModifier(7, hot)).toBe(6);
  });

  it('max temperature == 30°C exactly → NO modifier (strict >)', () => {
    const warm: WateringEngineWeather = {
      daily: [
        { temperature_max_c: 30, precipitation_sum_mm: 0 },
        { temperature_max_c: 30, precipitation_sum_mm: 0 },
      ],
    };
    expect(applyWeatherModifier(7, warm)).toBe(7);
  });

  it('rain AND heat → net +1 day (+2 from rain, -1 from heat)', () => {
    expect(applyWeatherModifier(7, stormy())).toBe(8);
  });

  it('cap floor: base 1 + heat (-1) → clamps to 1, not 0', () => {
    // Even though no V1 species is 1 day by default, the cap protects
    // against future tightening of species defaults or threshold tuning
    // that could otherwise yield 0 or negative.
    const hot: WateringEngineWeather = {
      daily: [
        { temperature_max_c: 31, precipitation_sum_mm: 0 },
        { temperature_max_c: 31, precipitation_sum_mm: 0 },
      ],
    };
    expect(applyWeatherModifier(1, hot)).toBe(1);
  });

  it('cap floor: base 2 + heat (-1) → 1 (just at the floor, not below)', () => {
    const hot: WateringEngineWeather = {
      daily: [
        { temperature_max_c: 35, precipitation_sum_mm: 0 },
        { temperature_max_c: 35, precipitation_sum_mm: 0 },
      ],
    };
    expect(applyWeatherModifier(2, hot)).toBe(1);
  });

  it('cap ceiling: base 30 + rain (+2) → clamps to 30, not 32', () => {
    // No V1 species is 30 days by default, but a future override-respecting
    // change or species table addition could push us into this band.
    const rainy: WateringEngineWeather = {
      daily: [
        { temperature_max_c: 20, precipitation_sum_mm: 4 },
        { temperature_max_c: 20, precipitation_sum_mm: 4 },
      ],
    };
    expect(applyWeatherModifier(30, rainy)).toBe(30);
  });

  it('cap ceiling: base 29 + rain (+2) → 30 (just at the ceiling, not above)', () => {
    const rainy: WateringEngineWeather = {
      daily: [
        { temperature_max_c: 20, precipitation_sum_mm: 5 },
        { temperature_max_c: 20, precipitation_sum_mm: 5 },
      ],
    };
    expect(applyWeatherModifier(29, rainy)).toBe(30);
  });

  it('cap ceiling: base 30 + rain + heat → +1 net → 30 (clamped from 31)', () => {
    expect(applyWeatherModifier(30, stormy())).toBe(30);
  });
});

describe('E6-005 — computeWateringStatus precedence (override > indoor > weather)', () => {
  // These drive the precedence at the integration layer (engine + plant
  // shape) rather than against `applyWeatherModifier` directly. Hook
  // tests cover the same precedence with the SQLite layer in front.

  it('override=14 + outdoor + storm → uses 14 unchanged (override beats weather)', () => {
    expect(
      computeWateringStatus({
        plant: {
          species_slug: 'monstera_deliciosa',
          override_interval_days: 14,
          is_indoor: false,
        },
        lastWateredAt: 1_000_000_000_000,
        nowMs: 1_000_000_000_000 + 13 * DAY_MS, // 13/14 = bias
        weather: stormy(),
      }),
    ).toBe('check_soil');
  });

  it('indoor=true + outdoor weather → uses species default (indoor beats weather)', () => {
    expect(
      computeWateringStatus({
        plant: {
          species_slug: 'monstera_deliciosa',
          override_interval_days: null,
          is_indoor: true,
        },
        lastWateredAt: 1_000_000_000_000,
        nowMs: 1_000_000_000_000 + 7 * DAY_MS, // exactly 7d → water
        weather: stormy(),
      }),
    ).toBe('water');
  });

  it('outdoor + weather + override null → applies modifier (the v2 path)', () => {
    expect(
      computeWateringStatus({
        plant: {
          species_slug: 'monstera_deliciosa',
          override_interval_days: null,
          is_indoor: false,
        },
        lastWateredAt: 1_000_000_000_000,
        // 7d elapsed / 8d modified interval = bias zone (+2 - 1 = +1).
        nowMs: 1_000_000_000_000 + 7 * DAY_MS,
        weather: stormy(),
      }),
    ).toBe('check_soil');
  });

  it('outdoor + null weather + override null → uses species default (graceful degrade)', () => {
    // Location denied / weather API failed → no modifier.
    expect(
      computeWateringStatus({
        plant: {
          species_slug: 'monstera_deliciosa',
          override_interval_days: null,
          is_indoor: false,
        },
        lastWateredAt: 1_000_000_000_000,
        nowMs: 1_000_000_000_000 + 7 * DAY_MS,
        weather: null,
      }),
    ).toBe('water');
  });

  it("plant without is_indoor field (v1 row) → defaults to indoor (no modifier)", () => {
    // Backwards compatibility: a v1 row that doesn't carry `is_indoor`
    // takes the indoor branch (the schema default and the safer
    // no-modifier path).
    expect(
      computeWateringStatus({
        plant: {
          species_slug: 'monstera_deliciosa',
          override_interval_days: null,
        },
        lastWateredAt: 1_000_000_000_000,
        nowMs: 1_000_000_000_000 + 7 * DAY_MS,
        weather: stormy(),
      }),
    ).toBe('water');
  });
});
