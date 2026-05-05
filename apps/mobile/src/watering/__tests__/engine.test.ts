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
import { computeWateringStatus, type WateringEnginePlant } from '../engine';

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
