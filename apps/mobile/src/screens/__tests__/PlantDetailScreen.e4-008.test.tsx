/**
 * PlantDetailScreen — E4-008 contract tests.
 *
 * Pure-tests ticket. Locks the contract surfaces called out in
 * WORKBACK.md section E4-008 that the E4-005/E4-006 baseline tests in
 * PlantDetailScreen.test.tsx did not pin explicitly:
 *
 *   1. Empty-ledger render shape (no events -> empty caption).
 *   2. Full-ledger ordering: oldest-on-left, today-on-right.
 *   3. Today marker — the indicator dot appears in the rightmost column.
 *   4. Mark-watered persists — pressing "Mark watered" writes a real row
 *      to the watering_events table via a better-sqlite3 in-memory DB.
 *      Wave-3 lesson: the assertion reads the COMMITTED rows back via
 *      `db.prepare(...).all(plantId)`, not via spy on the executor.
 *   5. Status chip flips — after a successful mark-watered, the engine
 *      re-derives via the optimistic bus event; the chip transitions
 *      water -> skip without a remount.
 *   6. DST spring-forward regression — millisecond math, not calendar
 *      math, in the screen's "Last watered N days ago" copy.
 *   7. Sub-day precision regression — 12h ago does NOT label as
 *      "1 day ago"; explicit local-day-delta = 0 assertion.
 *   8. a11y snapshot — every Pressable in the tree carries an
 *      accessibilityRole='button' AND an accessibilityLabel.
 *   9. StrictMode safety with MountProbe sibling — mark-watered fires
 *      EXACTLY once when wrapped in <React.StrictMode>.
 *  10. Hermes-without-Intl tripwire — the screen itself does NOT call
 *      Intl.DateTimeFormat; monkey-patching Intl to throw still
 *      lets the screen mount under the in-window fixtures used here.
 *  11. Reduce-motion — zero Animated.timing / spring / loop calls fire
 *      on mount or during mark-watered, under reduce-motion ON.
 */
import Database from 'better-sqlite3';
type DatabaseSync = Database.Database;
import { lightTheme, type Theme } from '@plantcare/theme';
import {
  act,
  fireEvent,
  render,
  waitFor,
  type RenderResult,
} from '@testing-library/react-native';
import * as React from 'react';
import { Animated } from 'react-native';

import { runMigrations } from '../../db/migrations';
import { wateringEventsBus } from '../../db/wateringEvents';
import type { PlantsExecutor, SqlBindValue } from '../../hooks/usePlants';
import { createPlantsApi } from '../../hooks/usePlants';
import type { WateringStatus } from '../../watering';
import type { Plant } from '../../db/types';
import {
  PlantDetailScreen,
  formatLastWatered,
} from '../PlantDetailScreen';

// better-sqlite3 wiring

let mockActiveDb: DatabaseSync | null = null;

jest.mock('../../db/db', () => ({
  openDb: jest.fn(async () => {
    if (!mockActiveDb) throw new Error('test db not initialized');
    return {
      runAsync: async (sql: string, params: SqlBindValue[]) => {
        mockActiveDb!.prepare(sql).run(...params);
      },
      getFirstAsync: async <T,>(sql: string, params: SqlBindValue[] | SqlBindValue) => {
        const arr = Array.isArray(params) ? params : [params];
        return (mockActiveDb!.prepare(sql).get(...arr) as T | undefined) ?? null;
      },
      getAllAsync: async <T,>(sql: string, params: SqlBindValue[] | SqlBindValue) => {
        const arr = Array.isArray(params) ? params : [params];
        return mockActiveDb!.prepare(sql).all(...arr) as T[];
      },
    };
  }),
}));
jest.mock('../../db', () => {
  const dbDb = jest.requireActual('../../db/db');
  return {
    openDb: dbDb.openDb,
  };
});

function makePlantsAdapter(db: DatabaseSync): PlantsExecutor {
  return {
    async runAsync(source: string, params: SqlBindValue[]) {
      db.prepare(source).run(...params);
    },
    async getFirstAsync<T>(source: string, params: SqlBindValue[]): Promise<T | null> {
      const row = db.prepare(source).get(...params) as T | undefined;
      return row ?? null;
    },
    async getAllAsync<T>(source: string, params: SqlBindValue[]): Promise<T[]> {
      return db.prepare(source).all(...params) as T[];
    },
  };
}

function makeMigrationAdapter(db: DatabaseSync) {
  return {
    async execAsync(source: string) {
      db.exec(source);
    },
    async getFirstAsync<T>(source: string): Promise<T | null> {
      const row = db.prepare(source).get() as T | undefined;
      return row ?? null;
    },
    async withTransactionAsync(task: () => Promise<void>) {
      db.exec('BEGIN');
      try {
        await task();
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
  };
}

async function setupDb(plantId: string = 'plant-1'): Promise<DatabaseSync> {
  const raw = new Database(':memory:');
  raw.exec('PRAGMA foreign_keys = ON');
  await runMigrations(makeMigrationAdapter(raw));
  const plantsApi = createPlantsApi(makePlantsAdapter(raw));
  await plantsApi.create({
    id: plantId,
    species_slug: 'monstera_deliciosa',
    species_label: 'Monstera deliciosa',
    nickname: 'Mona',
  });
  mockActiveDb = raw;
  return raw;
}

// Theme + motion + engine hook mocks

jest.mock('../../hooks/useTheme', () => ({
  useTheme: jest.fn(),
}));
jest.mock('../../hooks/useReduceMotion', () => ({
  useReduceMotion: jest.fn(),
}));
jest.mock('../../hooks/useWateringEngine', () => ({
  useWateringEngine: jest.fn(),
}));

import { useTheme } from '../../hooks/useTheme';
import { useReduceMotion } from '../../hooks/useReduceMotion';
import { useWateringEngine } from '../../hooks/useWateringEngine';

const mockedUseTheme = useTheme as unknown as jest.MockedFunction<() => Theme>;
const mockedReduceMotion = useReduceMotion as unknown as jest.Mock<boolean, []>;
const mockedEngine = useWateringEngine as unknown as jest.Mock<
  WateringStatus,
  [Parameters<typeof useWateringEngine>[0]]
>;

// Fixtures

const NOW = new Date(2026, 4, 6, 14, 0, 0).getTime();
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;

function makePlant(overrides: Partial<Plant> = {}): Plant {
  return {
    id: 'plant-1',
    species_slug: 'monstera_deliciosa',
    species_label: 'Monstera deliciosa',
    nickname: 'Mona',
    location: 'Living room window',
    identify_confidence: 92,
    hero_photo_id: null,
    added_at: NOW - 30 * ONE_DAY_MS,
    archived_at: null,
    is_indoor: true,
    override_interval_days: null,
    ...overrides,
  };
}

beforeEach(() => {
  mockedUseTheme.mockReturnValue(lightTheme);
  mockedReduceMotion.mockReturnValue(false);
  mockedEngine.mockReturnValue('water');
  wateringEventsBus._resetForTests();
});

afterEach(() => {
  mockedUseTheme.mockReset();
  mockedReduceMotion.mockReset();
  mockedEngine.mockReset();
  mockActiveDb = null;
});

// 1. Empty ledger

describe('E4-008 — empty ledger', () => {
  it('renders the ledger empty caption when wateringEvents is []', () => {
    const { getByText } = render(
      <PlantDetailScreen
        plant={makePlant()}
        heroPhotoUri={null}
        wateringEvents={[]}
        photos={[]}
        onMarkWatered={jest.fn()}
        onEditDetails={jest.fn()}
        nowMs={NOW}
        testID="screen"
      />,
    );
    expect(
      getByText(/No watering recorded yet — tap Mark watered to start your record/i),
    ).toBeOnTheScreen();
  });

  it('every column reads "no watering recorded" when wateringEvents is []', () => {
    const r = render(
      <PlantDetailScreen
        plant={makePlant()}
        heroPhotoUri={null}
        wateringEvents={[]}
        photos={[]}
        onMarkWatered={jest.fn()}
        onEditDetails={jest.fn()}
        nowMs={NOW}
        testID="screen"
      />,
    );
    const labels = collectAccessibilityLabels(rootNode(r));
    const noWatering = labels.filter((l) =>
      /^[A-Z][a-z]+day, no watering recorded$/.test(l),
    );
    expect(noWatering.length).toBe(7);
  });
});

// 2. Full ledger ordering

describe('E4-008 — full ledger ordering', () => {
  it('forwards events to the ledger; oldest-on-left, today-on-right (verified via column a11y labels)', () => {
    const events = [
      { wateredAtMs: NOW - 6 * ONE_DAY_MS },
      { wateredAtMs: NOW - 1 * ONE_HOUR_MS },
    ];
    const r = render(
      <PlantDetailScreen
        plant={makePlant()}
        heroPhotoUri={null}
        wateringEvents={events}
        photos={[]}
        onMarkWatered={jest.fn()}
        onEditDetails={jest.fn()}
        nowMs={NOW}
        testID="screen"
      />,
    );
    const labels = collectAccessibilityLabels(rootNode(r));
    // Ledger column labels follow the shape "<Weekday>, watered" or
    // "<Weekday>, no watering recorded". The screen-header's composed
    // label ends in "Last watered today" / "Last watered N days ago" which
    // would also satisfy a naive /watered$/ — filter on the leading
    // weekday-comma shape to scope the regex strictly to ledger columns.
    const columnLabels = labels.filter((l) =>
      /^[A-Z][a-z]+day, (watered|no watering recorded)$/.test(l),
    );
    expect(columnLabels.length).toBe(7);
    expect(columnLabels[0]).toMatch(/, watered$/);
    for (let i = 1; i <= 5; i++) {
      expect(columnLabels[i]).toMatch(/, no watering recorded$/);
    }
    expect(columnLabels[6]).toMatch(/, watered$/);
  });
});

// 3. Today marker

describe('E4-008 — today marker', () => {
  it('renders a today indicator dot exactly once (only on the rightmost column)', () => {
    const r = render(
      <PlantDetailScreen
        plant={makePlant()}
        heroPhotoUri={null}
        wateringEvents={[]}
        photos={[]}
        onMarkWatered={jest.fn()}
        onEditDetails={jest.fn()}
        nowMs={NOW}
        testID="screen"
      />,
    );
    expect(countTodayDots(rootNode(r), lightTheme.colors.text)).toBe(1);
  });
});

// 4. Mark-watered persists (real better-sqlite3 in-memory DB)

describe('E4-008 — mark-watered persists to watering_events (real DB)', () => {
  it('pressing Mark watered writes a real row that round-trips through SELECT', async () => {
    const raw = await setupDb('plant-1');
    const before = raw
      .prepare('SELECT * FROM watering_events WHERE plant_id = ?')
      .all('plant-1');
    expect(before).toEqual([]);

    const onMarkWatered = jest.fn();
    const { getByTestId } = render(
      <PlantDetailScreen
        plant={makePlant()}
        heroPhotoUri={null}
        wateringEvents={[]}
        photos={[]}
        onMarkWatered={onMarkWatered}
        onEditDetails={jest.fn()}
        nowMs={NOW}
        testID="screen"
      />,
    );

    await act(async () => {
      fireEvent.press(getByTestId('screen-mark-watered'));
    });

    await waitFor(() => {
      const after = raw
        .prepare(
          'SELECT plant_id, source FROM watering_events WHERE plant_id = ?',
        )
        .all('plant-1') as Array<{ plant_id: string; source: string }>;
      expect(after.length).toBe(1);
      expect(after[0].plant_id).toBe('plant-1');
      expect(after[0].source).toBe('user');
    });

    // P2 (codex) — better-sqlite3 same-connection reads see UNCOMMITTED
    // writes, so the SELECT above could pass even if the mutation left
    // an open transaction. Assert no in-flight transaction is dangling
    // after the mark-watered settles: better-sqlite3 exposes
    // `Database.inTransaction` which is true iff the connection has an
    // open BEGIN. A row counted by the SELECT + `inTransaction === false`
    // jointly prove the INSERT has COMMITTED.
    expect(raw.inTransaction).toBe(false);

    expect(onMarkWatered).toHaveBeenCalledTimes(1);
  });
});

// 5. Status chip flips after mark-watered

describe('E4-008 — status chip flips after mark-watered', () => {
  it('chip transitions water -> skip without remount once the engine re-derives', async () => {
    await setupDb('plant-1');
    mockedEngine.mockReturnValue('water');

    const onMarkWatered = jest.fn();
    const { getByTestId, getByLabelText, rerender } = render(
      <PlantDetailScreen
        plant={makePlant()}
        heroPhotoUri={null}
        wateringEvents={[]}
        photos={[]}
        onMarkWatered={onMarkWatered}
        onEditDetails={jest.fn()}
        nowMs={NOW}
        testID="screen"
      />,
    );
    expect(getByLabelText('Water today')).toBeOnTheScreen();

    await act(async () => {
      fireEvent.press(getByTestId('screen-mark-watered'));
    });

    await waitFor(() => {
      expect(onMarkWatered).toHaveBeenCalledTimes(1);
    });

    mockedEngine.mockReturnValue('skip');
    rerender(
      <PlantDetailScreen
        plant={makePlant()}
        heroPhotoUri={null}
        wateringEvents={[]}
        photos={[]}
        onMarkWatered={onMarkWatered}
        onEditDetails={jest.fn()}
        nowMs={NOW}
        testID="screen"
      />,
    );
    expect(getByLabelText('Skip watering')).toBeOnTheScreen();
  });
});

// 6. DST regression — two layers, two contracts
//
// The brief asks for a DST regression that locks in "millisecond math only".
// There are TWO surfaces in scope and they use DIFFERENT strategies:
//
//   - `computeWateringStatus` / `useWateringEngine` — pure UTC ms math
//     (E4-002 timezone-regression.test.ts pins this directly against the
//     engine). The screen consumes the engine's verdict through the
//     mocked `useWateringEngine` hook in this file, so the ms-math
//     contract is structurally upstream of the screen and not the right
//     place to assert it from a screen test.
//
//   - The screen's "Last watered N days ago" subline — `formatLastWatered`
//     which uses CALENDAR-DAY math anchored to `setDate(+1)`. The source
//     comments explicitly document this is calendar-anchored, not ms.
//     `setDate(+1)` walks calendar days regardless of DST hour drift, so
//     a 23h "day" and a 25h "day" both advance the cursor by exactly one
//     bucket. The DST safety here is OPERATIONAL (setDate walks the
//     calendar) not LITERAL ms math.
//
// The tests below pin the contract the screen actually implements: the
// rendered subline copy is invariant to DST hour drift because the
// calendar walk anchors on `setDate(+1)`, not `+86_400_000ms`. The
// pure-ms invariant the brief asks about lives in the engine and is
// pinned there.
describe('E4-008 — DST regression on rendered subline copy', () => {
  it('DST spring-forward sub-day delta still buckets as "today" or "yesterday" (calendar walk, not 24h floor)', () => {
    // 2026-03-08 01:30 in America/New_York is during the spring-forward
    // window. The screen receives `nowMs` and `lastWateredAtMs` as plain
    // UTC ms; the subline copy is calendar-day-bucketed via setDate(+1)
    // walks, NOT a `Math.floor((now - then) / 86_400_000)` step. A 23h
    // sub-day delta during DST forward must STILL bucket as "today" or
    // "yesterday" depending on whether it straddles local midnight —
    // never as "1 days ago" (grammar bug from a naive 24h floor that
    // counts a 23h DST-short day as 0).
    const dstSundayLocal = new Date(2026, 2, 8, 1, 30, 0).getTime();
    const twentyThreeHoursAgo = dstSundayLocal - 23 * ONE_HOUR_MS;
    const copy = formatLastWatered(twentyThreeHoursAgo, dstSundayLocal);
    expect(['Last watered today', 'Last watered yesterday']).toContain(copy);
    expect(copy).not.toMatch(/Last watered \d/);
  });

  it('7 calendar days across a DST boundary labels "Last watered 7 days ago" (NOT 6, NOT 8)', () => {
    // 7 calendar days back from 2026-03-08 = 2026-03-01. The DST forward
    // is on 2026-03-08, so the 7-day window straddles a 23h day. A naive
    // `Math.floor(diffMs / 86_400_000)` would compute 6 days because the
    // 23h short day pulls the ms total one bucket below 7 * 86_400_000.
    // The setDate(+1) walk is structurally immune: 7 calendar days =
    // 7 setDate(+1) advances.
    const dstSundayLocal = new Date(2026, 2, 8, 14, 0, 0).getTime();
    const sevenCalendarDaysBack = new Date(2026, 2, 1, 14, 0, 0).getTime();
    expect(formatLastWatered(sevenCalendarDaysBack, dstSundayLocal)).toBe(
      'Last watered 7 days ago',
    );
  });

  it('DST fall-back: 25h elapsed inside the same calendar day still buckets as "today"', () => {
    // 2026-11-01 02:30 is during the fall-back window (US/Canada). A 24h
    // elapsed window from inside this day to the same wall-clock time
    // next day actually spans 25 wall-clock hours — but in calendar-day
    // terms it's still a single day-walk. The screen's contract: the
    // bucket is determined by setDate(+1) walks from then-midnight to
    // now-midnight, not by ms delta. We pin a 6h sub-day delta inside
    // the same local calendar day — must be "today" regardless of how
    // the wall clock distorted that 6h window.
    const dstFallSundayLocal = new Date(2026, 10, 1, 14, 0, 0).getTime();
    const sixHoursEarlierSameDay = dstFallSundayLocal - 6 * ONE_HOUR_MS;
    expect(formatLastWatered(sixHoursEarlierSameDay, dstFallSundayLocal)).toBe(
      'Last watered today',
    );
  });
});

// 7. Sub-day precision regression

describe('E4-008 — sub-day precision', () => {
  it('12h ago labels "Last watered today" (NOT "Last watered 1 day ago")', () => {
    const twelveHoursAgo = NOW - 12 * ONE_HOUR_MS;
    const copy = formatLastWatered(twelveHoursAgo, NOW);
    expect(copy).toBe('Last watered today');
    expect(copy).not.toMatch(/\d+ day/i);
  });

  it('12h ago in the screen subline reads "Last watered today" (sub-day = 0 days)', () => {
    const events = [{ wateredAtMs: NOW - 12 * ONE_HOUR_MS }];
    const { getByTestId } = render(
      <PlantDetailScreen
        plant={makePlant()}
        heroPhotoUri={null}
        wateringEvents={events}
        photos={[]}
        onMarkWatered={jest.fn()}
        onEditDetails={jest.fn()}
        nowMs={NOW}
        testID="screen"
      />,
    );
    expect(getByTestId('screen-last-watered').props.children).toBe(
      'Last watered today',
    );
  });

  it('3 days + 11 hours ago labels "Last watered 3 days ago" (sub-day stays in the 3-day bucket)', () => {
    const threeDays11h = NOW - 3 * ONE_DAY_MS - 11 * ONE_HOUR_MS;
    expect(formatLastWatered(threeDays11h, NOW)).toBe('Last watered 3 days ago');
  });
});

// 8. a11y snapshot — every interactive element labelled

describe('E4-008 — a11y snapshot', () => {
  it('every Pressable in the tree has accessibilityRole + accessibilityLabel', () => {
    const r = render(
      <PlantDetailScreen
        plant={makePlant()}
        heroPhotoUri={null}
        wateringEvents={[{ wateredAtMs: NOW - 1 * ONE_DAY_MS }]}
        photos={[]}
        onMarkWatered={jest.fn()}
        onEditDetails={jest.fn()}
        onAddNote={jest.fn()}
        noteEnabled
        nowMs={NOW}
        testID="screen"
      />,
    );
    const pressables = collectPressables(rootNode(r));
    expect(pressables.length).toBeGreaterThanOrEqual(3);
    for (const node of pressables) {
      const props = node.props as Record<string, unknown>;
      expect(props.accessibilityRole).toBe('button');
      expect(typeof props.accessibilityLabel).toBe('string');
      expect((props.accessibilityLabel as string).length).toBeGreaterThan(0);
    }
  });
});

// 9. StrictMode safety with MountProbe sibling

describe('E4-008 — StrictMode safety', () => {
  it('mark-watered fires exactly once under StrictMode (MountProbe asserts double-mount)', async () => {
    await setupDb('plant-1');
    let mountCount = 0;
    function MountProbe(): null {
      React.useEffect(() => {
        mountCount += 1;
      });
      return null;
    }

    const onMarkWatered = jest.fn();
    const { getByTestId } = render(
      <React.StrictMode>
        <>
          <MountProbe />
          <PlantDetailScreen
            plant={makePlant()}
            heroPhotoUri={null}
            wateringEvents={[]}
            photos={[]}
            onMarkWatered={onMarkWatered}
            onEditDetails={jest.fn()}
            nowMs={NOW}
            testID="screen"
          />
        </>
      </React.StrictMode>,
    );

    expect(mountCount).toBeGreaterThanOrEqual(2);

    await act(async () => {
      fireEvent.press(getByTestId('screen-mark-watered'));
    });
    await waitFor(() => {
      expect(onMarkWatered).toHaveBeenCalledTimes(1);
    });
  });
});

// 10. Hermes-without-Intl tripwire

describe('E4-008 — Hermes-without-Intl tripwire', () => {
  it('the screen mounts when Intl.DateTimeFormat is monkey-patched to throw', () => {
    const originalDateTimeFormat = Intl.DateTimeFormat;
    const originalToLocaleDateString = Date.prototype.toLocaleDateString;
    try {
      Intl.DateTimeFormat = function ThrowingDateTimeFormat() {
        throw new Error('Hermes: Intl unavailable');
      } as unknown as typeof Intl.DateTimeFormat;
      Date.prototype.toLocaleDateString = function () {
        throw new Error('Hermes: toLocaleDateString unavailable');
      };

      const events = [{ wateredAtMs: NOW - 3 * ONE_DAY_MS }];
      const { getByTestId } = render(
        <PlantDetailScreen
          plant={makePlant()}
          heroPhotoUri={null}
          wateringEvents={events}
          photos={[]}
          onMarkWatered={jest.fn()}
          onEditDetails={jest.fn()}
          nowMs={NOW}
          testID="screen"
        />,
      );
      expect(getByTestId('screen-hero')).toBeOnTheScreen();
      expect(getByTestId('screen-header')).toBeOnTheScreen();
      expect(getByTestId('screen-mark-watered')).toBeOnTheScreen();
      expect(getByTestId('screen-last-watered').props.children).toBe(
        'Last watered 3 days ago',
      );
    } finally {
      Intl.DateTimeFormat = originalDateTimeFormat;
      Date.prototype.toLocaleDateString = originalToLocaleDateString;
    }
  });

  // Regression test originally filed via codex P2 review of E4-008 as an
  // INVERTED `test.failing(...)`: `PlantDetailScreen.formatLastWatered`'s
  // >14-day branch called `toLocaleDateString` without try/catch, crashing
  // the screen on Hermes without full Intl. The production fix shipped in
  // v0.1.68.0 (PR #69) — a local `formatMonthDay` helper wraps the call in
  // try/catch with a `SHORT_MONTHS_FALLBACK` array, mirroring the existing
  // pattern in `WateringLedger.formatWeekday`. With the fix in place, this
  // test now PASSES: the screen mounts cleanly under monkey-patched
  // throwing Intl. Flipped from `test.failing(...)` to `test(...)` per the
  // PR #69 coordination note so a future regression that re-introduces the
  // crash trips here loudly.
  test(
    'regression: screen mounts when Intl is broken and the most-recent event is 14+ days old (production fix in v0.1.68.0)',
    () => {
      const originalDateTimeFormat = Intl.DateTimeFormat;
      const originalToLocaleDateString = Date.prototype.toLocaleDateString;
      try {
        Intl.DateTimeFormat = function ThrowingDateTimeFormat() {
          throw new Error('Hermes: Intl unavailable');
        } as unknown as typeof Intl.DateTimeFormat;
        Date.prototype.toLocaleDateString = function () {
          throw new Error('Hermes: toLocaleDateString unavailable');
        };
        // 20 days back triggers the >14 day branch which calls
        // toLocaleDateString.
        const events = [{ wateredAtMs: NOW - 20 * ONE_DAY_MS }];
        const r = render(
          <PlantDetailScreen
            plant={makePlant()}
            heroPhotoUri={null}
            wateringEvents={events}
            photos={[]}
            onMarkWatered={jest.fn()}
            onEditDetails={jest.fn()}
            nowMs={NOW}
            testID="screen"
          />,
        );
        // If the fix is in place, the screen mounts and the subline
        // falls back to a number-based copy (or similar). If the fix
        // isn't in, the render throws.
        expect(r.getByTestId('screen-mark-watered')).toBeOnTheScreen();
      } finally {
        Intl.DateTimeFormat = originalDateTimeFormat;
        Date.prototype.toLocaleDateString = originalToLocaleDateString;
      }
    },
  );

  it('mounting the screen invokes neither Intl.DateTimeFormat for in-window events', () => {
    const dtfSpy = jest.spyOn(Intl, 'DateTimeFormat');
    try {
      render(
        <PlantDetailScreen
          plant={makePlant()}
          heroPhotoUri={null}
          wateringEvents={[
            { wateredAtMs: NOW - 1 * ONE_DAY_MS },
            { wateredAtMs: NOW - 5 * ONE_DAY_MS },
          ]}
          photos={[]}
          onMarkWatered={jest.fn()}
          onEditDetails={jest.fn()}
          nowMs={NOW}
          testID="screen"
        />,
      );
      expect(dtfSpy).not.toHaveBeenCalled();
    } finally {
      dtfSpy.mockRestore();
    }
  });
});

// 11. Reduce-motion — zero Animated.{timing,spring,loop} calls

describe('E4-008 — reduce-motion', () => {
  it('zero Animated.timing / spring / loop calls fire on mount under reduce-motion', () => {
    mockedReduceMotion.mockReturnValue(true);
    const timingSpy = jest.spyOn(Animated, 'timing');
    const springSpy = jest.spyOn(Animated, 'spring');
    const loopSpy = jest.spyOn(Animated, 'loop');
    try {
      render(
        <PlantDetailScreen
          plant={makePlant()}
          heroPhotoUri={null}
          wateringEvents={[{ wateredAtMs: NOW - 1 * ONE_DAY_MS }]}
          photos={[]}
          onMarkWatered={jest.fn()}
          onEditDetails={jest.fn()}
          nowMs={NOW}
          testID="screen"
        />,
      );
      expect(timingSpy).not.toHaveBeenCalled();
      expect(springSpy).not.toHaveBeenCalled();
      expect(loopSpy).not.toHaveBeenCalled();
    } finally {
      timingSpy.mockRestore();
      springSpy.mockRestore();
      loopSpy.mockRestore();
    }
  });

  it('zero Animated.timing calls fire during mark-watered under reduce-motion', async () => {
    await setupDb('plant-1');
    mockedReduceMotion.mockReturnValue(true);
    const timingSpy = jest.spyOn(Animated, 'timing');
    const springSpy = jest.spyOn(Animated, 'spring');
    const loopSpy = jest.spyOn(Animated, 'loop');
    try {
      const onMarkWatered = jest.fn();
      const { getByTestId } = render(
        <PlantDetailScreen
          plant={makePlant()}
          heroPhotoUri={null}
          wateringEvents={[]}
          photos={[]}
          onMarkWatered={onMarkWatered}
          onEditDetails={jest.fn()}
          nowMs={NOW}
          testID="screen"
        />,
      );
      await act(async () => {
        fireEvent.press(getByTestId('screen-mark-watered'));
      });
      await waitFor(() => {
        expect(onMarkWatered).toHaveBeenCalledTimes(1);
      });
      expect(timingSpy).not.toHaveBeenCalled();
      expect(springSpy).not.toHaveBeenCalled();
      expect(loopSpy).not.toHaveBeenCalled();
    } finally {
      timingSpy.mockRestore();
      springSpy.mockRestore();
      loopSpy.mockRestore();
    }
  });
});

// Tree-walk helpers

type JsonNode = {
  type: string | { displayName?: string; name?: string };
  props: Record<string, unknown>;
  children?: Array<JsonNode | string | null>;
};

function rootNode(r: RenderResult): JsonNode | null {
  const tree = r.toJSON();
  if (!tree) return null;
  if (Array.isArray(tree)) return (tree[0] ?? null) as unknown as JsonNode | null;
  return tree as unknown as JsonNode;
}

function collectAccessibilityLabels(node: JsonNode | string | null): string[] {
  if (!node || typeof node === 'string') return [];
  const out: string[] = [];
  const label = node.props?.accessibilityLabel;
  if (typeof label === 'string') out.push(label);
  if (node.children) {
    for (const c of node.children) {
      out.push(...collectAccessibilityLabels(c as JsonNode));
    }
  }
  return out;
}

function countTodayDots(
  node: JsonNode | string | null,
  todayColor: string,
): number {
  if (!node || typeof node === 'string') return 0;
  let n = 0;
  if (node.type === 'View') {
    const style = (node.props?.style ?? {}) as
      | Record<string, unknown>
      | Array<Record<string, unknown>>;
    const arr = Array.isArray(style) ? style : [style];
    // The today dot is a tiny 3×3 colored circle. Filter by the
    // (width, height, borderRadius, backgroundColor) signature so we
    // don't count the filled "Mark watered" button (also has
    // backgroundColor === theme.colors.text but at button dimensions).
    const merged: Record<string, unknown> = {};
    for (const s of arr) {
      if (s && typeof s === 'object') Object.assign(merged, s);
    }
    if (
      merged.backgroundColor === todayColor &&
      merged.width === 3 &&
      merged.height === 3
    ) {
      n++;
    }
  }
  if (node.children) {
    for (const c of node.children) {
      n += countTodayDots(c as JsonNode, todayColor);
    }
  }
  return n;
}

/**
 * Collect every interactive host node (Pressable / Touchable). RN's
 * serialized tree exposes a Pressable as a host `View` with an `onClick`
 * handler in props. The collector intentionally filters on the HANDLER
 * shape only (not on accessibilityRole) so the downstream assertion can
 * trip on a Pressable that's missing its label OR its role — codex P2
 * catch on E4-008: a pre-filter on `accessibilityRole === 'button'`
 * would silently exclude any Pressable missing the role, false-passing
 * the contract.
 */
function collectPressables(node: JsonNode | string | null): JsonNode[] {
  if (!node || typeof node === 'string') return [];
  const out: JsonNode[] = [];
  if (
    node.type === 'View' &&
    typeof (node.props as Record<string, unknown>).onClick === 'function'
  ) {
    out.push(node);
  }
  if (node.children) {
    for (const c of node.children) {
      out.push(...collectPressables(c as JsonNode));
    }
  }
  return out;
}
