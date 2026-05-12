/**
 * E11-004 — Reduce-motion compliance audit.
 *
 * Sweeps every component + screen in the mobile app that owns an
 * `Animated.timing` / `Animated.spring` / `Animated.loop` call site and
 * asserts that with reduce-motion ON, mounting the surface produces ZERO
 * Animated.* invocations across (a) the initial render frame and (b) any
 * representative user interaction the surface exposes.
 *
 * # Why a call-count assertion, not just an end-state assertion
 *
 * The vestibular-disorder compliance contract is structural: a
 * `duration: 0` timing call is NOT compliant. The Animated.* call itself
 * is the bug class — it can still allocate, schedule a frame, and (under
 * some RN driver paths) paint a partial value before the end-state lands.
 * The audit-defensible standard is "the call is never fired" — same rule
 * the v0.1.55.0 E9-005 P3 lesson + the v0.1.59.0 E3-005 PlantsListScreen
 * call-count test established. This sweep pins that contract for the
 * whole tree.
 *
 * # Why a tree-walker / spy, not per-component asserts
 *
 * Per-component reduce-motion tests already exist (DiagnoseLoadingState,
 * FABPopover, ToastBanner, SundayLetterCard, WeeklyReviewScreen,
 * CameraResultScreen, EditorialBottomSheet, PlantsListScreen,
 * PlantDetailScreen). They catch first-mount drift on the surface
 * the author remembered to test. This sweep catches the cross-cutting
 * regression — any future Animated call that ships ungated, OR any
 * existing gate that quietly inverts during refactor, surfaces here
 * with the surface name + call argv attached.
 *
 * # Three-layer coverage
 *
 * The `useReduceMotion()` hook returns false synchronously for the brief
 * window before `AccessibilityInfo.isReduceMotionEnabled()` resolves
 * (documented in `useReduceMotion.ts`). The v0.1.55.0 E9-005 P3 + the
 * FABPopover P1 fixes layered a synchronous OS-probe at the start-edge
 * to close that window. The audit runs three sweeps:
 *
 *   1. STEADY-STATE: hook=true synchronously AND OS probe resolves true.
 *      This is the long-tail steady state — both gates honor reduce-motion.
 *      Any production gate that fires Animated.* here is a clear regression.
 *
 *   2. ASYNC-WINDOW HAZARD (boot race): hook=false synchronously AND OS
 *      probe resolves true. A hook-only-gated call site fires Animated.*
 *      on first paint before the probe resolves — the audit catches it.
 *      Compliance requires either (a) a synchronous OS-probe at start-edge
 *      (FABPopover / WeeklyReviewScreen pattern), OR (b) init-at-end-state
 *      so no Animated.* call is needed (DiagnoseLoadingState pattern).
 *
 *   3. INTERACTION COVERAGE: gesture-triggered Animated.spring (sheet
 *      drag-release snap-back) and button-triggered animations. The
 *      mount-only sweeps miss these — the gate fires inside a callback
 *      that mount never runs.
 *
 * # V1 scope lock
 *
 * No new test runner / library — jest + RTL only. The list of surfaces
 * mirrors the touch-target / dynamic-type audits' surface set — the
 * primitives + cards that render standalone without needing a navigation
 * stack, DB, or API client. Screen-level surfaces with their own
 * Animated calls (WeeklyReviewScreen, CameraResultScreen) are covered
 * by their own per-screen reduce-motion tests (see file header refs).
 * CameraView is omitted — it requires expo-camera permission + ref
 * plumbing and its `if (reduceMotion) return;` press-gate is covered by
 * CameraView's own test.
 */

import { lightTheme } from '@plantcare/theme';
import { act, render, fireEvent } from '@testing-library/react-native';
import React, { type ReactElement } from 'react';
import { AccessibilityInfo, Animated } from 'react-native';

// ─── PanResponder capture for interaction-coverage tests ────────────────
// EditorialBottomSheet's snap-back Animated.spring fires from inside the
// PanResponder.onPanResponderRelease handler — i.e. ONLY during a drag-
// release interaction, never on mount. The audit captures the responder
// config via a module mock so the interaction tests can simulate the drag
// release directly. Mirrors the pattern in
// `components/primitives/__tests__/EditorialBottomSheet.gestures.test.tsx`.
type PanConfig = {
  onStartShouldSetPanResponder: () => boolean;
  onMoveShouldSetPanResponder: (
    evt: unknown,
    gestureState: { dy: number; dx: number },
  ) => boolean;
  onPanResponderMove: (
    evt: unknown,
    gestureState: { dy: number; dx: number },
  ) => void;
  onPanResponderRelease: (
    evt: unknown,
    gestureState: { dy: number; dx: number },
  ) => void;
  onPanResponderTerminate: () => void;
};
const mockCapturedPanConfigs: PanConfig[] = [];
jest.mock('react-native/Libraries/Interaction/PanResponder', () => ({
  __esModule: true,
  default: {
    create: (config: PanConfig) => {
      mockCapturedPanConfigs.push(config);
      return { panHandlers: {} };
    },
  },
}));

import { DiagnoseLoadingState } from '../components/DiagnoseLoadingState';
import { QueueRetryBanner } from '../components/QueueRetryBanner';
import { SundayLetterCard } from '../components/SundayLetterCard';
import { EditorialBottomSheet } from '../components/primitives/EditorialBottomSheet';
import { FABPopover } from '../components/primitives/FABPopover';
import { ToastBanner } from '../components/primitives/ToastBanner';

// ─── Mocks ──────────────────────────────────────────────────────────────

jest.mock('../hooks/useTheme', () => ({
  useTheme: jest.fn(),
}));
jest.mock('../hooks/useReduceMotion', () => ({
  useReduceMotion: jest.fn(),
}));

import { useTheme } from '../hooks/useTheme';
import { useReduceMotion } from '../hooks/useReduceMotion';

const mockedUseTheme = useTheme as jest.MockedFunction<typeof useTheme>;
const mockedUseReduceMotion = useReduceMotion as jest.MockedFunction<
  typeof useReduceMotion
>;

beforeEach(() => {
  mockedUseTheme.mockReturnValue(lightTheme);
  // Both reduce-motion layers ON. The hook returns true synchronously;
  // the OS probe resolves true on the next microtask. Either one alone
  // would let one call site slip past the audit — the FABPopover &
  // WeeklyReviewScreen P1 fixes only fire the timing call if BOTH say
  // motion is allowed, so we mock BOTH to true to confirm the gate
  // holds across the resolve edge.
  mockedUseReduceMotion.mockReturnValue(true);
  jest
    .spyOn(AccessibilityInfo, 'isReduceMotionEnabled')
    .mockResolvedValue(true);
  // Stub the event-listener subscription so subscribing components don't
  // throw under the test harness. We never fire a change event during the
  // audit — reduce-motion stays ON for the entire surface lifetime.
  jest.spyOn(AccessibilityInfo, 'addEventListener').mockImplementation(
    () => ({ remove: jest.fn() }) as never,
  );
  mockCapturedPanConfigs.length = 0;
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ─── Surface factories ──────────────────────────────────────────────────

// Pin a Sunday so SundayLetterCard renders rather than early-returning null.
const SUNDAY_NOW = new Date(2026, 4, 10, 12, 0, 0).getTime();

type Surface = {
  /** Display name used in failure messages. */
  readonly name: string;
  /** Render the surface in its initial mounted state. */
  readonly render: () => ReactElement;
  /**
   * Optional second-step interaction the surface exposes. Used to confirm
   * the reduce-motion gate holds across both mount AND a representative
   * user action — e.g. SundayLetterCard's onPress (would normally fire
   * the fade-in if it lived behind a state edge; here we just confirm
   * mount-time covers it).
   */
  readonly interact?: (api: ReturnType<typeof render>) => void;
};

const SURFACES: readonly Surface[] = [
  {
    name: 'DiagnoseLoadingState (bucket 0)',
    render: () => (
      <DiagnoseLoadingState
        startedAtMs={SUNDAY_NOW}
        nowMs={SUNDAY_NOW + 1000}
      />
    ),
  },
  {
    name: 'DiagnoseLoadingState (bucket 2, 20s+)',
    render: () => (
      <DiagnoseLoadingState
        startedAtMs={SUNDAY_NOW}
        nowMs={SUNDAY_NOW + 25_000}
      />
    ),
  },
  {
    name: 'ToastBanner pending (pulse target)',
    render: () => (
      <ToastBanner type="pending" message="Saved offline" onRetry={() => {}} />
    ),
  },
  {
    name: 'ToastBanner warn',
    render: () => (
      <ToastBanner
        type="warn"
        message="Couldn't save"
        action={{ label: 'Retry', onPress: () => {} }}
      />
    ),
  },
  {
    name: 'ToastBanner info',
    render: () => <ToastBanner type="info" message="Day-one tip" />,
  },
  {
    name: 'QueueRetryBanner',
    render: () => <QueueRetryBanner failedCount={3} onRetry={() => {}} />,
  },
  {
    name: 'FABPopover (open)',
    render: () => (
      <FABPopover
        open
        onDismiss={() => {}}
        onAddPlant={() => {}}
        onQuickDiagnose={() => {}}
      />
    ),
  },
  {
    name: 'SundayLetterCard',
    render: () => (
      <SundayLetterCard
        onOpen={() => {}}
        onDismiss={() => {}}
        nowMs={SUNDAY_NOW}
      />
    ),
  },
  {
    name: 'EditorialBottomSheet (open)',
    render: () => (
      <EditorialBottomSheet open onDismiss={() => {}}>
        <></>
      </EditorialBottomSheet>
    ),
  },
];

// ─── Tests ──────────────────────────────────────────────────────────────

describe('E11-004 reduce-motion compliance audit (zero Animated.* on mount)', () => {
  it.each(SURFACES.map((s) => [s.name, s] as const))(
    '%s fires zero Animated.timing / spring / loop calls with reduce-motion ON',
    async (_name, surface) => {
      const timingSpy = jest.spyOn(Animated, 'timing');
      const springSpy = jest.spyOn(Animated, 'spring');
      const loopSpy = jest.spyOn(Animated, 'loop');

      const api = render(surface.render());

      // Flush microtasks so the synchronous OS-probe resolves. The probe
      // is the second-line defense behind `useReduceMotion()`; this is
      // where the FABPopover / WeeklyReviewScreen pattern would fire
      // timing if it had a regression. Two cycles cover then-chains.
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      // Optional interaction step — only fires when the surface declares
      // one. Used to extend coverage beyond first-mount where useful.
      if (surface.interact) {
        await act(async () => {
          surface.interact?.(api);
          await Promise.resolve();
          await Promise.resolve();
        });
      }

      const fmt = (calls: unknown[][]): string =>
        calls
          .map((c, i) => `    [${i}] argv=${JSON.stringify(c).slice(0, 200)}`)
          .join('\n');

      if (timingSpy.mock.calls.length > 0) {
        throw new Error(
          `Animated.timing fired ${timingSpy.mock.calls.length}× in ${surface.name} ` +
            `under reduce-motion. Expected ZERO — gate the call site behind ` +
            `useReduceMotion() OR an AccessibilityInfo.isReduceMotionEnabled() ` +
            `probe. Calls:\n${fmt(timingSpy.mock.calls)}`,
        );
      }
      if (springSpy.mock.calls.length > 0) {
        throw new Error(
          `Animated.spring fired ${springSpy.mock.calls.length}× in ${surface.name} ` +
            `under reduce-motion. Expected ZERO. Calls:\n${fmt(springSpy.mock.calls)}`,
        );
      }
      if (loopSpy.mock.calls.length > 0) {
        throw new Error(
          `Animated.loop fired ${loopSpy.mock.calls.length}× in ${surface.name} ` +
            `under reduce-motion. Expected ZERO. Calls:\n${fmt(loopSpy.mock.calls)}`,
        );
      }

      api.unmount();
    },
  );

  it('useReduceMotion hook is the canonical gate (sanity)', () => {
    // Doc test — pins the hook name so a future "let's rename to
    // useMotionPref" rename surfaces here as an explicit failure rather
    // than as a per-surface silent regression.
    expect(typeof useReduceMotion).toBe('function');
  });

  it('SundayLetterCard fade-in does NOT fire under reduce-motion (mount-edge regression pin)', async () => {
    const timingSpy = jest.spyOn(Animated, 'timing');
    render(
      <SundayLetterCard
        onOpen={() => {}}
        onDismiss={() => {}}
        nowMs={SUNDAY_NOW}
      />,
    );
    // Flush both the initial commit and the inner-component useEffect chain.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(timingSpy).not.toHaveBeenCalled();
  });

  it('FABPopover OS-probe path does NOT fire timing even when hook says false but OS says true', async () => {
    // Boot-window race: hook returns false synchronously, OS probe
    // eventually resolves true. The FABPopover P1 fix gates the timing
    // call on the probe result; this assertion pins that contract — if
    // someone refactors the probe out, the gate breaks and this fails.
    mockedUseReduceMotion.mockReturnValue(false);
    // OS probe already mocked to resolve true in beforeEach.
    const timingSpy = jest.spyOn(Animated, 'timing');

    const api = render(
      <FABPopover
        open
        onDismiss={() => {}}
        onAddPlant={() => {}}
        onQuickDiagnose={() => {}}
      />,
    );
    // Flush the probe promise — this is where a hook-only-gate would fire.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(timingSpy).not.toHaveBeenCalled();
    api.unmount();
  });

  it('FABPopover item press under reduce-motion does NOT fire spring/timing for state change', async () => {
    // The FABPopover item onPress should not kick off any new animation
    // when reduce-motion is on. The dismissal path uses Modal's
    // animationType which we don't drive through Animated; the audit
    // covers the explicit Animated.* surface.
    const timingSpy = jest.spyOn(Animated, 'timing');
    const springSpy = jest.spyOn(Animated, 'spring');

    const api = render(
      <FABPopover
        open
        onDismiss={() => {}}
        onAddPlant={() => {}}
        onQuickDiagnose={() => {}}
      />,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    timingSpy.mockClear();
    springSpy.mockClear();
    // Press the "Add a plant" item. Under reduce-motion this must not
    // kick off any animation.
    const item = api.queryByTestId('fab-popover-item-add');
    if (item != null) {
      await act(async () => {
        fireEvent.press(item);
        await Promise.resolve();
      });
    }
    expect(timingSpy).not.toHaveBeenCalled();
    expect(springSpy).not.toHaveBeenCalled();
    api.unmount();
  });

  // ─── Async-window sweep (codex P2 from E11-004 review) ────────────────
  // The main sweep mocks the hook to return true synchronously — a hook-
  // only-gated mount animation would slip past because the gate fires
  // immediately. The real `useReduceMotion()` returns FALSE for the brief
  // window before AccessibilityInfo.isReduceMotionEnabled() resolves
  // (see useReduceMotion.ts:14). This second sweep simulates that boot
  // window: hook=false, OS probe pending. Any production gate that only
  // checks the hook value would fire here. We then resolve the probe to
  // true and re-assert zero calls — the post-resolve render pass should
  // not retroactively start an animation either.
  describe('async-window hazard (boot window: hook=false, OS=true)', () => {
    it.each(SURFACES.map((s) => [s.name, s] as const))(
      '%s: zero Animated.* across hook=false → OS=true resolution',
      async (_name, surface) => {
        // Hook returns false (boot window). OS probe resolves true on next
        // microtask — the same race the FABPopover / WeeklyReviewScreen
        // P1 fixes guard against.
        mockedUseReduceMotion.mockReturnValue(false);

        const timingSpy = jest.spyOn(Animated, 'timing');
        const springSpy = jest.spyOn(Animated, 'spring');
        const loopSpy = jest.spyOn(Animated, 'loop');

        const api = render(surface.render());

        // Flush the OS probe + any follow-up render commits.
        await act(async () => {
          await Promise.resolve();
          await Promise.resolve();
          await Promise.resolve();
        });

        const fmt = (calls: unknown[][]): string =>
          calls
            .map((c, i) => `    [${i}] argv=${JSON.stringify(c).slice(0, 200)}`)
            .join('\n');

        // We allow either:
        //   (a) zero calls — fully audit-compliant; OR
        //   (b) calls that happen ONLY in the boot window with a
        //       hook-only-gate, in which case the surface needs the
        //       FABPopover-style synchronous OS-probe pattern.
        // The assertion is strict: zero. This catches a real bug class
        // (hook-only-gate firing the first paint before the probe
        // resolves). Surfaces that init their Animated.Value at the end
        // state (DiagnoseLoadingState dots at STATIC_DOT_OPACITY,
        // SundayLetterCard opacity at 1, ToastBanner pulse at end-state)
        // satisfy the sweep without needing the probe — that init-at-end
        // pattern is the alternative compliance path.
        if (timingSpy.mock.calls.length > 0) {
          throw new Error(
            `Async-window hazard: Animated.timing fired ${timingSpy.mock.calls.length}× ` +
              `in ${surface.name} during hook=false → OS=true window. The gate ` +
              `must either (a) probe AccessibilityInfo.isReduceMotionEnabled() ` +
              `synchronously before starting timing (FABPopover pattern), or ` +
              `(b) initialize the Animated.Value at end-state so no Animated.* ` +
              `call fires (DiagnoseLoadingState pattern). Calls:\n${fmt(timingSpy.mock.calls)}`,
          );
        }
        if (springSpy.mock.calls.length > 0) {
          throw new Error(
            `Async-window hazard: Animated.spring fired ${springSpy.mock.calls.length}× ` +
              `in ${surface.name} during hook=false → OS=true window. ` +
              `Calls:\n${fmt(springSpy.mock.calls)}`,
          );
        }
        if (loopSpy.mock.calls.length > 0) {
          throw new Error(
            `Async-window hazard: Animated.loop fired ${loopSpy.mock.calls.length}× ` +
              `in ${surface.name} during hook=false → OS=true window. ` +
              `Calls:\n${fmt(loopSpy.mock.calls)}`,
          );
        }

        api.unmount();
      },
    );
  });

  // ─── Interaction coverage (codex P2 from E11-004 review) ──────────────
  // Mount-only coverage misses Animated calls that fire ONLY during a
  // user gesture. The EditorialBottomSheet snap-back Animated.spring is
  // the canonical case — it fires from inside the PanResponder release
  // handler, not on mount. CameraView's shutter-press Animated.spring is
  // analogous but lives in a useCallback closure gated by `reduceMotion`.
  // The audit must exercise the gesture path with reduce-motion ON and
  // confirm zero Animated.* calls.
  describe('interaction coverage (drag release, button press)', () => {
    it('EditorialBottomSheet sub-threshold drag release fires ZERO Animated.spring under reduce-motion', async () => {
      const timingSpy = jest.spyOn(Animated, 'timing');
      const springSpy = jest.spyOn(Animated, 'spring');

      const api = render(
        <EditorialBottomSheet open onDismiss={() => {}}>
          <></>
        </EditorialBottomSheet>,
      );

      // Drain the post-mount isReduceMotionEnabled() promise so the
      // component's internal `reduceMotion` state flips to true before
      // the gesture release fires (the sheet uses inline
      // AccessibilityInfo.isReduceMotionEnabled, not the hook).
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      // Capture the PanResponder config installed at mount and simulate
      // a sub-threshold drag release. dy:40 is below the 100px floor
      // dismiss threshold (per shouldDismissOnDragRelease), so the
      // release goes down the snap-back branch — which is the branch
      // gated by reduceMotion. Under reduce-motion the snap-back must
      // use translateY.setValue(0) directly, NOT Animated.spring.
      const cfg =
        mockCapturedPanConfigs[mockCapturedPanConfigs.length - 1];
      expect(cfg).toBeDefined();

      act(() => {
        cfg!.onPanResponderRelease({}, { dy: 40, dx: 0 });
      });

      expect(timingSpy).not.toHaveBeenCalled();
      expect(springSpy).not.toHaveBeenCalled();

      api.unmount();
    });

    it('EditorialBottomSheet release with motion ALLOWED fires Animated.spring (counter-assertion: spy works)', async () => {
      // Counter-assertion: a passing reduce-motion-on test would be
      // meaningless if the spy never sees a spring at all. Confirm that
      // with reduce-motion OFF, the same drag-release DOES fire spring.
      // Without this guard, the "zero spring" assertion above could
      // silently pass even if the spy were misconfigured.
      mockedUseReduceMotion.mockReturnValue(false);
      (
        AccessibilityInfo.isReduceMotionEnabled as jest.Mock
      ).mockResolvedValue(false);

      const springSpy = jest.spyOn(Animated, 'spring');

      const api = render(
        <EditorialBottomSheet open onDismiss={() => {}}>
          <></>
        </EditorialBottomSheet>,
      );

      // Drain the post-mount probe so the component's reduceMotion stays
      // false (the probe resolved false).
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      const cfg =
        mockCapturedPanConfigs[mockCapturedPanConfigs.length - 1];
      expect(cfg).toBeDefined();

      act(() => {
        cfg!.onPanResponderRelease({}, { dy: 40, dx: 0 });
      });

      // Motion allowed → spring DOES fire. This is the live path the
      // reduce-motion path above must NOT take.
      expect(springSpy).toHaveBeenCalledTimes(1);

      api.unmount();
    });
  });
});
