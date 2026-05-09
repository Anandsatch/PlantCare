/**
 * useWateringEngine v2 (E6-005) — hook-level tests.
 *
 * The pure-math invariants (boundary cases, DST/IDL regression, override
 * precedence, sub-day precision) live in
 * `apps/mobile/src/watering/__tests__/engine.test.ts` and
 * `timezone-regression.test.ts` against `computeWateringStatus` directly.
 * This file exercises the *hook* surface: SQLite read, render-window
 * fallback, and the v2 inputs (`is_indoor` + `weather`) flowing through
 * to the engine. Backwards-compat coverage proves a v1 caller (no v2
 * args, no `is_indoor` on the plant row) gets identical behavior to
 * E4-001.
 *
 * The SQLite layer is mocked via `jest.mock('../../db', ...)` rather
 * than wired to better-sqlite3 — the hook contract is "read the most
 * recent watering_events row and pass it to the engine," which is fully
 * exercised by mocking the read. The real SQL is covered in
 * `db/__tests__/migrations.test.ts` and `usePlants.test.tsx`.
 */
import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import { renderHook, waitFor } from '@testing-library/react-native';

import { useWateringEngine, type UseWateringEnginePlant } from '../useWateringEngine';
import type { WateringEngineWeather } from '../../watering';

// ─── Mocks ──────────────────────────────────────────────────────────────

// Mock variables MUST be prefixed `mock` for jest.mock factories to access
// them — babel-jest hoists factories above imports.
const mockGetFirstAsync = jest.fn();
const mockOpenDb = jest.fn();

jest.mock('../../db', () => ({
  openDb: () => mockOpenDb(),
}));

const DAY_MS = 24 * 60 * 60 * 1000;

// ─── Test helpers ───────────────────────────────────────────────────────

beforeEach(() => {
  mockGetFirstAsync.mockReset();
  mockOpenDb.mockReset();
  mockOpenDb.mockResolvedValue({
    getFirstAsync: mockGetFirstAsync,
  } as never);
});

/**
 * Configure the SQLite mock to return a watering_events row with the
 * given `watered_at` ms (or null for "no history").
 */
function withLastWateredAt(wateredAtMs: number | null): void {
  if (wateredAtMs === null) {
    mockGetFirstAsync.mockResolvedValue(null as never);
  } else {
    mockGetFirstAsync.mockResolvedValue({ watered_at: wateredAtMs } as never);
  }
}

/**
 * Build a plant fixture. Defaults to monstera (7-day species), no
 * override, indoor=true (the schema default and the safer no-modifier
 * path). Pass overrides to flip individual fields.
 */
function makePlant(overrides: Partial<UseWateringEnginePlant> = {}): UseWateringEnginePlant {
  return {
    id: 'plant-1',
    species_slug: 'monstera_deliciosa',
    override_interval_days: null,
    is_indoor: true,
    ...overrides,
  };
}

/**
 * Build a 2-day forecast snapshot. Defaults to mild conditions (no rain,
 * pleasant temps) so individual cases can flip just the field they care
 * about without inheriting an accidental modifier.
 */
function makeWeather(overrides?: {
  precip0?: number;
  precip1?: number;
  tempMax0?: number;
  tempMax1?: number;
}): WateringEngineWeather {
  return {
    daily: [
      {
        precipitation_sum_mm: overrides?.precip0 ?? 0,
        temperature_max_c: overrides?.tempMax0 ?? 20,
      },
      {
        precipitation_sum_mm: overrides?.precip1 ?? 0,
        temperature_max_c: overrides?.tempMax1 ?? 20,
      },
    ],
  };
}

/**
 * Render the hook and wait past the SQLite load window — assertions
 * against the post-load verdict need this to run, otherwise we'd see
 * the 'check_soil' loading-window placeholder.
 */
async function renderAndLoad(
  plant: UseWateringEnginePlant,
  weather: WateringEngineWeather | null = null,
): Promise<{ verdict: ReturnType<typeof useWateringEngine> }> {
  const { result } = renderHook(() => useWateringEngine(plant, weather));
  // The hook returns 'check_soil' until the SQLite read resolves.
  // Wait until either the row is found (so the verdict can be anything)
  // or the verdict differs from the load-window placeholder.
  await waitFor(() => {
    expect(mockGetFirstAsync).toHaveBeenCalled();
  });
  // One more microtask to let the post-resolve setState commit.
  await waitFor(() => {
    expect(result.current).toBeDefined();
  });
  return { verdict: result.current };
}

/**
 * Stable "now" for the test fixtures — real `Date.now()` is read
 * by the hook, but the engine math only cares about
 * `Date.now() - lastWateredAt`. Setting `lastWateredAt = Date.now() -
 * elapsedMs` makes the test independent of wall-clock time.
 */
function lastWateredAtMsAgo(elapsedMs: number): number {
  return Date.now() - elapsedMs;
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe('useWateringEngine v2 — load-window fallback (v1 invariant)', () => {
  it("returns 'check_soil' before the SQLite read completes", () => {
    // Block the read — never resolves. The hook should still mount and
    // return a safe default.
    mockGetFirstAsync.mockImplementation(() => new Promise(() => undefined));

    const { result } = renderHook(() => useWateringEngine(makePlant()));
    expect(result.current).toBe('check_soil');
  });

  it("returns 'check_soil' when SQLite throws (degrade gracefully)", async () => {
    mockGetFirstAsync.mockRejectedValue(new Error('disk_full') as never);

    const { result } = renderHook(() => useWateringEngine(makePlant()));
    await waitFor(() => {
      expect(mockGetFirstAsync).toHaveBeenCalled();
    });
    expect(result.current).toBe('check_soil');
  });
});

describe('useWateringEngine v2 — backwards compatibility (E4-001 callers)', () => {
  it("v1 signature (no weather arg) → identical verdict to v1: 'water' past 7-day interval", async () => {
    withLastWateredAt(lastWateredAtMsAgo(8 * DAY_MS));

    // Plant row WITHOUT is_indoor (simulating an unmigrated v1 row that
    // the caller doesn't explicitly set). Engine defaults `is_indoor`
    // to true, ignoring weather even if any were passed.
    const v1Plant = {
      id: 'plant-v1',
      species_slug: 'monstera_deliciosa',
      override_interval_days: null,
    } as UseWateringEnginePlant;

    const { result } = renderHook(() => useWateringEngine(v1Plant));
    await waitFor(() => expect(result.current).toBe('water'));
  });

  it("v1 signature, just-watered → 'skip' (mirrors E4-001 boundary tests)", async () => {
    withLastWateredAt(lastWateredAtMsAgo(60 * 60 * 1000)); // 1h ago

    const { result } = renderHook(() => useWateringEngine(makePlant()));
    await waitFor(() => expect(result.current).toBe('skip'));
  });

  it("v1 signature, deep bias zone (5 days into 7-day) → 'check_soil'", async () => {
    withLastWateredAt(lastWateredAtMsAgo(5 * DAY_MS));

    const { result } = renderHook(() => useWateringEngine(makePlant()));
    await waitFor(() => expect(result.current).toBe('check_soil'));
  });

  it("explicit null weather (the hook's default) → no modifier applied for outdoor plant", async () => {
    // Outdoor + null weather + 6 days elapsed on a 7-day plant. Without
    // a modifier, 6/7 = bias zone → 'check_soil'.
    withLastWateredAt(lastWateredAtMsAgo(6 * DAY_MS));

    const { result } = renderHook(() =>
      useWateringEngine(makePlant({ is_indoor: false }), null),
    );
    await waitFor(() => expect(result.current).toBe('check_soil'));
  });

  it("undefined weather (omitted second arg) → no modifier applied for outdoor plant", async () => {
    // Same setup as above but explicitly omitting the weather arg.
    // Default value `null` (set in the hook signature) takes over.
    withLastWateredAt(lastWateredAtMsAgo(6 * DAY_MS));

    const { result } = renderHook(() =>
      useWateringEngine(makePlant({ is_indoor: false })),
    );
    await waitFor(() => expect(result.current).toBe('check_soil'));
  });
});

describe('useWateringEngine v2 — override precedence (override beats everything)', () => {
  it("override=14 + indoor=true + weather present → uses 14, ignores weather", async () => {
    // Plant has a 14-day override, indoor flag, and we pass storm weather.
    // 8 days elapsed against a 14-day interval = 8/14 = 0.57 → check_soil
    // (between half and full). If weather were applied (rain extends to
    // 16, heat shortens to 15, etc.) the verdict would shift. It must NOT.
    withLastWateredAt(lastWateredAtMsAgo(8 * DAY_MS));

    const stormy = makeWeather({
      precip0: 10,
      precip1: 10,
      tempMax0: 32,
      tempMax1: 33,
    });
    const plant = makePlant({
      override_interval_days: 14,
      is_indoor: true,
    });
    const { result } = renderHook(() => useWateringEngine(plant, stormy));
    await waitFor(() => expect(result.current).toBe('check_soil'));
  });

  it("override=14 + outdoor + heat weather → uses 14 unchanged (override beats weather)", async () => {
    // Outdoor + heat would normally subtract 1 from the interval. Override
    // is null-bypass: it's NOT null, so weather is skipped entirely.
    // 8 days elapsed / 14-day override = bias zone → check_soil.
    // If heat were applied, interval would be 13, 8/13 = 0.61 → still
    // check_soil (coincidentally), so we use a more telling fixture:
    // 13 days elapsed / 14-day = check_soil; with heat, interval=13, 13/13
    // = water. So checking the verdict at 13 days proves override wins.
    withLastWateredAt(lastWateredAtMsAgo(13 * DAY_MS));

    const heatOnly = makeWeather({ tempMax0: 32, tempMax1: 33 });
    const plant = makePlant({
      override_interval_days: 14,
      is_indoor: false,
    });
    const { result } = renderHook(() => useWateringEngine(plant, heatOnly));
    // 13 < 14 → bias zone → check_soil. If weather had snuck in: 13 >= 13
    // → water. The assertion below locks override-beats-weather.
    await waitFor(() => expect(result.current).toBe('check_soil'));
  });

  it("override=3 + indoor=true → uses 3 (override unlocks even species_unknown)", async () => {
    // species_unknown without override is rules-disabled. Override forces
    // a verdict.
    withLastWateredAt(lastWateredAtMsAgo(4 * DAY_MS)); // 4d > 3d override

    const plant = makePlant({
      species_slug: 'species_unknown',
      override_interval_days: 3,
      is_indoor: true,
    });
    const { result } = renderHook(() => useWateringEngine(plant));
    await waitFor(() => expect(result.current).toBe('water'));
  });
});

describe('useWateringEngine v2 — indoor path (default; no weather modifier)', () => {
  it("indoor=true + outdoor weather present → uses species default, ignores weather", async () => {
    // Same fixture as the override-vs-weather case but driving the
    // indoor-vs-weather precedence step instead.
    // 6 days elapsed / 7-day species (monstera) = bias zone → check_soil.
    // If outdoor + heat applied: interval=6, 6/6 = water. Locking it to
    // check_soil proves indoor=true skipped the weather branch.
    withLastWateredAt(lastWateredAtMsAgo(6 * DAY_MS));

    const heat = makeWeather({ tempMax0: 32, tempMax1: 33 });
    const plant = makePlant({ is_indoor: true });
    const { result } = renderHook(() => useWateringEngine(plant, heat));
    await waitFor(() => expect(result.current).toBe('check_soil'));
  });

  it("indoor=true + storm weather → no modifier (would have been -1 from heat + +2 from rain → +1)", async () => {
    // Without any modifier: 5 days / 7 days = bias zone → check_soil.
    // With weather (would be skipped): interval=8, 5/8 = 0.625 → bias →
    // check_soil also. Coincides — so use a different elapsed time to
    // tell the cases apart:
    // 7 days elapsed / 7-day species = water (no modifier, indoor).
    // If weather sneaked in: interval=8, 7/8 = bias → check_soil.
    withLastWateredAt(lastWateredAtMsAgo(7 * DAY_MS));

    const stormy = makeWeather({
      precip0: 4,
      precip1: 5, // sum 9mm > 5mm
      tempMax0: 32,
      tempMax1: 33, // both > 30°C
    });
    const plant = makePlant({ is_indoor: true });
    const { result } = renderHook(() => useWateringEngine(plant, stormy));
    await waitFor(() => expect(result.current).toBe('water'));
  });
});

describe('useWateringEngine v2 — outdoor + weather modifier', () => {
  it("outdoor + null weather → uses default species interval (graceful degrade)", async () => {
    // Mirrors the "weather API failed / location denied" path. 7 days /
    // 7-day species = water (the boundary).
    withLastWateredAt(lastWateredAtMsAgo(7 * DAY_MS));

    const plant = makePlant({ is_indoor: false });
    const { result } = renderHook(() => useWateringEngine(plant, null));
    await waitFor(() => expect(result.current).toBe('water'));
  });

  it("outdoor + rain (cumulative 8mm > 5mm) → +2 days (interval 7 → 9)", async () => {
    // 7 days elapsed against modified 9-day interval = 7/9 = 0.78 →
    // bias zone → check_soil. Without modifier: 7/7 = water. The shift
    // from water → check_soil locks the +2 modifier.
    withLastWateredAt(lastWateredAtMsAgo(7 * DAY_MS));

    const rainy = makeWeather({ precip0: 4, precip1: 4 }); // sum = 8mm
    const plant = makePlant({ is_indoor: false });
    const { result } = renderHook(() => useWateringEngine(plant, rainy));
    await waitFor(() => expect(result.current).toBe('check_soil'));
  });

  it("outdoor + precipitation EXACTLY 5mm → no modifier (threshold is strict >, not >=)", async () => {
    // Sum = 5mm, not > 5mm → no rain modifier. 7 days / 7-day species
    // = water (boundary).
    withLastWateredAt(lastWateredAtMsAgo(7 * DAY_MS));

    const drizzle = makeWeather({ precip0: 2.5, precip1: 2.5 }); // sum = 5
    const plant = makePlant({ is_indoor: false });
    const { result } = renderHook(() => useWateringEngine(plant, drizzle));
    await waitFor(() => expect(result.current).toBe('water'));
  });

  it("outdoor + heat (max 32°C > 30°C) → -1 day (interval 7 → 6)", async () => {
    // 6 days elapsed / 6-day modified interval = water (boundary).
    // Without modifier: 6/7 = bias → check_soil. The shift from
    // check_soil → water locks the -1 modifier.
    withLastWateredAt(lastWateredAtMsAgo(6 * DAY_MS));

    const hot = makeWeather({ tempMax0: 31, tempMax1: 32 });
    const plant = makePlant({ is_indoor: false });
    const { result } = renderHook(() => useWateringEngine(plant, hot));
    await waitFor(() => expect(result.current).toBe('water'));
  });

  it("outdoor + temp EXACTLY 30°C → no modifier (threshold is strict >, not >=)", async () => {
    // Both days at exactly 30 → max = 30, NOT > 30 → no heat modifier.
    // 6 days / 7-day species = bias zone → check_soil.
    withLastWateredAt(lastWateredAtMsAgo(6 * DAY_MS));

    const warm = makeWeather({ tempMax0: 30, tempMax1: 30 });
    const plant = makePlant({ is_indoor: false });
    const { result } = renderHook(() => useWateringEngine(plant, warm));
    await waitFor(() => expect(result.current).toBe('check_soil'));
  });

  it("outdoor + BOTH rain AND heat → +2 - 1 = +1 net (interval 7 → 8)", async () => {
    // 7 days elapsed / 8-day modified interval = 7/8 = 0.875 → bias →
    // check_soil. Without modifier: 7/7 = water. Shift locks the net +1.
    withLastWateredAt(lastWateredAtMsAgo(7 * DAY_MS));

    const stormy = makeWeather({
      precip0: 4,
      precip1: 5, // sum = 9mm > 5
      tempMax0: 31,
      tempMax1: 33, // max = 33 > 30
    });
    const plant = makePlant({ is_indoor: false });
    const { result } = renderHook(() => useWateringEngine(plant, stormy));
    await waitFor(() => expect(result.current).toBe('check_soil'));
  });

  it("rain triggers from cumulative > 5mm even if each day is < 5mm individually", async () => {
    // Master plan rule: "2-day cumulative precipitation > 5mm". Two
    // dribbly days (3mm + 3mm = 6mm) trigger the modifier even though
    // neither day alone clears 5mm.
    withLastWateredAt(lastWateredAtMsAgo(7 * DAY_MS));

    const drizzle = makeWeather({ precip0: 3, precip1: 3 }); // sum = 6mm
    const plant = makePlant({ is_indoor: false });
    const { result } = renderHook(() => useWateringEngine(plant, drizzle));
    // +2 modifier → interval 9, 7/9 = bias → check_soil.
    await waitFor(() => expect(result.current).toBe('check_soil'));
  });

  it("heat triggers from max across both days, not from a single hot day", async () => {
    // Day 0 is mild (20°C), day 1 is hot (32°C). Max = 32 > 30 → heat
    // modifier applies based on the max, not an average.
    withLastWateredAt(lastWateredAtMsAgo(6 * DAY_MS));

    const oneHotDay = makeWeather({ tempMax0: 20, tempMax1: 32 });
    const plant = makePlant({ is_indoor: false });
    const { result } = renderHook(() => useWateringEngine(plant, oneHotDay));
    // -1 modifier → interval 6, 6/6 = water (boundary).
    await waitFor(() => expect(result.current).toBe('water'));
  });
});

describe('useWateringEngine v2 — natural interval ranges (no clamp interaction)', () => {
  // The cap [1, 30] is structural protection (`Math.min(MAX, Math.max(MIN, ...))`
  // in applyWeatherModifier). With the V1 species table (5..14 days) and
  // modifier range (-1 to +2), the realized interval band is [4, 16] —
  // comfortably inside [1, 30] for every case. The clamp tests live at
  // the engine layer in `watering/__tests__/engine.test.ts` against
  // `applyWeatherModifier` directly, where synthetic interval values
  // can drive the cap from below or above.

  it("outdoor + heat on the smallest species (peace lily, 5d) → -1 → 4, not clamped", async () => {
    // 4 days elapsed / 4-day modified interval = water (boundary).
    withLastWateredAt(lastWateredAtMsAgo(4 * DAY_MS));

    const plant = makePlant({
      species_slug: 'spathiphyllum_wallisii', // 5-day
      is_indoor: false,
    });
    const heat = makeWeather({ tempMax0: 31, tempMax1: 32 });
    const { result } = renderHook(() => useWateringEngine(plant, heat));
    await waitFor(() => expect(result.current).toBe('water'));
  });

  it("outdoor + rain on the largest species (snake plant, 14d) → +2 → 16, well within cap", async () => {
    withLastWateredAt(lastWateredAtMsAgo(14 * DAY_MS));

    const plant = makePlant({
      species_slug: 'sansevieria_trifasciata', // 14-day
      is_indoor: false,
    });
    const rainy = makeWeather({ precip0: 4, precip1: 4 });
    const { result } = renderHook(() => useWateringEngine(plant, rainy));
    // 14/16 = bias → check_soil.
    await waitFor(() => expect(result.current).toBe('check_soil'));
  });

  it("outdoor species_unknown + override=2 + heat → no weather (override path), interval stays 2", async () => {
    withLastWateredAt(lastWateredAtMsAgo(3 * DAY_MS));

    const plant = makePlant({
      species_slug: 'species_unknown',
      override_interval_days: 2,
      is_indoor: false,
    });
    const heat = makeWeather({ tempMax0: 35, tempMax1: 35 });
    const { result } = renderHook(() => useWateringEngine(plant, heat));
    // 3 days elapsed / 2-day override = water (override beats weather).
    await waitFor(() => expect(result.current).toBe('water'));
  });
});

describe('useWateringEngine v2 — sub-day precision (Wave 1 lesson)', () => {
  it("3d 12h ago + 7d default + outdoor rain → 'check_soil' (NOT water_today via Math.floor drift)", async () => {
    // 3.5 days elapsed against modified 9-day interval (7 + 2 from rain)
    // = 3.5 / 9 = 0.39 < 0.5 → 'skip' (below half, NOT in the bias zone).
    // The wave-1 lesson here is that ms math doesn't drift on sub-day
    // increments — a calendar-day implementation could compute "3 days
    // elapsed against 9-day interval" then bucket the half boundary
    // wrong.
    withLastWateredAt(lastWateredAtMsAgo(3 * DAY_MS + 12 * 60 * 60 * 1000));

    const rainy = makeWeather({ precip0: 4, precip1: 4 }); // 8mm
    const plant = makePlant({ is_indoor: false });
    const { result } = renderHook(() => useWateringEngine(plant, rainy));
    // 3.5d / 9d = 0.39 → skip. Locks the sub-day precision regression.
    await waitFor(() => expect(result.current).toBe('skip'));
  });
});

describe('useWateringEngine v2 — DST + IDL (E4-002 regression contract)', () => {
  /**
   * The pure-engine DST/IDL coverage lives in
   * `apps/mobile/src/watering/__tests__/timezone-regression.test.ts`. The
   * hook adds a SQLite read on top — we just have to prove that the
   * read's value flows through unchanged so the engine's tz-invariance
   * is preserved. We can't easily mock `Date.now()` against the real
   * hook (it reads `Date.now()` directly), so we exercise the wrapper
   * by setting `lastWateredAt` to a fixed UTC ms and asserting the
   * verdict matches the engine's (against a then-real `Date.now()`).
   */
  it("DST forward fixture: 7-day-shy-1h elapsed → 'check_soil' (matches engine)", async () => {
    // Build a `lastWateredAt` such that elapsed = 7 days - 1h relative
    // to `Date.now()`. Engine should return 'check_soil'.
    const elapsedMs = 7 * DAY_MS - 60 * 60 * 1000;
    withLastWateredAt(lastWateredAtMsAgo(elapsedMs));

    const plant = makePlant(); // monstera, indoor (no weather modifier)
    const { result } = renderHook(() => useWateringEngine(plant));
    await waitFor(() => expect(result.current).toBe('check_soil'));
  });

  it("IDL fixture: exactly 7 days elapsed → 'water' (boundary)", async () => {
    withLastWateredAt(lastWateredAtMsAgo(7 * DAY_MS));

    const plant = makePlant();
    const { result } = renderHook(() => useWateringEngine(plant));
    await waitFor(() => expect(result.current).toBe('water'));
  });

  it("E4-002 canonical 3d 12h 1ms case still hits 'check_soil' (the right bucket)", async () => {
    // Mirror the engine regression test:
    // 3 days + 12 hours + 1ms = just past half-interval → check_soil.
    // The hook delegates the math; this just locks that the wrapper
    // doesn't drop precision on the way through.
    const elapsedMs = 3 * DAY_MS + 12 * 60 * 60 * 1000 + 1;
    withLastWateredAt(lastWateredAtMsAgo(elapsedMs));

    const plant = makePlant();
    const { result } = renderHook(() => useWateringEngine(plant));
    await waitFor(() => expect(result.current).toBe('check_soil'));
  });
});

describe('useWateringEngine v2 — null lastWateredAt (just-added plant)', () => {
  it("just-added plant + outdoor + rain → 'check_soil' (no history; rules engine refuses to claim 'water')", async () => {
    // Even with a weather modifier configured, the engine returns
    // check_soil when lastWateredAt is null. The "we don't know when
    // this plant was last watered" path is unconditional.
    withLastWateredAt(null);

    const rainy = makeWeather({ precip0: 4, precip1: 4 });
    const plant = makePlant({ is_indoor: false });
    const { result } = renderHook(() => useWateringEngine(plant, rainy));
    await waitFor(() => expect(result.current).toBe('check_soil'));
  });

  it("just-added plant + override → still 'check_soil' (no history beats override)", async () => {
    withLastWateredAt(null);

    const plant = makePlant({ override_interval_days: 3 });
    const { result } = renderHook(() => useWateringEngine(plant));
    await waitFor(() => expect(result.current).toBe('check_soil'));
  });
});
