import { darkTheme, lightTheme } from '@plantcare/theme';
import { act, fireEvent, render } from '@testing-library/react-native';
import { Animated } from 'react-native';

import { ToastBanner } from '../ToastBanner';

// Mock the hook module directly rather than `react-native` itself so we
// don't shadow the rest of RN (FlatList, View, Pressable, Text). Same shape
// as the useTheme test, just one level removed since the primitive doesn't
// import useColorScheme directly.
jest.mock('../../../hooks/useTheme', () => ({
  useTheme: jest.fn(),
}));
jest.mock('../../../hooks/useReduceMotion', () => ({
  useReduceMotion: jest.fn(),
}));

import { useReduceMotion } from '../../../hooks/useReduceMotion';
import { useTheme } from '../../../hooks/useTheme';
const mockedUseTheme = useTheme as jest.MockedFunction<typeof useTheme>;
const mockedUseReduceMotion = useReduceMotion as jest.MockedFunction<typeof useReduceMotion>;

function flattenStyle(style: unknown): Record<string, unknown> {
  if (Array.isArray(style)) {
    return Object.assign({}, ...style.map((s) => flattenStyle(s)));
  }
  if (style && typeof style === 'object') {
    return style as Record<string, unknown>;
  }
  return {};
}

describe('ToastBanner', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockedUseTheme.mockReturnValue(lightTheme);
    mockedUseReduceMotion.mockReturnValue(false);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  it('renders warn type with theme.tan background', () => {
    const { getByTestId } = render(
      <ToastBanner type="warn" message="warn msg" testID="banner" />,
    );
    const style = flattenStyle(getByTestId('banner').props.style);
    expect(style.backgroundColor).toBe(lightTheme.colors.tan);
  });

  it('renders info type with theme.sage background', () => {
    const { getByTestId } = render(
      <ToastBanner type="info" message="info msg" testID="banner" />,
    );
    const style = flattenStyle(getByTestId('banner').props.style);
    expect(style.backgroundColor).toBe(lightTheme.colors.sage);
  });

  it('renders pending type with theme.tan background (same token as warn)', () => {
    const { getByTestId } = render(
      <ToastBanner type="pending" message="syncing" testID="banner" />,
    );
    const style = flattenStyle(getByTestId('banner').props.style);
    expect(style.backgroundColor).toBe(lightTheme.colors.tan);
  });

  it('renders the message verbatim', () => {
    const { getByText } = render(
      <ToastBanner type="warn" message="Couldn't save — try again" />,
    );
    expect(getByText("Couldn't save — try again")).toBeTruthy();
  });

  it('renders the action button when action is provided and fires onPress on tap', () => {
    const onPress = jest.fn();
    const { getByText } = render(
      <ToastBanner
        type="warn"
        message="msg"
        action={{ label: 'Retry', onPress }}
      />,
    );
    fireEvent.press(getByText('Retry'));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('renders no action button when action prop is omitted', () => {
    const { queryByRole } = render(<ToastBanner type="warn" message="msg" />);
    expect(queryByRole('button')).toBeNull();
  });

  it('warn auto-dismisses after default 4000ms', () => {
    const onDismiss = jest.fn();
    render(<ToastBanner type="warn" message="msg" onDismiss={onDismiss} />);
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => {
      jest.advanceTimersByTime(4000);
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('info auto-dismisses after default 4000ms', () => {
    const onDismiss = jest.fn();
    render(<ToastBanner type="info" message="msg" onDismiss={onDismiss} />);
    act(() => {
      jest.advanceTimersByTime(4000);
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('pending DOES NOT auto-dismiss (advance 30000ms, onDismiss not called)', () => {
    const onDismiss = jest.fn();
    render(<ToastBanner type="pending" message="3 syncing" onDismiss={onDismiss} />);
    act(() => {
      jest.advanceTimersByTime(30000);
    });
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('explicit autoDismissMs=0 disables auto-dismiss for warn', () => {
    const onDismiss = jest.fn();
    render(
      <ToastBanner type="warn" message="msg" autoDismissMs={0} onDismiss={onDismiss} />,
    );
    act(() => {
      jest.advanceTimersByTime(60000);
    });
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('autoDismissMs=2000 override fires at 2000ms', () => {
    const onDismiss = jest.fn();
    render(
      <ToastBanner
        type="warn"
        message="msg"
        autoDismissMs={2000}
        onDismiss={onDismiss}
      />,
    );
    act(() => {
      jest.advanceTimersByTime(1999);
    });
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('unmount before timer expiry → onDismiss is NOT called (cleanup verified)', () => {
    const onDismiss = jest.fn();
    const { unmount } = render(
      <ToastBanner type="warn" message="msg" onDismiss={onDismiss} />,
    );
    act(() => {
      jest.advanceTimersByTime(2000);
    });
    unmount();
    act(() => {
      jest.advanceTimersByTime(10000);
    });
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('changing message re-arms the timer', () => {
    const onDismiss = jest.fn();
    const { rerender } = render(
      <ToastBanner type="warn" message="first" onDismiss={onDismiss} />,
    );
    act(() => {
      jest.advanceTimersByTime(3000);
    });
    expect(onDismiss).not.toHaveBeenCalled();

    rerender(<ToastBanner type="warn" message="second" onDismiss={onDismiss} />);
    act(() => {
      // 3000 more ms — total 6000 since first mount, but only 3000 since re-arm.
      jest.advanceTimersByTime(3000);
    });
    expect(onDismiss).not.toHaveBeenCalled();

    act(() => {
      jest.advanceTimersByTime(1000);
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('accessibilityRole is "alert" for warn and "status" for info and pending', () => {
    const { getByTestId, rerender } = render(
      <ToastBanner type="warn" message="m" testID="b" />,
    );
    expect(getByTestId('b').props.accessibilityRole).toBe('alert');

    rerender(<ToastBanner type="info" message="m" testID="b" />);
    expect(getByTestId('b').props.accessibilityRole).toBe('status');

    rerender(<ToastBanner type="pending" message="m" testID="b" />);
    expect(getByTestId('b').props.accessibilityRole).toBe('status');
  });

  it('uses dark theme tokens when system scheme is dark', () => {
    mockedUseTheme.mockReturnValue(darkTheme);
    const { getByTestId } = render(
      <ToastBanner type="warn" message="m" testID="b" />,
    );
    const style = flattenStyle(getByTestId('b').props.style);
    expect(style.backgroundColor).toBe(darkTheme.colors.tan);
    expect(darkTheme.colors.tan).toBe(lightTheme.colors.tan); // sanity: same hue
  });

  it('uses dark theme sage for info', () => {
    mockedUseTheme.mockReturnValue(darkTheme);
    const { getByTestId } = render(
      <ToastBanner type="info" message="m" testID="b" />,
    );
    const style = flattenStyle(getByTestId('b').props.style);
    expect(style.backgroundColor).toBe(darkTheme.colors.sage);
  });

  it('does not render when visible=false', () => {
    const { queryByTestId } = render(
      <ToastBanner type="warn" message="m" visible={false} testID="b" />,
    );
    expect(queryByTestId('b')).toBeNull();
  });

  it('does not start a timer while visible=false (no phantom dismiss)', () => {
    const onDismiss = jest.fn();
    const { rerender } = render(
      <ToastBanner type="warn" message="m" visible={false} onDismiss={onDismiss} />,
    );
    act(() => {
      jest.advanceTimersByTime(10000);
    });
    expect(onDismiss).not.toHaveBeenCalled();

    rerender(<ToastBanner type="warn" message="m" visible={true} onDismiss={onDismiss} />);
    act(() => {
      jest.advanceTimersByTime(4000);
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  describe('pending variant — E7-005 surface', () => {
    it('renders the leading clock glyph (◷) for pending', () => {
      const { UNSAFE_getByProps } = render(
        <ToastBanner type="pending" message="3 syncing" testID="b" />,
      );
      // The glyph is hidden from screen readers (accessibilityElementsHidden)
      // which makes it invisible to getByTestId/getByText queries. Use the
      // unsafe-by-props escape hatch — the testID we set is unique enough.
      const glyph = UNSAFE_getByProps({ testID: 'b-pending-glyph' });
      expect(glyph.props.children).toBe('◷');
    });

    it('does NOT render the clock glyph for warn or info', () => {
      const { UNSAFE_queryByProps, rerender } = render(
        <ToastBanner type="warn" message="m" testID="b" />,
      );
      expect(UNSAFE_queryByProps({ testID: 'b-pending-glyph' })).toBeNull();

      rerender(<ToastBanner type="info" message="m" testID="b" />);
      expect(UNSAFE_queryByProps({ testID: 'b-pending-glyph' })).toBeNull();
    });

    it('pending message text uses fontStyle: italic', () => {
      const { getByText } = render(
        <ToastBanner type="pending" message="queued copy" testID="b" />,
      );
      const style = flattenStyle(getByText('queued copy').props.style);
      expect(style.fontStyle).toBe('italic');
    });

    it('warn and info message text DO NOT use fontStyle: italic (additive only)', () => {
      const { getByText, rerender } = render(
        <ToastBanner type="warn" message="warn copy" />,
      );
      const warnStyle = flattenStyle(getByText('warn copy').props.style);
      expect(warnStyle.fontStyle).toBeUndefined();

      rerender(<ToastBanner type="info" message="info copy" />);
      const infoStyle = flattenStyle(getByText('info copy').props.style);
      expect(infoStyle.fontStyle).toBeUndefined();
    });

    it('pending glyph is hidden from screen readers', () => {
      const { UNSAFE_getByProps } = render(
        <ToastBanner type="pending" message="m" testID="b" />,
      );
      const glyph = UNSAFE_getByProps({ testID: 'b-pending-glyph' });
      expect(glyph.props.accessibilityElementsHidden).toBe(true);
      expect(glyph.props.importantForAccessibility).toBe('no-hide-descendants');
    });

    it('reduce-motion ON: no Animated.loop is started for pending', () => {
      mockedUseReduceMotion.mockReturnValue(true);
      const loopSpy = jest.spyOn(Animated, 'loop');
      render(<ToastBanner type="pending" message="m" testID="b" />);
      expect(loopSpy).not.toHaveBeenCalled();
      loopSpy.mockRestore();
    });

    it('reduce-motion ON: no Animated.timing is fired for pending', () => {
      mockedUseReduceMotion.mockReturnValue(true);
      const timingSpy = jest.spyOn(Animated, 'timing');
      render(<ToastBanner type="pending" message="m" testID="b" />);
      expect(timingSpy).not.toHaveBeenCalled();
      timingSpy.mockRestore();
    });

    it('reduce-motion ON: glyph initial opacity is 1 (end-state, not min)', () => {
      mockedUseReduceMotion.mockReturnValue(true);
      const { UNSAFE_getByProps } = render(
        <ToastBanner type="pending" message="m" testID="b" />,
      );
      const glyph = UNSAFE_getByProps({ testID: 'b-pending-glyph' });
      // Animated.Text receives an Animated.Value as `opacity`; in the test
      // env the latest value is exposed via `__getValue()`.
      const flat = flattenStyle(glyph.props.style);
      const opacity = flat.opacity as { __getValue: () => number };
      expect(opacity.__getValue()).toBe(1);
    });

    it('reduce-motion async-resolve race: even with hook synchronously false, initial opacity is 1', () => {
      // useReduceMotion returns false synchronously and only flips to the
      // OS-reported value once isReduceMotionEnabled() resolves on the next
      // tick. This is the Wave 1 race: a reduce-motion user must NOT see
      // anything below opacity 1.0 in that brief async window. Verifies
      // pulseOpacity inits at PULSE_END_OPACITY regardless of the hook's
      // synchronous return.
      mockedUseReduceMotion.mockReturnValue(false);
      // Stub Animated.loop so the real loop doesn't drive the value down
      // before we read it.
      const loopSpy = jest
        .spyOn(Animated, 'loop')
        .mockReturnValue({
          start: jest.fn(),
          stop: jest.fn(),
        } as unknown as Animated.CompositeAnimation);

      const { UNSAFE_getByProps } = render(
        <ToastBanner type="pending" message="m" testID="b" />,
      );
      const glyph = UNSAFE_getByProps({ testID: 'b-pending-glyph' });
      const flat = flattenStyle(glyph.props.style);
      const opacity = flat.opacity as { __getValue: () => number };
      expect(opacity.__getValue()).toBe(1);

      loopSpy.mockRestore();
    });

    it('reduce-motion OFF: starts an Animated.loop for the pending pulse', () => {
      mockedUseReduceMotion.mockReturnValue(false);
      const loopSpy = jest.spyOn(Animated, 'loop');
      render(<ToastBanner type="pending" message="m" testID="b" />);
      expect(loopSpy).toHaveBeenCalledTimes(1);
      loopSpy.mockRestore();
    });

    it('reduce-motion OFF: no loop started for warn or info (pulse is pending-only)', () => {
      mockedUseReduceMotion.mockReturnValue(false);
      const loopSpy = jest.spyOn(Animated, 'loop');
      const { rerender } = render(<ToastBanner type="warn" message="m" />);
      rerender(<ToastBanner type="info" message="m" />);
      expect(loopSpy).not.toHaveBeenCalled();
      loopSpy.mockRestore();
    });

    it('onRetry provided: renders RETRY CTA and fires callback on tap', () => {
      const onRetry = jest.fn();
      const { getByTestId } = render(
        <ToastBanner type="pending" message="m" onRetry={onRetry} testID="b" />,
      );
      const retry = getByTestId('b-retry');
      expect(retry.props.accessibilityRole).toBe('button');
      expect(retry.props.accessibilityLabel).toBe('Retry');
      fireEvent.press(retry);
      expect(onRetry).toHaveBeenCalledTimes(1);
    });

    it('onRetry NOT provided: no Retry CTA in the tree', () => {
      const { queryByTestId, queryByText } = render(
        <ToastBanner type="pending" message="m" testID="b" />,
      );
      expect(queryByTestId('b-retry')).toBeNull();
      expect(queryByText('RETRY')).toBeNull();
    });

    it('onRetry on warn does NOT render the Retry CTA (pending-only contract)', () => {
      const onRetry = jest.fn();
      const { queryByTestId } = render(
        <ToastBanner type="warn" message="m" onRetry={onRetry} testID="b" />,
      );
      expect(queryByTestId('b-retry')).toBeNull();
    });

    it('pending uses dark theme tan background', () => {
      mockedUseTheme.mockReturnValue(darkTheme);
      const { getByTestId } = render(
        <ToastBanner type="pending" message="m" testID="b" />,
      );
      const style = flattenStyle(getByTestId('b').props.style);
      expect(style.backgroundColor).toBe(darkTheme.colors.tan);
    });

    it('pending wrapper carries accessibilityRole=status (cast through AccessibilityRole)', () => {
      const { getByTestId } = render(
        <ToastBanner type="pending" message="m" testID="b" />,
      );
      expect(getByTestId('b').props.accessibilityRole).toBe('status');
    });

    it('strict-mode-style double mount does not double-start the loop (cleanup verified)', () => {
      const loopSpy = jest.spyOn(Animated, 'loop');
      const fakeLoop = { start: jest.fn(), stop: jest.fn() };
      // Force every Animated.loop() call to return the same fake controller
      // so we can count start/stop pairs across remounts.
      loopSpy.mockReturnValue(fakeLoop as unknown as Animated.CompositeAnimation);

      const { unmount } = render(
        <ToastBanner type="pending" message="m" testID="b" />,
      );
      unmount();
      const { unmount: unmount2 } = render(
        <ToastBanner type="pending" message="m" testID="b" />,
      );
      unmount2();

      // Each mount should start once and stop once on unmount — never a
      // dangling start without a matching stop.
      expect(fakeLoop.start.mock.calls.length).toBe(fakeLoop.stop.mock.calls.length);
      expect(fakeLoop.start.mock.calls.length).toBeGreaterThanOrEqual(2);
      loopSpy.mockRestore();
    });

    it('action prop still works on pending alongside onRetry (additive, not exclusive)', () => {
      const onAction = jest.fn();
      const onRetry = jest.fn();
      const { getByText, getByTestId } = render(
        <ToastBanner
          type="pending"
          message="m"
          action={{ label: 'Dismiss', onPress: onAction }}
          onRetry={onRetry}
          testID="b"
        />,
      );
      fireEvent.press(getByText('Dismiss'));
      expect(onAction).toHaveBeenCalledTimes(1);
      fireEvent.press(getByTestId('b-retry'));
      expect(onRetry).toHaveBeenCalledTimes(1);
    });
  });
});

