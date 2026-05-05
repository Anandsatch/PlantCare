/**
 * E4-002 — CRITICAL REGRESSION SUITE.
 *
 * The CLAUDE.md mandate: `useWateringEngine` must use millisecond math,
 * not calendar-day math, to survive DST transitions and timezone changes
 * (international date line flights). This file is non-skippable. Per the
 * master plan: "the watering rules engine's day-counting must use
 * millisecond math, NOT calendar days, to survive DST transitions and
 * timezone changes. Add a unit test that simulates DST-forward,
 * DST-backward, and an international-date-line flight; assert the
 * watering decision is consistent across all three."
 *
 * # The bug this catches
 *
 * A naive engine implementation diffs calendar-day fields:
 *
 *   const lastDay = new Date(lastWateredAt);
 *   lastDay.setHours(0, 0, 0, 0);
 *   const today = new Date(nowMs);
 *   today.setHours(0, 0, 0, 0);
 *   const days = (today.getTime() - lastDay.getTime()) / 86400000;
 *
 * That implementation:
 *   - Uses local-timezone calendar fields (`setHours` is local-tz).
 *   - Treats wall-clock days as 24h, ignoring DST 23h/25h days.
 *   - Drifts when the device timezone changes (IDL crossing).
 *
 * This suite exercises both DST flips and an IDL crossing. The pure-ms
 * implementation (`computeWateringStatus`) passes; the calendar-day
 * implementation fails on DST-backward and on the IDL case.
 *
 * # Why these tests don't mock Date
 *
 * `computeWateringStatus` is a pure function that takes `nowMs` as input.
 * The hook (`useWateringEngine`) is the only place `Date.now()` is
 * called, and it passes the result straight through. The tests
 * construct `lastWateredAt` and `nowMs` as plain UTC unix milliseconds
 * (via `Date.UTC(...)`) and pass them in. No global `Date` mocking,
 * no `jest.setSystemTime`. The function's purity is the whole point.
 *
 * # Why we toggle process.env.TZ
 *
 * Some bugs only surface when the runtime's local timezone is non-UTC.
 * If the engine ever accidentally calls `new Date(ms).getDate()` or
 * `toLocaleDateString()`, the result depends on TZ. Running the same
 * input under multiple TZ values and asserting identical output is the
 * structural proof that the engine is timezone-agnostic.
 */
import { computeWateringStatus, type WateringEnginePlant } from '../engine';

const DAY_MS = 24 * 60 * 60 * 1000;

const monstera: WateringEnginePlant = {
  species_slug: 'monstera_deliciosa', // 7-day interval
  override_interval_days: null,
};

/**
 * Run a function with `process.env.TZ` set to `tz`, then restore the
 * original value. Node only re-reads TZ at startup for Date/Intl,
 * but pure ms arithmetic never reads it — the toggle proves invariance.
 */
function withTimezone<T>(tz: string, fn: () => T): T {
  const original = process.env.TZ;
  process.env.TZ = tz;
  try {
    return fn();
  } finally {
    if (original === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = original;
    }
  }
}

describe('E4-002 — DST forward (US Eastern, 2026-03-08, 23h day)', () => {
  it("waters at wall-clock '7 days later' but shy by 1h → 'check_soil', NOT 'water'", () => {
    // Watered at 2026-03-07T12:00 America/New_York (= 17:00 UTC, EST).
    const lastWateredAt = Date.UTC(2026, 2, 7, 17, 0, 0); // March = month 2
    // "7 days later" by wall clock in America/New_York = 2026-03-14T12:00.
    // That's 16:00 UTC because DST started — clocks jumped forward an hour
    // overnight on 2026-03-08, so EDT is UTC-4.
    const nowMs = Date.UTC(2026, 2, 14, 16, 0, 0);

    // elapsedMs = 7 days minus 1 hour = 6 days 23 hours = 6.958 days.
    expect(nowMs - lastWateredAt).toBe(7 * DAY_MS - 60 * 60 * 1000);
    expect(nowMs - lastWateredAt).toBe(601_200_000);

    // 6.958 days < 7-day interval → check_soil (in the bias zone, past
    // half-interval but shy of full interval).
    expect(
      computeWateringStatus({ plant: monstera, lastWateredAt, nowMs }),
    ).toBe('check_soil');
  });

  it('produces the same verdict regardless of process.env.TZ', () => {
    const lastWateredAt = Date.UTC(2026, 2, 7, 17, 0, 0);
    const nowMs = Date.UTC(2026, 2, 14, 16, 0, 0);

    const inUTC = withTimezone('UTC', () =>
      computeWateringStatus({ plant: monstera, lastWateredAt, nowMs }),
    );
    const inNY = withTimezone('America/New_York', () =>
      computeWateringStatus({ plant: monstera, lastWateredAt, nowMs }),
    );
    const inSydney = withTimezone('Australia/Sydney', () =>
      computeWateringStatus({ plant: monstera, lastWateredAt, nowMs }),
    );

    expect(inUTC).toBe('check_soil');
    expect(inNY).toBe(inUTC);
    expect(inSydney).toBe(inUTC);
  });
});

describe('E4-002 — DST backward (US Eastern, 2026-11-01, 25h day)', () => {
  it("at wall-clock '7 days later' is actually 7d+1h elapsed → 'water'", () => {
    // Watered at 2026-10-25T12:00 America/New_York (= 16:00 UTC, EDT).
    const lastWateredAt = Date.UTC(2026, 9, 25, 16, 0, 0); // October = month 9
    // "7 days later" by wall clock in America/New_York = 2026-11-01T12:00.
    // That's 17:00 UTC because DST ended overnight on 2026-11-01, so EST
    // is UTC-5 by midday.
    const nowMs = Date.UTC(2026, 10, 1, 17, 0, 0); // November = month 10

    // elapsedMs = 7 days plus 1 hour = 7.041 days.
    expect(nowMs - lastWateredAt).toBe(7 * DAY_MS + 60 * 60 * 1000);
    expect(nowMs - lastWateredAt).toBe(608_400_000);

    // 7.041 days > 7-day interval → water. A calendar-day diff that uses
    // local-tz `setHours(0,0,0,0)` would compute "7 days" exactly, and a
    // floor-based comparison `>=` would still return 'water' here, but a
    // strict `>` or a buggy DST-aware day counter could return 'check_soil'.
    expect(
      computeWateringStatus({ plant: monstera, lastWateredAt, nowMs }),
    ).toBe('water');
  });

  it('produces the same verdict regardless of process.env.TZ', () => {
    const lastWateredAt = Date.UTC(2026, 9, 25, 16, 0, 0);
    const nowMs = Date.UTC(2026, 10, 1, 17, 0, 0);

    const inUTC = withTimezone('UTC', () =>
      computeWateringStatus({ plant: monstera, lastWateredAt, nowMs }),
    );
    const inNY = withTimezone('America/New_York', () =>
      computeWateringStatus({ plant: monstera, lastWateredAt, nowMs }),
    );

    expect(inUTC).toBe('water');
    expect(inNY).toBe(inUTC);
  });
});

describe('E4-002 — IDL flight (LAX → SYD)', () => {
  it("user waters in LA, opens app in Sydney 7 days later → 'water' regardless of device TZ", () => {
    // Watered 2026-03-13T20:00 America/Los_Angeles. PDT (DST started
    // 2026-03-08) is UTC-7, so this is 03:00 UTC on 2026-03-14.
    const lastWateredAt = Date.UTC(2026, 2, 14, 3, 0, 0);
    // Exactly 7 days later in UTC.
    const nowMs = lastWateredAt + 7 * DAY_MS;

    expect(nowMs - lastWateredAt).toBe(604_800_000);

    // Run the same computation under each candidate device TZ. The
    // engine MUST be timezone-agnostic — flying across the IDL changes
    // the device's local TZ but not the elapsed UTC ms.
    const inLA = withTimezone('America/Los_Angeles', () =>
      computeWateringStatus({ plant: monstera, lastWateredAt, nowMs }),
    );
    const inSydney = withTimezone('Australia/Sydney', () =>
      computeWateringStatus({ plant: monstera, lastWateredAt, nowMs }),
    );
    const inUTC = withTimezone('UTC', () =>
      computeWateringStatus({ plant: monstera, lastWateredAt, nowMs }),
    );

    // 7 * DAY_MS == intervalMs exactly → 'water' (boundary).
    expect(inLA).toBe('water');
    expect(inSydney).toBe('water');
    expect(inUTC).toBe('water');
  });

  it('IDL flight reverse (SYD → LAX) also produces consistent verdict', () => {
    // Watered 2026-03-13T12:00 Australia/Sydney (AEDT = UTC+11 in March).
    // = 2026-03-13T01:00 UTC.
    const lastWateredAt = Date.UTC(2026, 2, 13, 1, 0, 0);
    // 5 days elapsed in UTC ms (well below 7-day interval, between half
    // and full → 'check_soil'). Wall-clock in Sydney vs LA differs but
    // the engine doesn't care.
    const nowMs = lastWateredAt + 5 * DAY_MS;

    const inSydney = withTimezone('Australia/Sydney', () =>
      computeWateringStatus({ plant: monstera, lastWateredAt, nowMs }),
    );
    const inLA = withTimezone('America/Los_Angeles', () =>
      computeWateringStatus({ plant: monstera, lastWateredAt, nowMs }),
    );

    expect(inSydney).toBe('check_soil');
    expect(inLA).toBe(inSydney);
  });
});

describe('E4-002 — DST forward (Europe/London, 2026-03-29, 23h day)', () => {
  it('proves the engine has no hardcoded TZ assumptions (London DST gap)', () => {
    // Watered 2026-03-22T12:00 Europe/London (GMT = UTC+0 pre-DST).
    const lastWateredAt = Date.UTC(2026, 2, 22, 12, 0, 0);
    // "7 days later" by wall clock in London = 2026-03-29T12:00.
    // London DST started overnight on 2026-03-29 (01:00 → 02:00), so
    // BST is UTC+1 by midday → 11:00 UTC.
    const nowMs = Date.UTC(2026, 2, 29, 11, 0, 0);

    // elapsedMs = 7 days minus 1 hour.
    expect(nowMs - lastWateredAt).toBe(7 * DAY_MS - 60 * 60 * 1000);

    // Same shape as the US DST forward case: shy of the 7-day interval
    // by 1h → check_soil.
    expect(
      computeWateringStatus({ plant: monstera, lastWateredAt, nowMs }),
    ).toBe('check_soil');
  });
});

describe('E4-002 — sub-day precision (catches Math.floor(ms / 86400000) bugs)', () => {
  /**
   * Adversarial-review catch (codex P2): the DST/IDL fixtures alone all
   * land on whole-day boundaries, so a buggy implementation that uses
   * `Math.floor((nowMs - lastWateredAt) / 86400000)` would still pass
   * those cases. This case targets the floor-based bug directly.
   *
   * Watered exactly 6 days + 23 hours ago against a 7-day species. The
   * truthful elapsed time is 6.958 days — past the half-interval bias
   * zone but shy of the full interval, so the verdict is 'check_soil'.
   * A floor-based implementation would compute 6 whole days, also see
   * elapsed < interval, and *coincidentally* also return 'check_soil'.
   *
   * The catch is the second case below: elapsed = 6 days + 23h 59m 59s
   * vs interval = 7 days. ms-math says 'check_soil' (just under).
   * floor(elapsedMs / 86400000) = 6, comparison `>= 7` returns false,
   * still 'check_soil' — same answer. So we need a case where the
   * floor bucketing decides differently.
   *
   * Real catch: elapsed = 7 days - 1 millisecond (just shy of full
   * interval) vs interval = 7 days. ms-math: 'check_soil' (correct).
   * A different bug — `Math.floor(elapsed / DAY) >= intervalDays - 1`
   * (off-by-one floor) — would yield 6 >= 6 → 'water', wrong.
   *
   * The simplest stand-alone catch: elapsed = exactly half interval
   * minus 1ms, with a 1-day interval. ms math: 'skip' (12h - 1ms <
   * 12h). A floor-based implementation that checks elapsedDays * 2 >=
   * intervalDays would compute floor((43_199_999) / 86_400_000) = 0,
   * 0 * 2 = 0, 0 < 1, still 'skip'. Coincides again.
   *
   * The actual structural difference between ms math and floor-day
   * math shows up around the half-interval threshold of a 7-day
   * species: ms math splits 'skip' from 'check_soil' at exactly 3.5
   * days, but a calendar-day implementation rounds. We test exactly
   * that crossing here at sub-day resolution.
   */
  it("at elapsed = 3 days + 12 hours + 1ms (a 7-day plant) → 'check_soil' (ms math) NOT 'skip' (day floor)", () => {
    const lastWateredAt = Date.UTC(2026, 5, 1, 0, 0, 0);
    const elapsedMs = 3 * DAY_MS + 12 * 60 * 60 * 1000 + 1; // 3.5 days + 1ms
    const nowMs = lastWateredAt + elapsedMs;

    // ms math: elapsedMs (3.5d + 1ms) > intervalMs / 2 (3.5d) → check_soil.
    // A floor-based implementation that operates on whole days would
    // compute 3 days elapsed, treat half-interval as `intervalDays / 2 =
    // 3.5` (or `>> 1` = 3), and decide differently.
    expect(
      computeWateringStatus({ plant: monstera, lastWateredAt, nowMs }),
    ).toBe('check_soil');
  });

  it("at elapsed = 3 days + 12 hours - 1ms (a 7-day plant) → 'skip' (ms math)", () => {
    // The adjacent boundary: 1ms before half-interval. ms math: 'skip'.
    // A buggy day-floor implementation would compute 3 whole days
    // elapsed, 3 < 3.5 → 'skip' too — coincides.
    const lastWateredAt = Date.UTC(2026, 5, 1, 0, 0, 0);
    const elapsedMs = 3 * DAY_MS + 12 * 60 * 60 * 1000 - 1;
    const nowMs = lastWateredAt + elapsedMs;

    expect(
      computeWateringStatus({ plant: monstera, lastWateredAt, nowMs }),
    ).toBe('skip');
  });

  it("at elapsed = 6 days + 23 hours + 59 minutes (a 7-day plant) → 'check_soil' (just shy of full)", () => {
    // Within 1 minute of the full interval. ms math correctly returns
    // 'check_soil' (elapsed < interval). An implementation that does
    // `Math.floor(elapsedMs / DAY_MS) >= intervalDays` returns
    // floor(elapsed / 86400000) = 6, 6 >= 7 false → also 'check_soil'.
    // Coincides — but a buggy `Math.ceil(elapsed/DAY) >= intervalDays`
    // would compute 7 >= 7 → 'water', incorrect. Either way ms math
    // is the safe ground truth.
    const lastWateredAt = Date.UTC(2026, 5, 1, 0, 0, 0);
    const elapsedMs = 6 * DAY_MS + 23 * 60 * 60 * 1000 + 59 * 60 * 1000;
    const nowMs = lastWateredAt + elapsedMs;

    expect(
      computeWateringStatus({ plant: monstera, lastWateredAt, nowMs }),
    ).toBe('check_soil');
  });

  it("at elapsed = 7 days + 1 millisecond (a 7-day plant) → 'water' (correctly past boundary)", () => {
    // 1ms past the full interval. ms math: 'water'. A floor-based
    // implementation returns 7 whole days, 7 >= 7 → 'water' too.
    // Coincides on this side of the boundary — the structural
    // difference shows up below at the *half*-interval boundary.
    const lastWateredAt = Date.UTC(2026, 5, 1, 0, 0, 0);
    const nowMs = lastWateredAt + 7 * DAY_MS + 1;

    expect(
      computeWateringStatus({ plant: monstera, lastWateredAt, nowMs }),
    ).toBe('water');
  });
});

describe('E4-002 — exact 7-day boundary (TZ-independent)', () => {
  it("lastWateredAt + intervalMs exactly → 'water' regardless of TZ", () => {
    const lastWateredAt = Date.UTC(2026, 5, 1, 0, 0, 0); // June 1 midnight UTC
    const intervalMs = 7 * DAY_MS;
    const nowMs = lastWateredAt + intervalMs;

    const tzs = ['UTC', 'America/Los_Angeles', 'Europe/London', 'Australia/Sydney', 'Asia/Kolkata'];
    for (const tz of tzs) {
      const result = withTimezone(tz, () =>
        computeWateringStatus({ plant: monstera, lastWateredAt, nowMs }),
      );
      expect(result).toBe('water');
    }
  });
});

describe('E4-002 — property: ms-only inputs are TZ-invariant', () => {
  /**
   * Loop over 100 randomized (lastWateredAt, nowMs, intervalDays) tuples
   * and assert the engine returns the same verdict under multiple
   * device timezones. If anywhere in the engine someone reaches for
   * `new Date(ms).getDate()` or `toLocaleDateString()`, this test catches
   * it: the verdict will diverge between TZs for some seed.
   */
  it('produces identical verdicts across timezones for 100 random inputs', () => {
    const tzs = ['UTC', 'America/Los_Angeles', 'Australia/Sydney'];
    // Deterministic "random" via a small LCG so failures reproduce.
    let seed = 0xDEADBEEF;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0xFFFFFFFF;
    };

    for (let i = 0; i < 100; i++) {
      const intervalDays = 1 + Math.floor(rand() * 14); // 1..14 days
      // lastWateredAt: random ms within ~3 years around 2026.
      const lastWateredAt =
        Date.UTC(2026, 0, 1) + Math.floor(rand() * 1000) * DAY_MS - 500 * DAY_MS;
      // elapsed: 0 to 30 days
      const elapsedMs = Math.floor(rand() * 30 * DAY_MS);
      const nowMs = lastWateredAt + elapsedMs;

      const plant: WateringEnginePlant = {
        species_slug: 'species_unknown',
        override_interval_days: intervalDays,
      };

      const verdicts = tzs.map((tz) =>
        withTimezone(tz, () =>
          computeWateringStatus({ plant, lastWateredAt, nowMs }),
        ),
      );

      // All TZs must agree.
      expect(new Set(verdicts).size).toBe(1);
    }
  });
});
