import { act, renderHook, waitFor } from '@testing-library/react-native';
import { AccessibilityInfo } from 'react-native';

import { useReduceMotion } from '../useReduceMotion';

// Mock AccessibilityInfo's two surfaces (initial fetch + change subscription).
// Mirrors the shape of useTheme.test.tsx where `useColorScheme` is replaced
// wholesale. Each test seeds these mocks; default in `beforeEach` is the
// safe-and-quiet "off" path so tests that don't care don't accidentally
// trigger a setState after unmount or a noisy unhandled rejection.
type ChangeListener = (enabled: boolean) => void;

jest.mock('react-native', () => ({
  AccessibilityInfo: {
    isReduceMotionEnabled: jest.fn(),
    addEventListener: jest.fn(),
  },
}));

const mockedIsEnabled = AccessibilityInfo.isReduceMotionEnabled as jest.MockedFunction<
  typeof AccessibilityInfo.isReduceMotionEnabled
>;
const mockedAddListener = AccessibilityInfo.addEventListener as jest.MockedFunction<
  typeof AccessibilityInfo.addEventListener
>;

function captureSubscription() {
  const remove = jest.fn();
  let listener: ChangeListener | undefined;
  mockedAddListener.mockImplementation(((event: string, cb: ChangeListener) => {
    if (event === 'reduceMotionChanged') listener = cb;
    return { remove } as { remove: () => void };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any);
  return {
    remove,
    fire: (enabled: boolean) => {
      if (!listener) throw new Error('reduceMotionChanged listener never registered');
      act(() => listener!(enabled));
    },
  };
}

describe('useReduceMotion', () => {
  beforeEach(() => {
    mockedIsEnabled.mockReset();
    mockedAddListener.mockReset();
    // Quiet defaults — individual tests that exercise the initial fetch
    // override these. Without a default the unawaited promise in the effect
    // would reject as `mockResolvedValue(undefined)` on a non-mocked fn.
    mockedIsEnabled.mockResolvedValue(false);
    mockedAddListener.mockReturnValue({ remove: jest.fn() } as never);
  });

  it('defaults to false on initial render before the async fetch resolves', () => {
    // Pending promise — never resolves in this test, so the only value the
    // hook can return is the initial state. Captures the documented
    // "biased-toward-motion" default during the brief async window.
    mockedIsEnabled.mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => useReduceMotion());
    expect(result.current).toBe(false);
  });

  it('resolves to true when AccessibilityInfo reports reduce motion enabled', async () => {
    mockedIsEnabled.mockResolvedValue(true);
    const { result } = renderHook(() => useReduceMotion());
    await waitFor(() => expect(result.current).toBe(true));
  });

  it('stays false when AccessibilityInfo reports reduce motion disabled', async () => {
    mockedIsEnabled.mockResolvedValue(false);
    const { result } = renderHook(() => useReduceMotion());
    // Flush microtasks so the resolved-false setState runs and we're not just
    // measuring the initial-state default.
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current).toBe(false);
  });

  it('flips to true when the reduceMotionChanged listener fires with true', async () => {
    mockedIsEnabled.mockResolvedValue(false);
    const sub = captureSubscription();
    const { result } = renderHook(() => useReduceMotion());
    await waitFor(() => expect(result.current).toBe(false));

    sub.fire(true);
    expect(result.current).toBe(true);
  });

  it('flips back to false when the listener fires with false after being true', async () => {
    mockedIsEnabled.mockResolvedValue(true);
    const sub = captureSubscription();
    const { result } = renderHook(() => useReduceMotion());
    await waitFor(() => expect(result.current).toBe(true));

    sub.fire(false);
    expect(result.current).toBe(false);
  });

  it('removes the subscription on unmount', () => {
    const sub = captureSubscription();
    const { unmount } = renderHook(() => useReduceMotion());

    expect(sub.remove).not.toHaveBeenCalled();
    unmount();
    expect(sub.remove).toHaveBeenCalledTimes(1);
  });

  it('falls through to false (no unhandled rejection) when the initial fetch rejects', async () => {
    mockedIsEnabled.mockRejectedValue(new Error('a11y service unavailable'));
    const { result } = renderHook(() => useReduceMotion());

    // Let the rejection settle so an unhandled-rejection would surface here.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current).toBe(false);
  });

  it('does not setState after unmount when the initial fetch resolves late', async () => {
    let resolveLate: (value: boolean) => void = () => {};
    mockedIsEnabled.mockReturnValue(
      new Promise<boolean>((resolve) => {
        resolveLate = resolve;
      }),
    );

    const { unmount } = renderHook(() => useReduceMotion());
    unmount();

    // Spy on console.error to catch the React "setState on unmounted" warning
    // that a missing mounted-guard would emit.
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    await act(async () => {
      resolveLate(true);
      await Promise.resolve();
    });
    expect(errSpy).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
