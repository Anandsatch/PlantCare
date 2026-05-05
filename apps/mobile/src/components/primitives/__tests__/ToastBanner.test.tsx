import { darkTheme, lightTheme } from '@plantcare/theme';
import { act, fireEvent, render } from '@testing-library/react-native';

import { ToastBanner } from '../ToastBanner';

// Mock the hook module directly rather than `react-native` itself so we
// don't shadow the rest of RN (FlatList, View, Pressable, Text). Same shape
// as the useTheme test, just one level removed since the primitive doesn't
// import useColorScheme directly.
jest.mock('../../../hooks/useTheme', () => ({
  useTheme: jest.fn(),
}));

import { useTheme } from '../../../hooks/useTheme';
const mockedUseTheme = useTheme as jest.MockedFunction<typeof useTheme>;

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
});

