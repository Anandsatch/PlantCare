import { darkTheme, lightTheme } from '@plantcare/theme';
import { act, render } from '@testing-library/react-native';
import { Animated } from 'react-native';

import { DiagnoseLoadingState } from '../DiagnoseLoadingState';

// Mock the two hooks used by the component. We don't need to exercise the
// real AccessibilityInfo or useColorScheme here — that coverage lives in
// the hook tests. This test surface is the bucket math + animation gating.
jest.mock('../../hooks/useReduceMotion', () => ({
  useReduceMotion: jest.fn(),
}));
jest.mock('../../hooks/useTheme', () => ({
  useTheme: jest.fn(),
}));

import { useReduceMotion } from '../../hooks/useReduceMotion';
import { useTheme } from '../../hooks/useTheme';

const mockedUseReduceMotion = useReduceMotion as jest.MockedFunction<typeof useReduceMotion>;
const mockedUseTheme = useTheme as jest.MockedFunction<typeof useTheme>;

const COPY = {
  bucket0: 'Looking closely…',
  bucket1: 'Almost there…',
  bucket2: 'Trying a more careful look…',
} as const;

// Fixed wall-clock anchor — every test pins startedAtMs here so elapsed math
// is exact regardless of when the test actually runs.
const T0 = 1_000_000_000;

describe('DiagnoseLoadingState', () => {
  beforeEach(() => {
    mockedUseReduceMotion.mockReset();
    mockedUseTheme.mockReset();
    mockedUseReduceMotion.mockReturnValue(false);
    mockedUseTheme.mockReturnValue(lightTheme);
  });

  describe('bucket selection', () => {
    it('renders bucket 0 copy at elapsed=0', () => {
      const { getByText } = render(<DiagnoseLoadingState startedAtMs={T0} nowMs={T0} />);
      expect(getByText(COPY.bucket0)).toBeOnTheScreen();
    });

    it('renders bucket 0 copy at elapsed=7999 (just before the boundary)', () => {
      const { getByText } = render(<DiagnoseLoadingState startedAtMs={T0} nowMs={T0 + 7999} />);
      expect(getByText(COPY.bucket0)).toBeOnTheScreen();
    });

    it('renders bucket 1 copy at elapsed=8000 (boundary inclusive: 8000 → bucket 1)', () => {
      const { getByText } = render(<DiagnoseLoadingState startedAtMs={T0} nowMs={T0 + 8000} />);
      expect(getByText(COPY.bucket1)).toBeOnTheScreen();
    });

    it('renders bucket 1 copy at elapsed=19999 (just before the next boundary)', () => {
      const { getByText } = render(<DiagnoseLoadingState startedAtMs={T0} nowMs={T0 + 19999} />);
      expect(getByText(COPY.bucket1)).toBeOnTheScreen();
    });

    it('renders bucket 2 copy at elapsed=20000 (boundary inclusive: 20000 → bucket 2)', () => {
      const { getByText } = render(<DiagnoseLoadingState startedAtMs={T0} nowMs={T0 + 20000} />);
      expect(getByText(COPY.bucket2)).toBeOnTheScreen();
    });

    it('renders bucket 2 copy at elapsed=60000 (deep into the slow path)', () => {
      const { getByText } = render(<DiagnoseLoadingState startedAtMs={T0} nowMs={T0 + 60000} />);
      expect(getByText(COPY.bucket2)).toBeOnTheScreen();
    });
  });

  describe('self-managed clock', () => {
    it('auto-advances buckets via the 250ms interval when nowMs is omitted', () => {
      jest.useFakeTimers();
      const now = Date.now();
      jest.setSystemTime(now);
      const { getByText, queryByText } = render(<DiagnoseLoadingState startedAtMs={now} />);

      // At mount, elapsed=0 → bucket 0.
      expect(getByText(COPY.bucket0)).toBeOnTheScreen();

      // Advance 8500ms — past the bucket-1 boundary. The 250ms tick will
      // setState somewhere along the way and the bucket 1 copy lands.
      act(() => {
        jest.setSystemTime(now + 8500);
        jest.advanceTimersByTime(8500);
      });

      expect(getByText(COPY.bucket1)).toBeOnTheScreen();
      expect(queryByText(COPY.bucket0)).toBeNull();
      jest.useRealTimers();
    });

    it('does not re-render the subtree on every 250ms tick when the bucket has not changed', () => {
      // Codex P2 fix verification: the internal clock state stores the
      // bucket index, not the raw clock value, so React's setState bail-out
      // suppresses re-renders when the bucket is unchanged. Without that
      // fix the component reconciles 4 times per second for the first 8s.
      jest.useFakeTimers();
      const now = Date.now();
      jest.setSystemTime(now);

      let renderCount = 0;
      const Probe = () => {
        renderCount += 1;
        return <DiagnoseLoadingState startedAtMs={now} />;
      };
      render(<Probe />);
      const initialRenderCount = renderCount;

      // Advance ~3 seconds — 12 interval ticks. Bucket should not flip
      // (still bucket 0). The Probe wrapper should not re-render.
      act(() => {
        jest.setSystemTime(now + 3000);
        jest.advanceTimersByTime(3000);
      });

      expect(renderCount).toBe(initialRenderCount);
      jest.useRealTimers();
    });

    it('clears the interval on unmount', () => {
      jest.useFakeTimers();
      const clearSpy = jest.spyOn(global, 'clearInterval');
      const { unmount } = render(<DiagnoseLoadingState startedAtMs={Date.now()} />);

      const callsBefore = clearSpy.mock.calls.length;
      unmount();
      expect(clearSpy.mock.calls.length).toBeGreaterThan(callsBefore);

      clearSpy.mockRestore();
      jest.useRealTimers();
    });
  });

  describe('reduce-motion compliance', () => {
    it('does not start an Animated.loop when reduce-motion is enabled', () => {
      mockedUseReduceMotion.mockReturnValue(true);
      const loopSpy = jest.spyOn(Animated, 'loop');

      render(<DiagnoseLoadingState startedAtMs={T0} nowMs={T0} testID="dls" />);

      expect(loopSpy).not.toHaveBeenCalled();
      loopSpy.mockRestore();
    });

    it('starts an Animated.loop per dot (3 total) when reduce-motion is disabled', () => {
      mockedUseReduceMotion.mockReturnValue(false);
      const loopSpy = jest.spyOn(Animated, 'loop');

      render(<DiagnoseLoadingState startedAtMs={T0} nowMs={T0} testID="dls" />);

      expect(loopSpy).toHaveBeenCalledTimes(3);
      loopSpy.mockRestore();
    });
  });

  describe('accessibility', () => {
    it('forwards a custom accessibilityLabel and sets accessibilityLiveRegion="polite"', () => {
      const { getByTestId } = render(
        <DiagnoseLoadingState
          startedAtMs={T0}
          nowMs={T0}
          accessibilityLabel="Custom diagnose label"
          testID="dls"
        />,
      );
      const root = getByTestId('dls');
      expect(root.props.accessibilityLabel).toBe('Custom diagnose label');
      expect(root.props.accessibilityLiveRegion).toBe('polite');
    });

    it('uses the default accessibilityLabel when none is provided', () => {
      const { getByTestId } = render(
        <DiagnoseLoadingState startedAtMs={T0} nowMs={T0} testID="dls" />,
      );
      expect(getByTestId('dls').props.accessibilityLabel).toBe('Diagnosing your plant photo');
    });
  });

  describe('theming', () => {
    it('uses the dark (Midnight) text token when the active theme is dark', () => {
      mockedUseTheme.mockReturnValue(darkTheme);
      const { getByTestId } = render(
        <DiagnoseLoadingState startedAtMs={T0} nowMs={T0} testID="dls" />,
      );
      const copy = getByTestId('dls-copy');
      // RN flattens the style array; the cream Midnight token must win.
      const style = Array.isArray(copy.props.style) ? Object.assign({}, ...copy.props.style) : copy.props.style;
      expect(style.color).toBe(darkTheme.colors.text);
      expect(style.color).toBe('#FAF6EE');
    });

    it('uses the light (Conservatory) text token when the active theme is light', () => {
      mockedUseTheme.mockReturnValue(lightTheme);
      const { getByTestId } = render(
        <DiagnoseLoadingState startedAtMs={T0} nowMs={T0} testID="dls" />,
      );
      const copy = getByTestId('dls-copy');
      const style = Array.isArray(copy.props.style) ? Object.assign({}, ...copy.props.style) : copy.props.style;
      expect(style.color).toBe(lightTheme.colors.text);
      expect(style.color).toBe('#2A2A2A');
    });
  });
});
