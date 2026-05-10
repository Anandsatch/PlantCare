/**
 * E9-005 — Weekly review flow integration tests.
 *
 * Exercises the real component composition `<SundayLetterCard>` →
 * (open tap) → `<WeeklyReviewScreen>` → (dismiss tap) → parent persists →
 * `<SundayLetterCard>` re-render hidden until the next Sunday.
 *
 * The unit-level contracts on each surface are locked in their own test
 * files (`components/__tests__/SundayLetterCard.test.tsx` and
 * `screens/__tests__/WeeklyReviewScreen.test.tsx`). This file asserts the
 * wiring across both surfaces — specifically the dismiss-persistence path
 * that spans:
 *
 *   1. SundayLetterCard mounts on Sunday at the top of A-1.
 *   2. User taps "Read this week" → onOpen → parent navigates to A-6.
 *   3. WeeklyReviewScreen mounts. Resolves /api/review.
 *   4. User taps "Got it" → onDismiss → parent persists dismiss timestamp
 *      AND marks "shown this week" so the SundayLetterCard does not
 *      re-mount until the next Sunday's window opens.
 *   5. Re-render same Sunday → SundayLetterCard hidden.
 *   6. Re-render advanced to next-day-still-same-week → SundayLetterCard
 *      hidden.
 *   7. Re-render advanced to next Sunday (window slides) → SundayLetterCard
 *      mounts again.
 *
 * Mock posture (mirrors `cameraFlow.integration.test.tsx`):
 *   - `useTheme` / `useReduceMotion` mocked at the import boundary so we
 *     don't depend on AccessibilityInfo's async window.
 *   - `apiClient.review` is a hand-rolled jest.fn — only the module export
 *     is mocked; the WeeklyReviewScreen's internal dispatch + state machine
 *     run for real.
 *   - The parent persistence layer (the store the brief mentions) is
 *     primarily modeled as plain JS state in the host (the contract on
 *     `<SundayLetterCard>` is parent-owned persistence — SQLite or
 *     AsyncStorage). One dedicated test ALSO wires a real
 *     `better-sqlite3` in-memory DB for the dismiss round-trip so the
 *     SQL write/read path is exercised directly, not just the spy
 *     callback (codex P1 catch).
 *
 * V1 scope locks (rejected, per orchestrator brief):
 *   - No new test runner / library — jest + RTL + jest-expo only.
 *   - No date-fns / dayjs / luxon / Temporal — UTC ms anchored to local
 *     calendar walks via the same `Date` semantics SundayLetterCard owns.
 *   - No reaching into ApiClient internals — only the module export
 *     `review` is mocked.
 *   - No stubbed-out cross-component navigation — the SundayLetterCard tap
 *     genuinely drives the WeeklyReviewScreen mount via the host's state
 *     machine, mirroring the real navigator wiring.
 */

import { lightTheme } from '@plantcare/theme';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import Database from 'better-sqlite3';
import * as React from 'react';
import { AccessibilityInfo, Animated, AppState } from 'react-native';

import type { ApiClient, ApiResult, ReviewResponse } from '../api';
import { SundayLetterCard, shouldRender } from '../components/SundayLetterCard';
import {
  __resetInFlightDispatchesForTests,
  WeeklyReviewScreen,
} from '../screens/WeeklyReviewScreen';

// ─── Module mocks ───────────────────────────────────────────────────────

jest.mock('../hooks/useTheme', () => ({
  useTheme: jest.fn(),
}));
jest.mock('../hooks/useReduceMotion', () => ({
  useReduceMotion: jest.fn(),
}));

// AccessibilityInfo / AppState — used by WeeklyReviewScreen. The
// SundayLetterCard surface uses neither directly (it goes through
// useReduceMotion which we've already mocked).
jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(false);
jest.spyOn(AccessibilityInfo, 'setAccessibilityFocus').mockImplementation(
  () => undefined,
);
jest
  .spyOn(AppState, 'addEventListener')
  .mockImplementation(() => ({ remove: jest.fn() }) as never);

import { useReduceMotion } from '../hooks/useReduceMotion';
import { useTheme } from '../hooks/useTheme';

const mockedUseTheme = useTheme as jest.MockedFunction<typeof useTheme>;
const mockedUseReduceMotion = useReduceMotion as jest.MockedFunction<
  typeof useReduceMotion
>;

// ─── Fixtures ───────────────────────────────────────────────────────────

const SUCCESS_DATA: ReviewResponse = {
  headline: 'Last week',
  narrative:
    "You watered three times and skipped twice — a steady rhythm. Steve's leaves are unfurling.",
  per_plant: [
    { species_slug: 'monstera_deliciosa', observation: 'Steve looks happy.' },
  ],
  confidence: 78,
  source: 'free',
  latency_ms: 1234,
};

/** Local-time constructor → ms. Mirror the SundayLetterCard test fixtures. */
function L(
  y: number,
  m0: number,
  d: number,
  h = 12,
  min = 0,
  s = 0,
  ms = 0,
): number {
  return new Date(y, m0, d, h, min, s, ms).getTime();
}

// May 2026 anchors — same calendar the SundayLetterCard suite uses.
const SUN_MAY_03 = L(2026, 4, 3, 9, 0); // Sunday 09:00 local
const SUN_MAY_03_AFTERNOON = L(2026, 4, 3, 15, 0); // Sunday 15:00 local
const MON_MAY_04 = L(2026, 4, 4, 9, 0); // Monday 09:00
const SAT_MAY_09 = L(2026, 4, 9, 23, 0); // Saturday 23:00 — last hour of Sunday window
const SUN_MAY_10 = L(2026, 4, 10, 9, 0); // Next Sunday — window slides forward

function defaultRequest() {
  return {
    week_summary: {
      plants_total: 1,
      watering_events: 3,
      skip_events: 1,
      diagnoses: 0,
    },
    plants: [
      {
        species_slug: 'monstera_deliciosa',
        nickname: 'Steve',
        watering_count: 3,
        skip_count: 1,
        had_diagnosis: false,
      },
    ],
  };
}

function makeApiClient(
  reviewImpl: () => Promise<ApiResult<ReviewResponse>>,
): { client: ApiClient; reviewSpy: jest.Mock } {
  const reviewSpy = jest.fn(reviewImpl as never);
  const client: ApiClient = {
    identify: jest.fn() as never,
    diagnose: jest.fn() as never,
    consult: jest.fn() as never,
    review: reviewSpy as never,
    weather: jest.fn() as never,
  };
  return { client, reviewSpy };
}

// ─── Host component ─────────────────────────────────────────────────────

/**
 * Tiny host that wires SundayLetterCard → WeeklyReviewScreen the way the
 * production navigator will. State machine: 'list' (with the card at top
 * of a stub Plants-list-shaped container) → 'review' (the WeeklyReviewScreen
 * mounts). The host owns `dismissedAtMs` and `lastReviewedAtMs` because
 * the SundayLetterCard contract puts persistence on the parent. In the
 * real app this maps to a SQLite read/write; here we use plain React
 * state, which is functionally identical for the contract-under-test.
 */
type WeeklyFlowProps = {
  apiClient: ApiClient;
  /** Test seam — drives both the card's nowMs and the screen's nowMs. */
  nowMs: number;
  /** Pre-seeded dismiss state (e.g. for "already dismissed" assertions). */
  initialDismissedAtMs?: number | null;
  /** Pre-seeded last-review state. */
  initialLastReviewedAtMs?: number | null;
  /** Test spy fired whenever the parent persists a dismiss. */
  onDismissPersisted?: (dismissedAtMs: number) => void;
  /** Test spy fired whenever the parent persists a last-review timestamp. */
  onLastReviewedPersisted?: (lastReviewedAtMs: number) => void;
};

function WeeklyReviewFlow({
  apiClient,
  nowMs,
  initialDismissedAtMs = null,
  initialLastReviewedAtMs = null,
  onDismissPersisted,
  onLastReviewedPersisted,
}: WeeklyFlowProps): React.ReactElement {
  const [mode, setMode] = React.useState<'list' | 'review'>('list');
  const [dismissedAtMs, setDismissedAtMs] = React.useState<number | null>(
    initialDismissedAtMs,
  );
  const [lastReviewedAtMs, setLastReviewedAtMs] = React.useState<number | null>(
    initialLastReviewedAtMs,
  );

  const handleOpen = React.useCallback(() => {
    setMode('review');
  }, []);

  const handleCardDismiss = React.useCallback(() => {
    // Tapping "Dismiss" on the card itself also persists the same
    // window-level dismiss timestamp. Same persistence path as the screen.
    setDismissedAtMs(nowMs);
    onDismissPersisted?.(nowMs);
  }, [nowMs, onDismissPersisted]);

  const handleScreenDismiss = React.useCallback(() => {
    // The brief: "the dismiss path on WeeklyReviewScreen also marks the
    // SundayLetterCard's 'shown this week' flag so it doesn't re-mount
    // until next Sunday." Persist BOTH the dismiss timestamp (suppresses
    // the card for the current Sunday window) AND the lastReviewedAtMs
    // (advances the staleness clock, so the weekday "stale-week" branch
    // also stays closed).
    setDismissedAtMs(nowMs);
    setLastReviewedAtMs(nowMs);
    onDismissPersisted?.(nowMs);
    onLastReviewedPersisted?.(nowMs);
    // Route back to the list. The dismiss is the user saying "I'm done
    // with this week's review."
    setMode('list');
  }, [nowMs, onDismissPersisted, onLastReviewedPersisted]);

  if (mode === 'review') {
    return (
      <WeeklyReviewScreen
        apiClient={apiClient}
        weekRequest={defaultRequest()}
        plantsForLedgers={[
          {
            id: 'plant-1',
            nickname: 'Steve',
            species_label: 'Monstera deliciosa',
            events: [{ wateredAtMs: nowMs - 86_400_000 }],
          },
        ]}
        onDismiss={handleScreenDismiss}
        nowMs={nowMs}
        testID="flow-weekly-review"
      />
    );
  }

  // Stub Plants-list-shaped container. The card sits at the top of the
  // list; the rest of the list is a single sentinel so the card is
  // observably nested inside a list-shaped surface.
  return (
    <>
      <SundayLetterCard
        nowMs={nowMs}
        lastReviewedAtMs={lastReviewedAtMs}
        dismissedAtMs={dismissedAtMs}
        onOpen={handleOpen}
        onDismiss={handleCardDismiss}
        testID="flow-sunday-card"
      />
    </>
  );
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe('Weekly review flow integration', () => {
  beforeEach(() => {
    mockedUseTheme.mockReset();
    mockedUseReduceMotion.mockReset();
    mockedUseTheme.mockReturnValue(lightTheme);
    mockedUseReduceMotion.mockReturnValue(false);
    __resetInFlightDispatchesForTests();
  });

  it('happy path: Sunday → card visible → tap "Read this week" → WeeklyReviewScreen mounts and dispatches /api/review', async () => {
    const { client, reviewSpy } = makeApiClient(async () => ({
      ok: true,
      data: SUCCESS_DATA,
    }));

    render(<WeeklyReviewFlow apiClient={client} nowMs={SUN_MAY_03} />);

    expect(screen.queryByTestId('flow-sunday-card')).toBeOnTheScreen();
    expect(screen.queryByTestId('flow-weekly-review')).toBeNull();

    fireEvent.press(screen.getByTestId('flow-sunday-card-open'));

    await waitFor(() =>
      expect(screen.queryByTestId('flow-weekly-review')).toBeOnTheScreen(),
    );
    expect(screen.queryByTestId('flow-sunday-card')).toBeNull();
    await waitFor(() => expect(reviewSpy).toHaveBeenCalledTimes(1));
  });

  it('weekday with no review history: card NOT visible (Monday empty-state contract)', () => {
    const { client } = makeApiClient(async () => ({
      ok: true,
      data: SUCCESS_DATA,
    }));

    render(<WeeklyReviewFlow apiClient={client} nowMs={MON_MAY_04} />);

    expect(screen.queryByTestId('flow-sunday-card')).toBeNull();
    expect(screen.queryByTestId('flow-weekly-review')).toBeNull();
  });

  it('dismiss path on WeeklyReviewScreen marks "shown this week" — card hidden later same Sunday', async () => {
    const { client } = makeApiClient(async () => ({
      ok: true,
      data: SUCCESS_DATA,
    }));
    const onDismissPersisted = jest.fn();
    const onLastReviewedPersisted = jest.fn();

    const { rerender } = render(
      <WeeklyReviewFlow
        apiClient={client}
        nowMs={SUN_MAY_03}
        onDismissPersisted={onDismissPersisted}
        onLastReviewedPersisted={onLastReviewedPersisted}
      />,
    );

    // Open the screen, wait for content, dismiss.
    fireEvent.press(screen.getByTestId('flow-sunday-card-open'));
    await waitFor(() =>
      expect(screen.queryByTestId('weekly-review-content')).toBeOnTheScreen(),
    );
    fireEvent.press(screen.getByTestId('weekly-review-dismiss'));

    // Parent persisted both timestamps.
    expect(onDismissPersisted).toHaveBeenCalledTimes(1);
    expect(onDismissPersisted).toHaveBeenCalledWith(SUN_MAY_03);
    expect(onLastReviewedPersisted).toHaveBeenCalledTimes(1);
    expect(onLastReviewedPersisted).toHaveBeenCalledWith(SUN_MAY_03);

    // Routed back to the list AND the card is suppressed (in-window
    // dismiss). Even later the same Sunday → still suppressed.
    await waitFor(() =>
      expect(screen.queryByTestId('flow-weekly-review')).toBeNull(),
    );
    expect(screen.queryByTestId('flow-sunday-card')).toBeNull();

    // Force an explicit re-render at a later timestamp on the same Sunday;
    // the parent's persisted dismiss state survives, so the card stays
    // hidden. (We rerender with a new nowMs prop to drive the helper's
    // re-evaluation.)
    rerender(
      <WeeklyReviewFlow
        apiClient={client}
        nowMs={SUN_MAY_03_AFTERNOON}
        onDismissPersisted={onDismissPersisted}
        onLastReviewedPersisted={onLastReviewedPersisted}
      />,
    );
    expect(screen.queryByTestId('flow-sunday-card')).toBeNull();
  });

  it('dismiss persistence survives across the week: Saturday late-night still suppressed; Sunday next week renders again', async () => {
    // Drive the dismiss inside the host's parent state, then exercise the
    // helper across the rest of the Sunday window AND the next Sunday's
    // window-slide. The host re-uses parent state, so the assertion is
    // against the public surface (card visibility), not the internal
    // dismiss timestamp.
    const { client } = makeApiClient(async () => ({
      ok: true,
      data: SUCCESS_DATA,
    }));
    const { rerender } = render(
      <WeeklyReviewFlow apiClient={client} nowMs={SUN_MAY_03} />,
    );

    // Open + dismiss the screen.
    fireEvent.press(screen.getByTestId('flow-sunday-card-open'));
    await waitFor(() =>
      expect(screen.queryByTestId('weekly-review-content')).toBeOnTheScreen(),
    );
    fireEvent.press(screen.getByTestId('weekly-review-dismiss'));
    await waitFor(() =>
      expect(screen.queryByTestId('flow-weekly-review')).toBeNull(),
    );

    // Mid-week (Mon May 4): the card stays hidden. The parent persisted
    // BOTH dismissedAtMs AND lastReviewedAtMs, so the staleness branch
    // can't re-surface the card on a weekday either.
    rerender(<WeeklyReviewFlow apiClient={client} nowMs={MON_MAY_04} />);
    expect(screen.queryByTestId('flow-sunday-card')).toBeNull();

    // Saturday 23:00 — last hour of the Sunday window. Still hidden.
    rerender(<WeeklyReviewFlow apiClient={client} nowMs={SAT_MAY_09} />);
    expect(screen.queryByTestId('flow-sunday-card')).toBeNull();

    // Sun May 10 09:00 — the window slides forward. The previous Sun
    // May 3 dismiss is now BEFORE the new window's start, so the card
    // surfaces again. lastReviewedAtMs is also Sun May 3, which is only
    // 7 calendar days back — ON the staleness threshold; but we're on a
    // Sunday, so the Sunday branch alone surfaces the card.
    rerender(<WeeklyReviewFlow apiClient={client} nowMs={SUN_MAY_10} />);
    expect(screen.queryByTestId('flow-sunday-card')).toBeOnTheScreen();
  });

  it('card "Dismiss" tap (without opening the screen) also persists in-window — does NOT re-mount later same Sunday', () => {
    // SundayLetterCard ships with its own "Dismiss" CTA that the brief
    // explicitly calls out: "tap 'Got it' or close → SQLite write to a
    // dismiss table". The card's onDismiss + the screen's onDismiss go
    // through the SAME parent persistence path. Lock that they're
    // interchangeable from the user's POV.
    const { client } = makeApiClient(async () => ({
      ok: true,
      data: SUCCESS_DATA,
    }));
    const onDismissPersisted = jest.fn();

    const { rerender } = render(
      <WeeklyReviewFlow
        apiClient={client}
        nowMs={SUN_MAY_03}
        onDismissPersisted={onDismissPersisted}
      />,
    );

    fireEvent.press(screen.getByTestId('flow-sunday-card-dismiss'));
    expect(onDismissPersisted).toHaveBeenCalledTimes(1);
    expect(onDismissPersisted).toHaveBeenCalledWith(SUN_MAY_03);

    // The card has now hidden itself via shouldRender's defensive gate
    // (parent passed dismissedAtMs inside the current window).
    expect(screen.queryByTestId('flow-sunday-card')).toBeNull();

    // Later that same Sunday → still hidden.
    rerender(
      <WeeklyReviewFlow
        apiClient={client}
        nowMs={SUN_MAY_03_AFTERNOON}
        // Re-seed with the persisted dismiss to mirror what a re-mount
        // (e.g. after a navigator pop) would read out of SQLite.
        initialDismissedAtMs={SUN_MAY_03}
      />,
    );
    expect(screen.queryByTestId('flow-sunday-card')).toBeNull();
  });

  it('escape hatch: stale-week (8 days since last review) on Tuesday → card visible even though it is not Sunday', () => {
    // Per the brief: "Renders on weekdays IF daysSinceLastReview >= 7
    // (escape hatch — even on Tuesday, if user hasn't reviewed in 8 days,
    // show the card)." Verify the escape hatch through the host wiring.
    const { client } = makeApiClient(async () => ({
      ok: true,
      data: SUCCESS_DATA,
    }));
    const TUE_MAY_05 = L(2026, 4, 5, 12, 0);
    const eightDaysAgo = L(2026, 3, 27, 12, 0);

    render(
      <WeeklyReviewFlow
        apiClient={client}
        nowMs={TUE_MAY_05}
        initialLastReviewedAtMs={eightDaysAgo}
      />,
    );

    expect(screen.queryByTestId('flow-sunday-card')).toBeOnTheScreen();
  });

  it('strict-mode: actually double-mounts (probe ≥ 2 effect runs); /api/review still fires exactly once on screen entry', async () => {
    // Codex P2 catch: prove the double-mount actually happened before
    // asserting the latch held. A sibling probe component counts useEffect
    // runs; under StrictMode the count is ≥ 2 across the
    // mount→unmount→re-mount cycle. Without that proof, "review fired
    // once" could just mean StrictMode wasn't active in the harness.
    let probeEffectRuns = 0;
    function MountProbe(): React.ReactElement {
      React.useEffect(() => {
        probeEffectRuns += 1;
      });
      return <></>;
    }

    const { client, reviewSpy } = makeApiClient(async () => ({
      ok: true,
      data: SUCCESS_DATA,
    }));

    render(
      <React.StrictMode>
        <MountProbe />
        <WeeklyReviewFlow apiClient={client} nowMs={SUN_MAY_03} />
      </React.StrictMode>,
    );

    // Sanity gate — StrictMode is actually double-invoking effects in
    // this harness. If this assertion fails, the rest of the test is
    // meaningless.
    expect(probeEffectRuns).toBeGreaterThanOrEqual(2);

    fireEvent.press(screen.getByTestId('flow-sunday-card-open'));
    await waitFor(() =>
      expect(screen.queryByTestId('flow-weekly-review')).toBeOnTheScreen(),
    );
    await waitFor(() => expect(reviewSpy).toHaveBeenCalledTimes(1));
    // Settle any pending microtasks the dispatch latch might queue.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(reviewSpy).toHaveBeenCalledTimes(1);
  });

  it('reduce-motion: first-paint opacity is 1 AND Animated.timing is NEVER called across both surfaces', async () => {
    // Codex P3 catch: the original assertion only read opacity AFTER
    // success had committed, which means a slow timing animation that
    // ran 0→1 on a real reduce-motion user could pass. The diagnostic
    // assertion is two-fold: (1) opacity at first paint is the end state,
    // and (2) Animated.timing was never invoked on either surface across
    // the loading→success edge.
    mockedUseReduceMotion.mockReturnValue(true);
    // Also gate the synchronous probe to confirm reduce-motion at the
    // moment the success-fade effect would fire.
    (
      AccessibilityInfo.isReduceMotionEnabled as jest.Mock
    ).mockResolvedValue(true);
    const animatedTimingSpy = jest.spyOn(Animated, 'timing');
    animatedTimingSpy.mockClear();

    try {
      const { client } = makeApiClient(async () => ({
        ok: true,
        data: SUCCESS_DATA,
      }));

      render(<WeeklyReviewFlow apiClient={client} nowMs={SUN_MAY_03} />);

      // Card opacity = 1 at FIRST paint (before any effect could have
      // run a timing call to land it at 1 from a 0 init).
      const card = screen.getByTestId('flow-sunday-card');
      const flat: Array<Record<string, unknown> | undefined> = Array.isArray(
        card.props.style,
      )
        ? card.props.style.flat()
        : [card.props.style];
      const cardOpacity = flat
        .map((s) => (s as { opacity?: unknown } | undefined)?.opacity)
        .find((v) => v !== undefined);
      const cardNumeric =
        typeof cardOpacity === 'number'
          ? cardOpacity
          : (cardOpacity as { __getValue?: () => number } | undefined)?.__getValue?.();
      expect(cardNumeric).toBe(1);
      // Card surface: zero Animated.timing calls.
      expect(animatedTimingSpy).toHaveBeenCalledTimes(0);

      // Drive into the screen and let success commit.
      fireEvent.press(screen.getByTestId('flow-sunday-card-open'));
      await waitFor(() =>
        expect(screen.queryByTestId('weekly-review-content')).toBeOnTheScreen(),
      );
      // Drain the synchronous reduce-motion probe's resolution.
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      // Screen content opacity = 1 on the success render.
      const contentView = screen.getByTestId('weekly-review-content');
      const contentFlat: Array<Record<string, unknown> | undefined> = Array.isArray(
        contentView.props.style,
      )
        ? contentView.props.style.flat()
        : [contentView.props.style];
      const contentOpacity = contentFlat
        .map((s) => (s as { opacity?: unknown } | undefined)?.opacity)
        .find((v) => v !== undefined);
      const contentNumeric =
        typeof contentOpacity === 'number'
          ? contentOpacity
          : (contentOpacity as { _value?: number } | undefined)?._value;
      expect(contentNumeric).toBe(1);

      // Critical: zero Animated.timing calls fired across the entire
      // reduce-motion path (card + screen). This catches any future
      // refactor that animates 0→1 with a "duration: 0" hack — that's
      // still vestibular-disorder-non-compliant.
      expect(animatedTimingSpy).toHaveBeenCalledTimes(0);
    } finally {
      animatedTimingSpy.mockRestore();
    }
  });

  it('dismiss persists to in-memory SQLite (round-trip): write on Got it → read back proves the row was committed', async () => {
    // Codex P1 catch: the React-state host is functionally equivalent to
    // the parent-owned-persistence contract on SundayLetterCard, but it
    // doesn't prove the SQLite write actually lands. This test wires a
    // better-sqlite3 in-memory DB with a `weekly_review_dismissals`
    // single-row key/value pattern (matching the simplest persistence
    // shape the parent could plausibly adopt) and verifies the dismiss
    // tap commits a row that a subsequent read sees.
    //
    // We use the in-memory SQLite test pattern from
    // `apps/mobile/src/sync/__tests__/queueCrud.test.ts` — better-sqlite3
    // directly, no module-boundary mocking. The DB IS the persistence
    // boundary in this test.
    const db = new Database(':memory:');
    // Schema setup uses prepare()+run() pattern (not raw exec) so the
    // statement-builder discipline is consistent with the rest of the
    // mobile DB layer.
    db.prepare(
      `CREATE TABLE weekly_review_dismissals (
        id INTEGER PRIMARY KEY,
        dismissed_at_ms INTEGER NOT NULL,
        last_reviewed_at_ms INTEGER NOT NULL
      )`,
    ).run();

    // The host wires onDismiss to a synchronous SQLite write — the same
    // pattern the parent screen will follow (it's a one-row upsert).
    function persistDismiss(dismissedAtMs: number, lastReviewedAtMs: number): void {
      db.prepare(
        'INSERT OR REPLACE INTO weekly_review_dismissals (id, dismissed_at_ms, last_reviewed_at_ms) VALUES (1, ?, ?)',
      ).run(dismissedAtMs, lastReviewedAtMs);
    }
    function readDismiss():
      | { dismissed_at_ms: number; last_reviewed_at_ms: number }
      | undefined {
      return db
        .prepare(
          'SELECT dismissed_at_ms, last_reviewed_at_ms FROM weekly_review_dismissals WHERE id = 1',
        )
        .get() as
        | { dismissed_at_ms: number; last_reviewed_at_ms: number }
        | undefined;
    }

    const { client } = makeApiClient(async () => ({
      ok: true,
      data: SUCCESS_DATA,
    }));

    // Pre-condition: no row.
    expect(readDismiss()).toBeUndefined();

    // Render the flow with a host that ALSO commits to SQLite on dismiss.
    // We compose the production host with a side-channel persistDismiss
    // call — same wiring the real parent will adopt.
    function SqliteBackedFlow(): React.ReactElement {
      const [dismissedAtMs, setDismissedAtMs] = React.useState<number | null>(null);
      const [lastReviewedAtMs, setLastReviewedAtMs] = React.useState<number | null>(null);
      const [mode, setMode] = React.useState<'list' | 'review'>('list');

      const handleScreenDismiss = (): void => {
        // Mirror the production parent: persist BOTH timestamps to SQLite,
        // update local state from the SQLite read (truth-from-storage), and
        // route back to the list.
        persistDismiss(SUN_MAY_03, SUN_MAY_03);
        const row = readDismiss();
        if (row) {
          setDismissedAtMs(row.dismissed_at_ms);
          setLastReviewedAtMs(row.last_reviewed_at_ms);
        }
        setMode('list');
      };

      if (mode === 'review') {
        return (
          <WeeklyReviewScreen
            apiClient={client}
            weekRequest={defaultRequest()}
            plantsForLedgers={[
              {
                id: 'plant-1',
                nickname: 'Steve',
                species_label: 'Monstera deliciosa',
                events: [{ wateredAtMs: SUN_MAY_03 - 86_400_000 }],
              },
            ]}
            onDismiss={handleScreenDismiss}
            nowMs={SUN_MAY_03}
            testID="flow-weekly-review"
          />
        );
      }
      return (
        <SundayLetterCard
          nowMs={SUN_MAY_03}
          lastReviewedAtMs={lastReviewedAtMs}
          dismissedAtMs={dismissedAtMs}
          onOpen={() => setMode('review')}
          onDismiss={() => {
            persistDismiss(SUN_MAY_03, lastReviewedAtMs ?? 0);
            const row = readDismiss();
            if (row) setDismissedAtMs(row.dismissed_at_ms);
          }}
          testID="flow-sunday-card"
        />
      );
    }

    render(<SqliteBackedFlow />);
    fireEvent.press(screen.getByTestId('flow-sunday-card-open'));
    await waitFor(() =>
      expect(screen.queryByTestId('weekly-review-content')).toBeOnTheScreen(),
    );
    fireEvent.press(screen.getByTestId('weekly-review-dismiss'));

    // SQLite row landed. THIS is the dismiss-persistence contract — a
    // missing or no-op INSERT would fail HERE, not just at the spy
    // callback level.
    const row = readDismiss();
    expect(row).toBeDefined();
    expect(row!.dismissed_at_ms).toBe(SUN_MAY_03);
    expect(row!.last_reviewed_at_ms).toBe(SUN_MAY_03);

    // Card stays hidden after the round trip — the parent's read pulled
    // the row out and gated the card via shouldRender.
    await waitFor(() =>
      expect(screen.queryByTestId('flow-weekly-review')).toBeNull(),
    );
    expect(screen.queryByTestId('flow-sunday-card')).toBeNull();

    db.close();
  });

  it('shouldRender + parent-state contract: the helper agrees with the rendered visibility across the Sun → Mon → next-Sun sweep', () => {
    // Tripwire test: anytime the host renders the card, shouldRender(...)
    // must agree. Anytime the host hides it, shouldRender must say no.
    // This pins the dual-gate contract end-to-end. If a future refactor
    // pushes visibility logic into the component without re-exporting the
    // helper, parents that gate via shouldRender stop matching the
    // component's behavior — caught here.
    const { client } = makeApiClient(async () => ({
      ok: true,
      data: SUCCESS_DATA,
    }));

    // Sunday, never reviewed, no dismiss → both say YES.
    const { rerender } = render(
      <WeeklyReviewFlow apiClient={client} nowMs={SUN_MAY_03} />,
    );
    expect(screen.queryByTestId('flow-sunday-card')).toBeOnTheScreen();
    expect(shouldRender(SUN_MAY_03, null, null)).toBe(true);

    // Monday, never reviewed → both say NO.
    rerender(<WeeklyReviewFlow apiClient={client} nowMs={MON_MAY_04} />);
    expect(screen.queryByTestId('flow-sunday-card')).toBeNull();
    expect(shouldRender(MON_MAY_04, null, null)).toBe(false);

    // Next Sunday, never reviewed → both say YES.
    rerender(<WeeklyReviewFlow apiClient={client} nowMs={SUN_MAY_10} />);
    expect(screen.queryByTestId('flow-sunday-card')).toBeOnTheScreen();
    expect(shouldRender(SUN_MAY_10, null, null)).toBe(true);
  });
});
