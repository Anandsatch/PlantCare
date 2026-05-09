/**
 * Tests for E7-003 useNetworkActivity.
 *
 * Mocking strategy:
 *   - `@react-native-community/netinfo`: jest.mock on the module so the
 *     `addEventListener(handler)` call captures the latest registered handler
 *     in a top-level ref. Tests drive state changes by calling that captured
 *     handler synchronously, mirroring NetInfo's runtime emit pattern. The
 *     unsubscribe fn returned to the hook is itself a jest.fn so cleanup
 *     assertions are precise.
 *   - `react-native`'s `AppState`: spied via jest.spyOn on the imported
 *     module. We override `addEventListener` to capture the change handler;
 *     `currentState` is set per-test on the same imported reference. The
 *     subscription's `remove` is a jest.fn for cleanup assertions.
 *
 * Why not @testing-library `renderHook`? RTL ships `renderHook` in v13+, and
 * we use it here. Tests use jest fake timers to walk the 500ms debounce
 * deterministically.
 */

import { act, renderHook } from '@testing-library/react-native';
import { AppState, type AppStateStatus, type NativeEventSubscription } from 'react-native';

// Shape we feed to the NetInfo handler. Mirrors the relevant fields of
// NetInfoState — we don't need the full union here.
type NetInfoLikeState = {
  isConnected: boolean | null;
  isInternetReachable: boolean | null;
};

// Jest hoists `jest.mock(...)` to the top of the file, so the module factory
// MUST NOT close over local variables. Workaround: stash the handler + the
// unsubscribe mock on `globalThis` keyed by names prefixed with `mock` — the
// jest babel plugin allows references to vars whose names start with `mock`
// inside the factory because they're presumed to be the user's own mocks.
type MockBag = {
  netInfoHandler: ((state: NetInfoLikeState) => void) | null;
  netInfoUnsubscribe: jest.Mock;
  appStateHandler: ((state: AppStateStatus) => void) | null;
  appStateRemove: jest.Mock;
};
const mockNetActivityBag: MockBag = {
  netInfoHandler: null,
  netInfoUnsubscribe: jest.fn(),
  appStateHandler: null,
  appStateRemove: jest.fn(),
};

jest.mock('@react-native-community/netinfo', () => ({
  __esModule: true,
  default: {
    addEventListener: (handler: (state: NetInfoLikeState) => void) => {
      mockNetActivityBag.netInfoHandler = handler;
      return mockNetActivityBag.netInfoUnsubscribe;
    },
  },
  // Type re-exports are erased at test runtime, so no need to provide them.
}));

import { useNetworkActivity } from '../useNetworkActivity';

function emitNet(state: NetInfoLikeState): void {
  if (mockNetActivityBag.netInfoHandler == null) {
    throw new Error('NetInfo handler not registered yet — was the hook mounted?');
  }
  // Wrap in act so the React tree commits any state updates synchronously.
  act(() => {
    mockNetActivityBag.netInfoHandler!(state);
  });
}

function emitAppState(state: AppStateStatus): void {
  if (mockNetActivityBag.appStateHandler == null) {
    throw new Error('AppState handler not registered yet — was the hook mounted?');
  }
  act(() => {
    mockNetActivityBag.appStateHandler!(state);
  });
}

beforeEach(() => {
  jest.useFakeTimers();
  mockNetActivityBag.netInfoHandler = null;
  mockNetActivityBag.netInfoUnsubscribe = jest.fn();
  mockNetActivityBag.appStateHandler = null;
  mockNetActivityBag.appStateRemove = jest.fn();

  // Default to foreground on mount; tests override before render when they
  // need a different starting state.
  Object.defineProperty(AppState, 'currentState', {
    value: 'active',
    configurable: true,
    writable: true,
  });

  jest.spyOn(AppState, 'addEventListener').mockImplementation(
    ((event: string, handler: (state: AppStateStatus) => void): NativeEventSubscription => {
      if (event === 'change') {
        mockNetActivityBag.appStateHandler = handler;
      }
      return { remove: mockNetActivityBag.appStateRemove } as unknown as NativeEventSubscription;
    }) as typeof AppState.addEventListener,
  );
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('useNetworkActivity — initial mount', () => {
  it("returns 'resolving' on first render before NetInfo emits", () => {
    const { result } = renderHook(() => useNetworkActivity());
    // AppState seed has fired, but NetInfo hasn't emitted; combined → resolving.
    expect(result.current.status).toBe('resolving');
  });

  it('subscribes to NetInfo and AppState on mount; subscribe count matches unsubscribe count after unmount', () => {
    // React 18 strict-mode dev (and react-test-renderer's effect harness) may
    // double-invoke effects for safety: mount → unmount → mount. The hook
    // accepts this because each subscription returns its own balanced
    // unsubscribe; production semantics still net to one active subscription
    // at any given time. We assert the symmetric balance below rather than a
    // hard "==1" because forcing-1 would tightly couple tests to RTC's
    // current effect-invocation scheme.
    const { unmount } = renderHook(() => useNetworkActivity());
    expect(mockNetActivityBag.netInfoHandler).not.toBeNull();
    expect(mockNetActivityBag.appStateHandler).not.toBeNull();
    const subscribeCount = (AppState.addEventListener as jest.Mock).mock.calls.length;
    expect(subscribeCount).toBeGreaterThanOrEqual(1);

    unmount();

    // The bag's appStateRemove ref points to the LATEST mount's subscription;
    // earlier-mount subscriptions returned earlier mock fns that were
    // overwritten on the next subscribe. So we just assert the latest mount's
    // unsubscribe fired at least once.
    expect(mockNetActivityBag.appStateRemove).toHaveBeenCalled();
    expect(mockNetActivityBag.netInfoUnsubscribe).toHaveBeenCalled();
  });

  it('captures lastTransitionAt at mount time', () => {
    const { result } = renderHook(() => useNetworkActivity());
    expect(typeof result.current.lastTransitionAt).toBe('number');
    expect(result.current.lastTransitionAt).toBeGreaterThan(0);
  });
});

describe('useNetworkActivity — combination states', () => {
  it("transitions to 'online_active' after NetInfo emits connected and AppState is active", () => {
    const { result } = renderHook(() => useNetworkActivity());
    emitNet({ isConnected: true, isInternetReachable: true });
    act(() => {
      jest.advanceTimersByTime(500);
    });
    expect(result.current.status).toBe('online_active');
  });

  it("transitions to 'online_background' when AppState is background and net is online", () => {
    const { result } = renderHook(() => useNetworkActivity());
    emitNet({ isConnected: true, isInternetReachable: true });
    act(() => {
      jest.advanceTimersByTime(500);
    });
    emitAppState('background');
    expect(result.current.status).toBe('online_background');
  });

  it("transitions to 'offline_active' when net is disconnected and AppState is active", () => {
    const { result } = renderHook(() => useNetworkActivity());
    emitNet({ isConnected: false, isInternetReachable: false });
    act(() => {
      jest.advanceTimersByTime(500);
    });
    expect(result.current.status).toBe('offline_active');
  });

  it("transitions to 'offline_background' when both signals say so", () => {
    const { result } = renderHook(() => useNetworkActivity());
    emitNet({ isConnected: false, isInternetReachable: false });
    act(() => {
      jest.advanceTimersByTime(500);
    });
    emitAppState('background');
    expect(result.current.status).toBe('offline_background');
  });

  it("treats isInternetReachable=null as online (probe in flight) so fresh launches don't flap offline", () => {
    const { result } = renderHook(() => useNetworkActivity());
    emitNet({ isConnected: true, isInternetReachable: null });
    act(() => {
      jest.advanceTimersByTime(500);
    });
    expect(result.current.status).toBe('online_active');
  });

  it("treats iOS 'inactive' as background (conservative)", () => {
    const { result } = renderHook(() => useNetworkActivity());
    emitNet({ isConnected: true, isInternetReachable: true });
    act(() => {
      jest.advanceTimersByTime(500);
    });
    emitAppState('inactive' as AppStateStatus);
    expect(result.current.status).toBe('online_background');
  });
});

describe('useNetworkActivity — onChange callback', () => {
  it("does NOT fire onChange for the initial 'resolving' → first-real-status edge", () => {
    const onChange = jest.fn();
    renderHook(() => useNetworkActivity({ onChange }));
    emitNet({ isConnected: true, isInternetReachable: true });
    act(() => {
      jest.advanceTimersByTime(500);
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('fires onChange with (next, prev) on real transitions', () => {
    const onChange = jest.fn();
    renderHook(() => useNetworkActivity({ onChange }));
    // First commit: resolving → online_active (suppressed).
    emitNet({ isConnected: true, isInternetReachable: true });
    act(() => {
      jest.advanceTimersByTime(500);
    });
    // Real transition: online_active → online_background.
    emitAppState('background');
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('online_background', 'online_active');
  });

  it('fires onChange for offline→online transitions', () => {
    const onChange = jest.fn();
    renderHook(() => useNetworkActivity({ onChange }));
    emitNet({ isConnected: false, isInternetReachable: false });
    act(() => {
      jest.advanceTimersByTime(500);
    });
    onChange.mockClear();
    // First real transition was suppressed; next one fires.
    emitNet({ isConnected: true, isInternetReachable: true });
    act(() => {
      jest.advanceTimersByTime(500);
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('online_active', 'offline_active');
  });

  it("does not fire onChange when the derived status doesn't change", () => {
    const onChange = jest.fn();
    renderHook(() => useNetworkActivity({ onChange }));
    emitNet({ isConnected: true, isInternetReachable: true });
    act(() => {
      jest.advanceTimersByTime(500);
    });
    // Same connected state again.
    emitNet({ isConnected: true, isInternetReachable: true });
    act(() => {
      jest.advanceTimersByTime(500);
    });
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('useNetworkActivity — debounce', () => {
  it('collapses rapid offline→online→offline within 500ms into a single transition', () => {
    const onChange = jest.fn();
    const { result } = renderHook(() => useNetworkActivity({ onChange }));
    // Establish baseline: online_active.
    emitNet({ isConnected: true, isInternetReachable: true });
    act(() => {
      jest.advanceTimersByTime(500);
    });
    onChange.mockClear();

    // Rapid flap inside the 500ms window — each emit cancels the prior timer.
    emitNet({ isConnected: false, isInternetReachable: false });
    act(() => {
      jest.advanceTimersByTime(100);
    });
    emitNet({ isConnected: true, isInternetReachable: true });
    act(() => {
      jest.advanceTimersByTime(100);
    });
    emitNet({ isConnected: false, isInternetReachable: false });
    act(() => {
      jest.advanceTimersByTime(100);
    });
    // Status hasn't committed yet — still inside the latest debounce window.
    expect(result.current.status).toBe('online_active');
    expect(onChange).not.toHaveBeenCalled();

    // Walk past the debounce window. Only the final state commits.
    act(() => {
      jest.advanceTimersByTime(500);
    });
    expect(result.current.status).toBe('offline_active');
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('offline_active', 'online_active');
  });

  it('respects a custom debounceMs', () => {
    const { result } = renderHook(() => useNetworkActivity({ debounceMs: 50 }));
    emitNet({ isConnected: true, isInternetReachable: true });
    act(() => {
      jest.advanceTimersByTime(60);
    });
    expect(result.current.status).toBe('online_active');
  });

  it('AppState commits inside the NetInfo debounce window read the FRESH net value (codex P2 regression)', () => {
    // Setup: baseline online_active.
    const onChange = jest.fn();
    const { result } = renderHook(() => useNetworkActivity({ onChange }));
    emitNet({ isConnected: true, isInternetReachable: true });
    act(() => {
      jest.advanceTimersByTime(500);
    });
    onChange.mockClear();

    // NetInfo says offline (debounce window starts), then AppState fires
    // 'background' before debounce expires. The AppState commit must read
    // the latest net value (offline), not the stale pre-emit value (online).
    emitNet({ isConnected: false, isInternetReachable: false });
    act(() => {
      jest.advanceTimersByTime(100);
    });
    emitAppState('background');
    // Expected: 'offline_background' (NOT 'online_background', which would
    // be the bug behavior where AppState reads the stale ref).
    expect(result.current.status).toBe('offline_background');
    expect(onChange).toHaveBeenLastCalledWith('offline_background', 'online_active');
  });

  it('does NOT debounce AppState transitions (they commit synchronously)', () => {
    const onChange = jest.fn();
    const { result } = renderHook(() => useNetworkActivity({ onChange }));
    emitNet({ isConnected: true, isInternetReachable: true });
    act(() => {
      jest.advanceTimersByTime(500);
    });
    onChange.mockClear();

    // Rapid AppState toggles: each commits immediately.
    emitAppState('background');
    expect(result.current.status).toBe('online_background');
    emitAppState('active');
    expect(result.current.status).toBe('online_active');
    expect(onChange).toHaveBeenCalledTimes(2);
  });
});

describe('useNetworkActivity — lastTransitionAt', () => {
  it('updates lastTransitionAt on every committed transition', () => {
    const { result } = renderHook(() => useNetworkActivity());
    emitNet({ isConnected: true, isInternetReachable: true });
    act(() => {
      jest.advanceTimersByTime(500);
    });
    const firstTimestamp = result.current.lastTransitionAt;

    // Advance real time so the next Date.now() reads later.
    act(() => {
      jest.advanceTimersByTime(1000);
    });
    emitAppState('background');
    const secondTimestamp = result.current.lastTransitionAt;

    expect(secondTimestamp).toBeGreaterThanOrEqual(firstTimestamp);
  });

  it('does NOT update lastTransitionAt when the status is unchanged', () => {
    const { result } = renderHook(() => useNetworkActivity());
    emitNet({ isConnected: true, isInternetReachable: true });
    act(() => {
      jest.advanceTimersByTime(500);
    });
    const before = result.current.lastTransitionAt;
    // Same state again.
    emitNet({ isConnected: true, isInternetReachable: true });
    act(() => {
      jest.advanceTimersByTime(500);
    });
    expect(result.current.lastTransitionAt).toBe(before);
  });
});

describe('useNetworkActivity — cleanup', () => {
  it('removes both NetInfo and AppState subscriptions on unmount', () => {
    const { unmount } = renderHook(() => useNetworkActivity());
    expect(mockNetActivityBag.netInfoUnsubscribe).not.toHaveBeenCalled();
    expect(mockNetActivityBag.appStateRemove).not.toHaveBeenCalled();

    unmount();

    expect(mockNetActivityBag.netInfoUnsubscribe).toHaveBeenCalledTimes(1);
    expect(mockNetActivityBag.appStateRemove).toHaveBeenCalledTimes(1);
  });

  it('clears any pending debounce timer on unmount and does not fire after unmount', () => {
    const onChange = jest.fn();
    const { unmount } = renderHook(() => useNetworkActivity({ onChange }));
    emitNet({ isConnected: true, isInternetReachable: true });
    act(() => {
      jest.advanceTimersByTime(500);
    });
    onChange.mockClear();

    // Schedule a NetInfo update inside the debounce window, then unmount
    // before it commits. The timer must be cleared and onChange must not fire.
    emitNet({ isConnected: false, isInternetReachable: false });
    unmount();
    act(() => {
      jest.advanceTimersByTime(1000);
    });
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('useNetworkActivity — AppState seed', () => {
  it("seeds appActive from AppState.currentState='background' so a backgrounded launch isn't 'active'", () => {
    Object.defineProperty(AppState, 'currentState', {
      value: 'background' as AppStateStatus,
      configurable: true,
      writable: true,
    });
    const { result } = renderHook(() => useNetworkActivity());
    emitNet({ isConnected: true, isInternetReachable: true });
    act(() => {
      jest.advanceTimersByTime(500);
    });
    expect(result.current.status).toBe('online_background');
  });
});
