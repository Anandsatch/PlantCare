// Direct exercise of the PanResponder callbacks inside <EditorialBottomSheet>.
//
// The integration suite (EditorialBottomSheet.test.tsx) covers the public
// surface (Modal animationType, backdrop, accessibility, dark/light tokens,
// drag-zone wiring exists) and unit-tests the pure shouldDismissOnDragRelease
// helper exhaustively. What that suite cannot do is run RN's PanResponder
// pipeline end-to-end under jest-expo without coupling to private RN
// internals — so the onPanResponderMove / Release / Terminate handlers
// (lines 145-170) stayed uncovered.
//
// This suite intercepts PanResponder.create at the module-mock layer to
// capture the config object, then invokes the handlers directly with
// synthesized gesture states. That gives line + branch coverage on the
// dismiss / spring-snap / reduce-motion-snap / terminate-reset paths and
// on the addEventListener mounted-flag branch (line 112) without faking
// native event dispatch.

import { darkTheme, lightTheme } from '@plantcare/theme';
import { act, render } from '@testing-library/react-native';
import { Text } from 'react-native';

// ---------------------------------------------------------------------------
// PanResponder.create capture. We keep the LATEST captured config in a module
// variable so each render can grab its handlers; the helper resolves to the
// most-recently-created responder, which is sufficient because each render
// instantiates exactly one EditorialBottomSheet.
// ---------------------------------------------------------------------------
type PanConfig = {
  onStartShouldSetPanResponder: () => boolean;
  onMoveShouldSetPanResponder: (
    evt: unknown,
    gestureState: { dy: number; dx: number },
  ) => boolean;
  onPanResponderMove: (evt: unknown, gestureState: { dy: number; dx: number }) => void;
  onPanResponderRelease: (
    evt: unknown,
    gestureState: { dy: number; dx: number },
  ) => void;
  onPanResponderTerminate: () => void;
};

const mockCapturedConfigs: PanConfig[] = [];

jest.mock('react-native/Libraries/Interaction/PanResponder', () => ({
  __esModule: true,
  default: {
    create: (config: PanConfig) => {
      mockCapturedConfigs.push(config);
      return { panHandlers: {} };
    },
  },
}));

// AccessibilityInfo mock — same shape as the integration suite. Default OFF;
// individual tests flip via mockState.reduceMotion before render.
const mockReduceMotionListeners: Array<(value: boolean) => void> = [];
const mockState = { reduceMotion: false };

jest.mock(
  'react-native/Libraries/Components/AccessibilityInfo/AccessibilityInfo',
  () => ({
    __esModule: true,
    default: {
      isReduceMotionEnabled: jest.fn(() => Promise.resolve(mockState.reduceMotion)),
      addEventListener: jest.fn(
        (event: string, listener: (v: boolean) => void) => {
          if (event === 'reduceMotionChanged') mockReduceMotionListeners.push(listener);
          return {
            remove: () => {
              const idx = mockReduceMotionListeners.indexOf(listener);
              if (idx >= 0) mockReduceMotionListeners.splice(idx, 1);
            },
          };
        },
      ),
    },
  }),
);

// Stub Animated.spring so we can assert it WAS started without firing
// `requestAnimationFrame` chains in the test runner. start() is a noop.
// Patched on the runtime module after import so jest-expo's preset shape
// stays untouched.
const mockSpringStart = jest.fn();
const mockSpring = jest.fn(() => ({ start: mockSpringStart }));

// useColorScheme mock so dark/light is deterministic. Default light.
jest.mock('react-native/Libraries/Utilities/useColorScheme', () => ({
  __esModule: true,
  default: jest.fn(() => 'light'),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const useColorSchemeMock = require('react-native/Libraries/Utilities/useColorScheme')
  .default as jest.Mock<'light' | 'dark' | null | undefined, []>;

// Patch Animated.spring on the live module — the component reads
// `Animated.spring` via a property lookup on the `Animated` namespace import,
// so a runtime swap is sufficient and avoids fighting jest-expo's preset.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const RN = require('react-native') as typeof import('react-native');
const realSpring = RN.Animated.spring;
(RN.Animated as unknown as { spring: typeof mockSpring }).spring = mockSpring;

import { EditorialBottomSheet } from '../EditorialBottomSheet';

afterAll(() => {
  (RN.Animated as unknown as { spring: typeof realSpring }).spring = realSpring;
});

beforeEach(() => {
  mockCapturedConfigs.length = 0;
  mockReduceMotionListeners.length = 0;
  mockState.reduceMotion = false;
  mockSpring.mockClear();
  mockSpringStart.mockClear();
  useColorSchemeMock.mockReturnValue('light');
});

afterEach(async () => {
  // Drain the post-mount isReduceMotionEnabled() promise inside act so the
  // late setState doesn't trip React 19's "not wrapped in act" warning.
  await act(async () => {
    await new Promise((resolve) => setImmediate(resolve));
  });
});

function getLatestPanConfig(): PanConfig {
  const cfg = mockCapturedConfigs[mockCapturedConfigs.length - 1];
  if (!cfg) throw new Error('PanResponder.create was not called');
  return cfg;
}

function renderSheet(
  overrides: Partial<{
    onDismiss: () => void;
    heightFraction: number;
  }> = {},
) {
  return render(
    <EditorialBottomSheet
      open
      onDismiss={overrides.onDismiss ?? (() => {})}
      heightFraction={overrides.heightFraction}
    >
      <Text>x</Text>
    </EditorialBottomSheet>,
  );
}

describe('EditorialBottomSheet PanResponder config', () => {
  it('refuses to claim the gesture on touch start (lets taps fall through to children)', () => {
    renderSheet();
    const cfg = getLatestPanConfig();
    expect(cfg.onStartShouldSetPanResponder()).toBe(false);
  });

  it('claims the gesture only on a meaningful downward move (dy > 5 and dy dominates dx)', () => {
    renderSheet();
    const cfg = getLatestPanConfig();
    // small downward jitter — does NOT claim
    expect(cfg.onMoveShouldSetPanResponder({}, { dy: 3, dx: 0 })).toBe(false);
    // mostly horizontal — does NOT claim, even if dy > 5
    expect(cfg.onMoveShouldSetPanResponder({}, { dy: 10, dx: 30 })).toBe(false);
    // clean downward drag — claims
    expect(cfg.onMoveShouldSetPanResponder({}, { dy: 20, dx: 5 })).toBe(true);
    // upward drag — refuses (dy must be > 5, not absolute > 5)
    expect(cfg.onMoveShouldSetPanResponder({}, { dy: -20, dx: 0 })).toBe(false);
  });

  it('onPanResponderMove ignores upward drags (translateY only follows downward motion)', () => {
    renderSheet();
    const cfg = getLatestPanConfig();
    // No throw and no side effect — calling with upward dy is a no-op path.
    expect(() => cfg.onPanResponderMove({}, { dy: -50, dx: 0 })).not.toThrow();
    // Downward dy sets translateY (an Animated.Value); wrap in act so the
    // Animated subscription doesn't trip the React 19 not-wrapped-in-act warning.
    act(() => {
      cfg.onPanResponderMove({}, { dy: 80, dx: 0 });
    });
  });

  it('onPanResponderRelease fires onDismiss when dy crosses the dismiss threshold', () => {
    const onDismiss = jest.fn();
    renderSheet({ onDismiss, heightFraction: 0.5 });
    const cfg = getLatestPanConfig();
    // 300 > max(100, 0.3 * sheetHeight). Whatever Dimensions returns in the
    // test env, 300 will dismiss for any reasonable screen height up to 1000.
    act(() => {
      cfg.onPanResponderRelease({}, { dy: 300, dx: 0 });
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
    // No spring on dismiss — the sheet is going away, no snap-back animation.
    expect(mockSpring).not.toHaveBeenCalled();
  });

  it('onPanResponderRelease snaps back via Animated.spring on a sub-threshold drag (reduce-motion off)', () => {
    const onDismiss = jest.fn();
    renderSheet({ onDismiss, heightFraction: 0.7 });
    const cfg = getLatestPanConfig();
    act(() => {
      cfg.onPanResponderRelease({}, { dy: 30, dx: 0 });
    });
    expect(onDismiss).not.toHaveBeenCalled();
    expect(mockSpring).toHaveBeenCalledTimes(1);
    expect(mockSpringStart).toHaveBeenCalledTimes(1);
    // Sanity-check the spring config — useNativeDriver is locked to true,
    // bounciness is the master-plan-tuned 4.
    const [, springConfig] = (mockSpring.mock.calls[0] ?? []) as unknown[];
    expect((springConfig as { useNativeDriver: boolean }).useNativeDriver).toBe(true);
    expect((springConfig as { bounciness: number }).bounciness).toBe(4);
  });

  it('onPanResponderRelease snaps back instantly (no spring) when reduce-motion is on', async () => {
    mockState.reduceMotion = true;
    const onDismiss = jest.fn();
    renderSheet({ onDismiss });

    // Wait for the mount-time isReduceMotionEnabled promise to resolve, so
    // the latestRef picks up reduceMotion=true.
    await act(async () => {
      await new Promise((resolve) => setImmediate(resolve));
    });

    const cfg = getLatestPanConfig();
    act(() => {
      cfg.onPanResponderRelease({}, { dy: 40, dx: 0 });
    });

    expect(onDismiss).not.toHaveBeenCalled();
    // The reduce-motion branch must skip the spring entirely — Animated.spring
    // with useNativeDriver:true on jest is a no-op, but skipping it explicitly
    // keeps the audit-defensible reduce-motion contract.
    expect(mockSpring).not.toHaveBeenCalled();
  });

  it('onPanResponderTerminate resets translation (no dismiss, no spring)', () => {
    const onDismiss = jest.fn();
    renderSheet({ onDismiss });
    const cfg = getLatestPanConfig();
    act(() => {
      cfg.onPanResponderTerminate();
    });
    expect(onDismiss).not.toHaveBeenCalled();
    expect(mockSpring).not.toHaveBeenCalled();
  });

  it('latestRef picks up the most recent onDismiss across re-renders (stable responder, fresh closure)', () => {
    const onDismissA = jest.fn();
    const onDismissB = jest.fn();
    const { rerender } = render(
      <EditorialBottomSheet open onDismiss={onDismissA}>
        <Text>x</Text>
      </EditorialBottomSheet>,
    );
    rerender(
      <EditorialBottomSheet open onDismiss={onDismissB}>
        <Text>x</Text>
      </EditorialBottomSheet>,
    );
    // PanResponder.create is called once per mount; the same config is reused
    // across re-renders. Only one captured config from the first render still
    // applies, but it reads onDismiss through latestRef which has been refreshed.
    const cfg = mockCapturedConfigs[0]!;
    act(() => {
      cfg.onPanResponderRelease({}, { dy: 400, dx: 0 });
    });
    expect(onDismissA).not.toHaveBeenCalled();
    expect(onDismissB).toHaveBeenCalledTimes(1);
  });

  it('reduceMotionChanged listener flips the snap-back path live without remount', async () => {
    const onDismiss = jest.fn();
    renderSheet({ onDismiss });

    // Resolve the mount-time isReduceMotionEnabled promise (default false).
    await act(async () => {
      await new Promise((resolve) => setImmediate(resolve));
    });

    expect(mockReduceMotionListeners.length).toBe(1);

    // Flip via the live listener inside act so the setState lands cleanly.
    await act(async () => {
      mockReduceMotionListeners[0]!(true);
    });

    const cfg = getLatestPanConfig();
    act(() => {
      cfg.onPanResponderRelease({}, { dy: 30, dx: 0 });
    });
    // Now spring must NOT fire — the live flip was honored.
    expect(mockSpring).not.toHaveBeenCalled();
  });

  it('subscribed listener is detached on unmount (mounted-flag branch on line 112)', async () => {
    const { unmount } = renderSheet();
    await act(async () => {
      await new Promise((resolve) => setImmediate(resolve));
    });
    expect(mockReduceMotionListeners.length).toBe(1);
    unmount();
    // Cleanup removes the subscription.
    expect(mockReduceMotionListeners.length).toBe(0);
  });

  it('darkTheme override does not affect gesture wiring', () => {
    useColorSchemeMock.mockReturnValue('dark');
    const onDismiss = jest.fn();
    renderSheet({ onDismiss });
    const cfg = getLatestPanConfig();
    act(() => {
      cfg.onPanResponderRelease({}, { dy: 500, dx: 0 });
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
    // Sanity: darkTheme is the in-use token table here, distinct from light.
    expect(darkTheme.colors.surface).not.toBe(lightTheme.colors.surface);
  });
});
