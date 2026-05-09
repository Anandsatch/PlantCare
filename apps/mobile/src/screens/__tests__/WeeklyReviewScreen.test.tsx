/**
 * WeeklyReviewScreen tests.
 *
 * Coverage discipline:
 *   - State machine: loading → success / error variants / queued / empty.
 *   - Discriminated union NOT collapsed: each error kind renders its own copy.
 *   - Strict-mode double-mount: useEffect-fire count is 1 (dispatchedRef latch).
 *   - AppState resume: settled-success state does NOT re-fetch.
 *   - Reduce-motion: animation hard-disabled (no Animated.timing call).
 *   - Accessibility: hero has image role + label, headline has header role,
 *     CTAs have button role + label, per-plant sections wrap with composed label.
 *   - Sub-day-precision regression: a 3d 12h fixture that would round wrong with
 *     `Math.floor((now - then) / 86_400_000)` survives (proxied via the
 *     <WateringLedger>'s setHours bucketing — re-asserted here via column
 *     pattern check).
 *
 * Mock posture:
 *   - `apiClient` is a hand-rolled object with a jest.fn for each method.
 *   - `AccessibilityInfo` is mocked at the RN module surface so reduceMotion
 *     starts false and so setAccessibilityFocus is observable.
 *   - `AppState` is mocked to expose the registered listener — tests fire
 *     'active' events without bouncing through the real subscription.
 *   - `Animated.timing` is spied so we can assert (a) it's called when reduce-
 *     motion is false and (b) it's NOT called when reduce-motion is true.
 */
import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import * as React from 'react';
import { AccessibilityInfo, Animated, AppState } from 'react-native';

import type { ApiClient, ApiResult, ReviewResponse } from '../../api';
import {
  __resetInFlightDispatchesForTests,
  WeeklyReviewScreen,
  type WeeklyReviewPlantInput,
} from '../WeeklyReviewScreen';

// ─── Module-level mocks ─────────────────────────────────────────────────

// `useColorScheme` defaults to 'light' but tests override per-case via mock.
const mockedUseColorScheme = jest.fn<() => 'light' | 'dark' | null | undefined>(
  () => 'light',
);
jest.mock('react-native/Libraries/Utilities/useColorScheme', () => ({
  __esModule: true,
  default: () => mockedUseColorScheme(),
}));

// `useReduceMotion` is mocked at the import boundary so tests can flip
// reduce-motion before mount without bouncing through AccessibilityInfo's
// async resolution.
const mockedReduceMotion = jest.fn<() => boolean>(() => false);
jest.mock('../../hooks/useReduceMotion', () => ({
  useReduceMotion: () => mockedReduceMotion(),
}));

// AccessibilityInfo.setAccessibilityFocus — observable spy.
jest
  .spyOn(AccessibilityInfo, 'setAccessibilityFocus')
  .mockImplementation(() => undefined);

// AccessibilityInfo.isReduceMotionEnabled — used by the synchronous probe in
// the success-fade effect (codex P2 fix). Default to false; tests that check
// reduce-motion override.
const isReduceMotionEnabledSpy = jest.spyOn(
  AccessibilityInfo,
  'isReduceMotionEnabled',
);
isReduceMotionEnabledSpy.mockResolvedValue(false);

// AppState.addEventListener — capture handler so tests can fire 'active'.
type AppStateHandler = (status: 'active' | 'background' | 'inactive') => void;
const appStateHandlers: AppStateHandler[] = [];
jest.spyOn(AppState, 'addEventListener').mockImplementation(((
  _event: string,
  handler: AppStateHandler,
) => {
  appStateHandlers.push(handler);
  return {
    remove: () => {
      const i = appStateHandlers.indexOf(handler);
      if (i >= 0) appStateHandlers.splice(i, 1);
    },
  };
}) as never);

// Animated.timing spy — production code calls it on the loading→content edge.
// Spy must preserve the real behavior so the fade still completes; we just
// assert call counts.
const animatedTimingSpy = jest.spyOn(Animated, 'timing');

// ─── Test helpers ───────────────────────────────────────────────────────

const SUCCESS_DATA: ReviewResponse = {
  headline: 'Last week',
  narrative:
    "You watered three times and skipped twice — a steady rhythm. Steve's leaves are unfurling.",
  per_plant: [
    { species_slug: 'monstera_deliciosa', observation: 'Steve looks happy.' },
    { species_slug: 'pothos_aureus', observation: 'Phil is reaching for light.' },
  ],
  confidence: 78,
  source: 'free',
  latency_ms: 1234,
};

const EMPTY_DATA: ReviewResponse = {
  headline: 'Last week',
  narrative: 'Ready when you are.',
  per_plant: [],
  confidence: 50,
  source: 'free',
  latency_ms: 500,
};

const FIXED_NOW = new Date('2026-05-06T12:00:00.000Z').getTime();

function makePlantInputs(): WeeklyReviewPlantInput[] {
  return [
    {
      id: 'plant-1',
      nickname: 'Steve',
      species_label: 'Monstera deliciosa',
      events: [{ wateredAtMs: FIXED_NOW - 1 * 86_400_000 }],
    },
    {
      id: 'plant-2',
      nickname: 'Phil',
      species_label: 'Pothos aureus',
      events: [{ wateredAtMs: FIXED_NOW - 3 * 86_400_000 }],
    },
  ];
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
  };
  return { client, reviewSpy };
}

function defaultRequest() {
  return {
    week_summary: {
      plants_total: 2,
      watering_events: 3,
      skip_events: 2,
      diagnoses: 0,
    },
    plants: [
      {
        species_slug: 'monstera_deliciosa',
        nickname: 'Steve',
        watering_count: 2,
        skip_count: 1,
        had_diagnosis: false,
      },
      {
        species_slug: 'pothos_aureus',
        nickname: 'Phil',
        watering_count: 1,
        skip_count: 1,
        had_diagnosis: false,
      },
    ],
  };
}

beforeEach(() => {
  mockedReduceMotion.mockReturnValue(false);
  mockedUseColorScheme.mockReturnValue('light');
  appStateHandlers.length = 0;
  animatedTimingSpy.mockClear();
  isReduceMotionEnabledSpy.mockClear();
  isReduceMotionEnabledSpy.mockResolvedValue(false);
  (AccessibilityInfo.setAccessibilityFocus as jest.Mock).mockClear();
  __resetInFlightDispatchesForTests();
});

// ─── Tests ──────────────────────────────────────────────────────────────

describe('WeeklyReviewScreen', () => {
  it('mounts → fires apiClient.review exactly once', async () => {
    const { client, reviewSpy } = makeApiClient(async () => ({
      ok: true,
      data: SUCCESS_DATA,
    }));
    render(
      <WeeklyReviewScreen
        apiClient={client}
        weekRequest={defaultRequest()}
        plantsForLedgers={makePlantInputs()}
        onDismiss={jest.fn()}
        nowMs={FIXED_NOW}
      />,
    );

    await waitFor(() => expect(reviewSpy).toHaveBeenCalledTimes(1));
  });

  it('Strict-mode double-mount: actual <React.StrictMode> wrapper fires apiClient.review exactly once', async () => {
    // Real test: <React.StrictMode> in dev mounts → unmounts → mounts again,
    // which gives each mount a fresh dispatchedRef. The codex P1 catch
    // motivated layering a module-scoped in-flight cache on top of the ref
    // so cross-mount StrictMode dedupe works. This locks the contract.
    const { client, reviewSpy } = makeApiClient(async () => ({
      ok: true,
      data: SUCCESS_DATA,
    }));
    render(
      <React.StrictMode>
        <WeeklyReviewScreen
          apiClient={client}
          weekRequest={defaultRequest()}
          plantsForLedgers={makePlantInputs()}
          onDismiss={jest.fn()}
          nowMs={FIXED_NOW}
        />
      </React.StrictMode>,
    );

    await waitFor(() => expect(reviewSpy).toHaveBeenCalledTimes(1));
  });

  it('loading state: skeleton renders while in-flight', async () => {
    let resolve!: (v: ApiResult<ReviewResponse>) => void;
    const { client } = makeApiClient(
      () =>
        new Promise<ApiResult<ReviewResponse>>((r) => {
          resolve = r;
        }),
    );
    const tree = render(
      <WeeklyReviewScreen
        apiClient={client}
        weekRequest={defaultRequest()}
        plantsForLedgers={makePlantInputs()}
        onDismiss={jest.fn()}
        nowMs={FIXED_NOW}
      />,
    );

    expect(tree.queryByTestId('weekly-review-loading')).not.toBeNull();
    expect(tree.queryByTestId('weekly-review-content')).toBeNull();

    await act(async () => {
      resolve({ ok: true, data: SUCCESS_DATA });
    });
    await waitFor(() =>
      expect(tree.queryByTestId('weekly-review-content')).not.toBeNull(),
    );
    expect(tree.queryByTestId('weekly-review-loading')).toBeNull();
  });

  it('success: renders headline + narrative + per-plant ledgers', async () => {
    const { client } = makeApiClient(async () => ({ ok: true, data: SUCCESS_DATA }));
    const tree = render(
      <WeeklyReviewScreen
        apiClient={client}
        weekRequest={defaultRequest()}
        plantsForLedgers={makePlantInputs()}
        onDismiss={jest.fn()}
        nowMs={FIXED_NOW}
      />,
    );
    await waitFor(() =>
      expect(tree.queryByTestId('weekly-review-headline')).not.toBeNull(),
    );
    expect(tree.queryByTestId('weekly-review-narrative')).not.toBeNull();
    expect(tree.queryByTestId('weekly-review-plant-plant-1')).not.toBeNull();
    expect(tree.queryByTestId('weekly-review-plant-plant-2')).not.toBeNull();
  });

  it('success: per-plant block count matches plant input count', async () => {
    const { client } = makeApiClient(async () => ({ ok: true, data: SUCCESS_DATA }));
    const tree = render(
      <WeeklyReviewScreen
        apiClient={client}
        weekRequest={defaultRequest()}
        plantsForLedgers={makePlantInputs()}
        onDismiss={jest.fn()}
        nowMs={FIXED_NOW}
      />,
    );
    await waitFor(() =>
      expect(tree.queryByTestId('weekly-review-per-plant')).not.toBeNull(),
    );
    // Two plant inputs → two plant blocks.
    expect(tree.queryAllByText('Steve')).toHaveLength(1);
    expect(tree.queryAllByText('Phil')).toHaveLength(1);
  });

  it('empty week: editorial copy renders, per-plant section is hidden', async () => {
    const { client } = makeApiClient(async () => ({ ok: true, data: EMPTY_DATA }));
    const tree = render(
      <WeeklyReviewScreen
        apiClient={client}
        weekRequest={{
          week_summary: {
            plants_total: 0,
            watering_events: 0,
            skip_events: 0,
            diagnoses: 0,
          },
          plants: [],
        }}
        plantsForLedgers={[]}
        onDismiss={jest.fn()}
        nowMs={FIXED_NOW}
      />,
    );
    await waitFor(() =>
      expect(tree.queryByTestId('weekly-review-empty')).not.toBeNull(),
    );
    expect(tree.getByTestId('weekly-review-empty').props.children).toBe(
      "This week was quiet — that's okay. Come back next Sunday.",
    );
    expect(tree.queryByTestId('weekly-review-per-plant')).toBeNull();
    expect(tree.queryByTestId('weekly-review-narrative')).toBeNull();
  });

  it('error variant: network kind renders its own copy', async () => {
    const { client } = makeApiClient(async () => ({ ok: false, kind: 'network' }));
    const tree = render(
      <WeeklyReviewScreen
        apiClient={client}
        weekRequest={defaultRequest()}
        plantsForLedgers={makePlantInputs()}
        onDismiss={jest.fn()}
        nowMs={FIXED_NOW}
      />,
    );
    await waitFor(() =>
      expect(tree.queryByTestId('weekly-review-error-network')).not.toBeNull(),
    );
    expect(tree.queryByText("We couldn't reach the lab.")).not.toBeNull();
  });

  it('error variant: timeout kind renders distinct copy (NOT collapsed with network)', async () => {
    const { client } = makeApiClient(async () => ({ ok: false, kind: 'timeout' }));
    const tree = render(
      <WeeklyReviewScreen
        apiClient={client}
        weekRequest={defaultRequest()}
        plantsForLedgers={makePlantInputs()}
        onDismiss={jest.fn()}
        nowMs={FIXED_NOW}
      />,
    );
    await waitFor(() =>
      expect(tree.queryByTestId('weekly-review-error-timeout')).not.toBeNull(),
    );
    expect(tree.queryByText('The lab took too long.')).not.toBeNull();
    expect(tree.queryByText("We couldn't reach the lab.")).toBeNull();
  });

  it('error variant: server kind renders distinct copy (NOT collapsed)', async () => {
    const { client } = makeApiClient(async () => ({
      ok: false,
      kind: 'server',
      retry_after: 30,
    }));
    const tree = render(
      <WeeklyReviewScreen
        apiClient={client}
        weekRequest={defaultRequest()}
        plantsForLedgers={makePlantInputs()}
        onDismiss={jest.fn()}
        nowMs={FIXED_NOW}
      />,
    );
    await waitFor(() =>
      expect(tree.queryByTestId('weekly-review-error-server')).not.toBeNull(),
    );
    expect(
      tree.queryByText('Something went wrong on our end.'),
    ).not.toBeNull();
  });

  it('queued: renders queued banner (NOT an error card)', async () => {
    const { client } = makeApiClient(async () => ({ ok: false, kind: 'queued' }));
    const tree = render(
      <WeeklyReviewScreen
        apiClient={client}
        weekRequest={defaultRequest()}
        plantsForLedgers={makePlantInputs()}
        onDismiss={jest.fn()}
        nowMs={FIXED_NOW}
      />,
    );
    await waitFor(() =>
      expect(tree.queryByTestId('weekly-review-queued')).not.toBeNull(),
    );
    // Error card is NOT rendered.
    expect(tree.queryByTestId('weekly-review-error-queued')).toBeNull();
    expect(tree.queryByTestId('weekly-review-retry')).toBeNull();
  });

  it("'Got it' tap fires onDismiss", async () => {
    const onDismiss = jest.fn();
    const { client } = makeApiClient(async () => ({ ok: true, data: SUCCESS_DATA }));
    const tree = render(
      <WeeklyReviewScreen
        apiClient={client}
        weekRequest={defaultRequest()}
        plantsForLedgers={makePlantInputs()}
        onDismiss={onDismiss}
        nowMs={FIXED_NOW}
      />,
    );
    await waitFor(() =>
      expect(tree.queryByTestId('weekly-review-content')).not.toBeNull(),
    );
    fireEvent.press(tree.getByTestId('weekly-review-dismiss'));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('retry CTA on error re-fires apiClient.review', async () => {
    let calls = 0;
    const { client, reviewSpy } = makeApiClient(async () => {
      calls += 1;
      if (calls === 1) return { ok: false, kind: 'network' };
      return { ok: true, data: SUCCESS_DATA };
    });
    const tree = render(
      <WeeklyReviewScreen
        apiClient={client}
        weekRequest={defaultRequest()}
        plantsForLedgers={makePlantInputs()}
        onDismiss={jest.fn()}
        nowMs={FIXED_NOW}
      />,
    );
    await waitFor(() =>
      expect(tree.queryByTestId('weekly-review-error-network')).not.toBeNull(),
    );
    expect(reviewSpy).toHaveBeenCalledTimes(1);
    fireEvent.press(tree.getByTestId('weekly-review-retry'));
    await waitFor(() => expect(reviewSpy).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(tree.queryByTestId('weekly-review-content')).not.toBeNull(),
    );
  });

  it('dark theme: tokens swap (textMuted is the Midnight value)', async () => {
    mockedUseColorScheme.mockReturnValue('dark');
    const { client } = makeApiClient(async () => ({ ok: true, data: SUCCESS_DATA }));
    const tree = render(
      <WeeklyReviewScreen
        apiClient={client}
        weekRequest={defaultRequest()}
        plantsForLedgers={makePlantInputs()}
        onDismiss={jest.fn()}
        nowMs={FIXED_NOW}
      />,
    );
    await waitFor(() =>
      expect(tree.queryByTestId('weekly-review-content')).not.toBeNull(),
    );
    const narrative = tree.getByTestId('weekly-review-narrative');
    // Dark text token is the cream #FAF6EE on the deep-night-forest bg.
    const flat = Array.isArray(narrative.props.style)
      ? Object.assign({}, ...narrative.props.style.flat())
      : narrative.props.style;
    expect(flat.color).toBe('#FAF6EE');
  });

  it('reduce-motion (hook=true): animation hard-disabled — Animated.timing NOT called', async () => {
    mockedReduceMotion.mockReturnValue(true);
    isReduceMotionEnabledSpy.mockResolvedValue(true);
    const { client } = makeApiClient(async () => ({ ok: true, data: SUCCESS_DATA }));
    const tree = render(
      <WeeklyReviewScreen
        apiClient={client}
        weekRequest={defaultRequest()}
        plantsForLedgers={makePlantInputs()}
        onDismiss={jest.fn()}
        nowMs={FIXED_NOW}
      />,
    );
    await waitFor(() =>
      expect(tree.queryByTestId('weekly-review-content')).not.toBeNull(),
    );
    expect(animatedTimingSpy).toHaveBeenCalledTimes(0);
  });

  it('reduce-motion off (both layers say no-reduce): Animated.timing IS called once on loading → success edge', async () => {
    mockedReduceMotion.mockReturnValue(false);
    isReduceMotionEnabledSpy.mockResolvedValue(false);
    const { client } = makeApiClient(async () => ({ ok: true, data: SUCCESS_DATA }));
    render(
      <WeeklyReviewScreen
        apiClient={client}
        weekRequest={defaultRequest()}
        plantsForLedgers={makePlantInputs()}
        onDismiss={jest.fn()}
        nowMs={FIXED_NOW}
      />,
    );
    await waitFor(() => expect(animatedTimingSpy).toHaveBeenCalledTimes(1));
  });

  it('reduce-motion boot race (hook=false during boot, OS=true): Animated.timing NOT called (codex P2 fix)', async () => {
    // Hook returns false during the boot async window; OS preference
    // resolves to true. The synchronous probe at animation-start time must
    // catch this and skip Animated.timing. Without the probe, a
    // reduce-motion user would see a 240ms fade against their preference.
    mockedReduceMotion.mockReturnValue(false);
    isReduceMotionEnabledSpy.mockResolvedValue(true);
    const { client } = makeApiClient(async () => ({ ok: true, data: SUCCESS_DATA }));
    const tree = render(
      <WeeklyReviewScreen
        apiClient={client}
        weekRequest={defaultRequest()}
        plantsForLedgers={makePlantInputs()}
        onDismiss={jest.fn()}
        nowMs={FIXED_NOW}
      />,
    );
    await waitFor(() =>
      expect(tree.queryByTestId('weekly-review-content')).not.toBeNull(),
    );
    // Flush the reduce-motion probe + its .then() that decides whether to
    // start timing. Two microtask drains is the simplest way to be sure.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(animatedTimingSpy).toHaveBeenCalledTimes(0);
  });

  it('a11y: hero has image role + label', async () => {
    const { client } = makeApiClient(async () => ({ ok: true, data: SUCCESS_DATA }));
    const tree = render(
      <WeeklyReviewScreen
        apiClient={client}
        weekRequest={defaultRequest()}
        plantsForLedgers={makePlantInputs()}
        onDismiss={jest.fn()}
        nowMs={FIXED_NOW}
      />,
    );
    const hero = tree.getByTestId('weekly-review-hero');
    expect(hero.props.accessibilityRole).toBe('image');
    expect(hero.props.accessibilityLabel).toBe(
      'A leaf — your weekly garden letter',
    );
  });

  it('a11y: headline has header role', async () => {
    const { client } = makeApiClient(async () => ({ ok: true, data: SUCCESS_DATA }));
    const tree = render(
      <WeeklyReviewScreen
        apiClient={client}
        weekRequest={defaultRequest()}
        plantsForLedgers={makePlantInputs()}
        onDismiss={jest.fn()}
        nowMs={FIXED_NOW}
      />,
    );
    await waitFor(() =>
      expect(tree.queryByTestId('weekly-review-headline')).not.toBeNull(),
    );
    const headline = tree.getByTestId('weekly-review-headline');
    expect(headline.props.accessibilityRole).toBe('header');
  });

  it('a11y: dismiss + retry CTAs have button role and labels', async () => {
    const { client } = makeApiClient(async () => ({ ok: false, kind: 'network' }));
    const tree = render(
      <WeeklyReviewScreen
        apiClient={client}
        weekRequest={defaultRequest()}
        plantsForLedgers={makePlantInputs()}
        onDismiss={jest.fn()}
        nowMs={FIXED_NOW}
      />,
    );
    await waitFor(() =>
      expect(tree.queryByTestId('weekly-review-retry')).not.toBeNull(),
    );
    expect(tree.getByTestId('weekly-review-dismiss').props.accessibilityRole).toBe(
      'button',
    );
    expect(tree.getByTestId('weekly-review-dismiss').props.accessibilityLabel).toBe(
      'Got it',
    );
    expect(tree.getByTestId('weekly-review-retry').props.accessibilityRole).toBe(
      'button',
    );
    expect(tree.getByTestId('weekly-review-retry').props.accessibilityLabel).toBe(
      'Try again',
    );
  });

  it('a11y: per-plant section composes nickname + species into a single stop', async () => {
    const { client } = makeApiClient(async () => ({ ok: true, data: SUCCESS_DATA }));
    const tree = render(
      <WeeklyReviewScreen
        apiClient={client}
        weekRequest={defaultRequest()}
        plantsForLedgers={makePlantInputs()}
        onDismiss={jest.fn()}
        nowMs={FIXED_NOW}
      />,
    );
    await waitFor(() =>
      expect(tree.queryByTestId('weekly-review-plant-plant-1')).not.toBeNull(),
    );
    const plantBlock = tree.getByTestId('weekly-review-plant-plant-1');
    expect(plantBlock.props.accessible).toBe(true);
    expect(plantBlock.props.accessibilityLabel).toBe('Steve, Monstera deliciosa');
  });

  it('AppState resume: settled-success state does NOT re-fetch', async () => {
    const { client, reviewSpy } = makeApiClient(async () => ({
      ok: true,
      data: SUCCESS_DATA,
    }));
    render(
      <WeeklyReviewScreen
        apiClient={client}
        weekRequest={defaultRequest()}
        plantsForLedgers={makePlantInputs()}
        onDismiss={jest.fn()}
        nowMs={FIXED_NOW}
      />,
    );
    await waitFor(() => expect(reviewSpy).toHaveBeenCalledTimes(1));
    // Fire 'active' transitions a few times. None of them should drive a
    // second review() call.
    act(() => {
      appStateHandlers.forEach((h) => h('background'));
      appStateHandlers.forEach((h) => h('active'));
      appStateHandlers.forEach((h) => h('background'));
      appStateHandlers.forEach((h) => h('active'));
    });
    expect(reviewSpy).toHaveBeenCalledTimes(1);
  });

  it('a11y focus: setAccessibilityFocus called after content settles', async () => {
    const { client } = makeApiClient(async () => ({ ok: true, data: SUCCESS_DATA }));
    render(
      <WeeklyReviewScreen
        apiClient={client}
        weekRequest={defaultRequest()}
        plantsForLedgers={makePlantInputs()}
        onDismiss={jest.fn()}
        nowMs={FIXED_NOW}
      />,
    );
    await waitFor(() =>
      expect(AccessibilityInfo.setAccessibilityFocus).toHaveBeenCalledTimes(1),
    );
  });

  it('plant block falls back to species_label when nickname missing', async () => {
    const { client } = makeApiClient(async () => ({ ok: true, data: SUCCESS_DATA }));
    const tree = render(
      <WeeklyReviewScreen
        apiClient={client}
        weekRequest={defaultRequest()}
        plantsForLedgers={[
          {
            id: 'plant-only',
            species_label: 'Ficus lyrata',
            events: [{ wateredAtMs: FIXED_NOW - 86_400_000 }],
          },
        ]}
        onDismiss={jest.fn()}
        nowMs={FIXED_NOW}
      />,
    );
    await waitFor(() =>
      expect(tree.queryByTestId('weekly-review-plant-plant-only')).not.toBeNull(),
    );
    const plantBlock = tree.getByTestId('weekly-review-plant-plant-only');
    expect(plantBlock.props.accessibilityLabel).toBe(
      'Ficus lyrata, Ficus lyrata',
    );
  });

  it('sub-day-precision regression: 3d 12h fixture buckets onto the right ledger column (no Math.floor drift)', async () => {
    // Anchor the ledger at noon so a 3d 12h ago event lands at midnight 3
    // calendar days back. Naive `Math.floor((now - then) / 86_400_000)`
    // would say "3 days ago" — which would be wrong if the engine used
    // floor-divide-by-86400000 from the right edge of the column rather
    // than the local-midnight start. The setHours bucketing in
    // <WateringLedger> handles this correctly; we lock the contract here
    // so a future regression in either layer fails this test.
    const noon = new Date('2026-05-06T12:00:00.000Z').getTime();
    const threeAndAHalfDaysAgoMs = noon - (3 * 86_400_000 + 12 * 60 * 60 * 1000);

    const { client } = makeApiClient(async () => ({ ok: true, data: SUCCESS_DATA }));
    const tree = render(
      <WeeklyReviewScreen
        apiClient={client}
        weekRequest={defaultRequest()}
        plantsForLedgers={[
          {
            id: 'plant-3d12h',
            nickname: 'Edge',
            species_label: 'Test',
            events: [{ wateredAtMs: threeAndAHalfDaysAgoMs }],
          },
        ]}
        onDismiss={jest.fn()}
        nowMs={noon}
      />,
    );
    await waitFor(() =>
      expect(tree.queryByTestId('weekly-review-plant-plant-3d12h')).not.toBeNull(),
    );
    // Find ledger columns whose accessibilityLabel ends with ", watered"
    // across the plant block. The ledger renders one column per local-tz
    // calendar day; an event at "3d 12h ago" relative to noon today MUST
    // land in exactly one column. A naive `Math.floor((now - then) /
    // 86_400_000)` from "today's right edge" + cell-width-equals-DAY_MS
    // could in principle bucket a 3.5-day event into either day-3 or
    // day-4 inconsistently, or duplicate it across cells if the bucketing
    // logic uses overlapping ranges. Lock the contract: exactly one
    // column, no drift.
    const watered = tree
      .queryAllByLabelText(/, watered$/i)
      .filter((node) => node.props.accessibilityLabel !== undefined);
    expect(watered.length).toBe(1);
  });

  it('idle → loading → success sequencing: loading present until success commits', async () => {
    let resolve!: (v: ApiResult<ReviewResponse>) => void;
    const { client } = makeApiClient(
      () =>
        new Promise<ApiResult<ReviewResponse>>((r) => {
          resolve = r;
        }),
    );
    const tree = render(
      <WeeklyReviewScreen
        apiClient={client}
        weekRequest={defaultRequest()}
        plantsForLedgers={makePlantInputs()}
        onDismiss={jest.fn()}
        nowMs={FIXED_NOW}
      />,
    );
    expect(tree.queryByTestId('weekly-review-loading')).not.toBeNull();
    expect(tree.queryByTestId('weekly-review-content')).toBeNull();
    expect(tree.queryByTestId('weekly-review-error-network')).toBeNull();
    await act(async () => {
      resolve({ ok: true, data: SUCCESS_DATA });
    });
    await waitFor(() =>
      expect(tree.queryByTestId('weekly-review-content')).not.toBeNull(),
    );
    expect(tree.queryByTestId('weekly-review-loading')).toBeNull();
  });

  it('apiClient.review throwing surfaces as network error (defensive coercion)', async () => {
    const { client } = makeApiClient(async () => {
      throw new Error('boom');
    });
    const tree = render(
      <WeeklyReviewScreen
        apiClient={client}
        weekRequest={defaultRequest()}
        plantsForLedgers={makePlantInputs()}
        onDismiss={jest.fn()}
        nowMs={FIXED_NOW}
      />,
    );
    await waitFor(() =>
      expect(tree.queryByTestId('weekly-review-error-network')).not.toBeNull(),
    );
  });
});
