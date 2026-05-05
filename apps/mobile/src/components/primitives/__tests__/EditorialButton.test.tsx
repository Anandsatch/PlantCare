import { darkTheme, fonts, lightTheme } from '@plantcare/theme';
import { fireEvent, render } from '@testing-library/react-native';
import { ActivityIndicator } from 'react-native';

import { useTheme } from '../../../hooks/useTheme';
import { EditorialButton } from '../EditorialButton';

// Hook is mocked at the module boundary so each test can pivot the active
// theme. Mocking useTheme (rather than RN's useColorScheme) keeps the test
// scope on this primitive — useTheme already has its own scheme-mapping suite.
jest.mock('../../../hooks/useTheme', () => ({
  useTheme: jest.fn(),
}));

const mockedUseTheme = useTheme as unknown as jest.Mock<ReturnType<typeof useTheme>, []>;

// Resolve the rendered Pressable from RTL without coupling to text labels —
// the component sets accessibilityRole='button', which is the public contract.
function findButton(api: ReturnType<typeof render>) {
  return api.getByRole('button');
}

// flatten() works on any StyleProp shape (object | array | array-of-arrays)
// returned by RN's StyleSheet flattening. Pressable's style callback returns
// an array; React's render layer flattens it before painting, so we walk it
// here to assert merged-style values.
function flattenStyle(style: unknown): Record<string, unknown> {
  if (Array.isArray(style)) {
    return style.reduce<Record<string, unknown>>((acc, s) => ({ ...acc, ...flattenStyle(s) }), {});
  }
  if (style && typeof style === 'object') {
    return style as Record<string, unknown>;
  }
  return {};
}

// Pressable's `style` prop is the function form here. Invoke it with the
// pressed=false default so we can assert the resting style without simulating
// touch events.
function restingStyle(button: ReturnType<typeof findButton>): Record<string, unknown> {
  const styleProp = button.props.style;
  const resolved = typeof styleProp === 'function' ? styleProp({ pressed: false }) : styleProp;
  return flattenStyle(resolved);
}

describe('EditorialButton', () => {
  beforeEach(() => {
    mockedUseTheme.mockReset();
    mockedUseTheme.mockReturnValue(lightTheme);
  });

  it('renders the outline variant with surface background and text-color border', () => {
    const api = render(<EditorialButton variant="outline" label="Add note" onPress={() => {}} />);
    const button = findButton(api);
    const style = restingStyle(button);

    expect(style.backgroundColor).toBe(lightTheme.colors.surface);
    expect(style.borderColor).toBe(lightTheme.colors.text);
    expect(style.borderWidth).toBe(1);
    expect(api.getByText('Add note')).toBeOnTheScreen();
  });

  it('renders the filled variant with text-color background and surface label', () => {
    const api = render(<EditorialButton variant="filled" label="Mark watered" onPress={() => {}} />);
    const button = findButton(api);
    const style = restingStyle(button);

    expect(style.backgroundColor).toBe(lightTheme.colors.text);
    expect(style.borderWidth).toBe(0);

    const labelStyle = flattenStyle(api.getByText('Mark watered').props.style);
    expect(labelStyle.color).toBe(lightTheme.colors.surface);
    expect(labelStyle.fontFamily).toBe(fonts.display.semibold);
  });

  it('fires onPress when tapped', () => {
    const onPress = jest.fn();
    const api = render(<EditorialButton variant="filled" label="Save" onPress={onPress} />);

    fireEvent.press(findButton(api));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('does not fire onPress when disabled', () => {
    const onPress = jest.fn();
    const api = render(
      <EditorialButton variant="filled" label="Save" onPress={onPress} disabled />,
    );

    fireEvent.press(findButton(api));
    expect(onPress).not.toHaveBeenCalled();
  });

  it('sets accessibilityState.disabled = true when disabled', () => {
    const api = render(
      <EditorialButton variant="outline" label="Save" onPress={() => {}} disabled />,
    );
    const button = findButton(api);

    expect(button.props.accessibilityState).toEqual(
      expect.objectContaining({ disabled: true, busy: false }),
    );
  });

  it('shows ActivityIndicator and hides the label while loading', () => {
    const api = render(
      <EditorialButton variant="filled" label="Save" onPress={() => {}} loading />,
    );

    expect(api.queryByText('Save')).toBeNull();
    expect(api.UNSAFE_getByType(ActivityIndicator)).toBeTruthy();
  });

  it('sets accessibilityState.busy = true and prevents onPress while loading', () => {
    const onPress = jest.fn();
    const api = render(
      <EditorialButton variant="filled" label="Save" onPress={onPress} loading />,
    );
    const button = findButton(api);

    expect(button.props.accessibilityState).toEqual(
      expect.objectContaining({ disabled: true, busy: true }),
    );
    fireEvent.press(button);
    expect(onPress).not.toHaveBeenCalled();
  });

  it('drops a second synchronous press in the same render (double-tap latch)', () => {
    // Codex P2: two synchronous presses fired before the parent can flip
    // loading=true. The internal ref-based latch must drop the second press
    // even though the rendered `disabled` flag is still false.
    jest.useFakeTimers();
    try {
      const onPress = jest.fn();
      const api = render(
        <EditorialButton variant="filled" label="Save" onPress={onPress} />,
      );
      const button = findButton(api);

      fireEvent.press(button);
      fireEvent.press(button);

      expect(onPress).toHaveBeenCalledTimes(1);

      // After the latch clears (next macrotask), presses are accepted again.
      jest.runAllTimers();
      fireEvent.press(button);
      expect(onPress).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('blocks rapid double-taps once a tap flips the parent into loading', () => {
    // Codex P2-class race: a fast double-tap fires twice before the parent
    // transitions to loading. We can't prevent the *first* double-tap inside
    // a single render (parent state is the gate), but we *can* guarantee that
    // once loading=true is set, every subsequent press is dropped.
    const onPress = jest.fn();
    const api = render(
      <EditorialButton variant="filled" label="Save" onPress={onPress} loading={false} />,
    );

    fireEvent.press(findButton(api));
    expect(onPress).toHaveBeenCalledTimes(1);

    api.rerender(<EditorialButton variant="filled" label="Save" onPress={onPress} loading />);
    fireEvent.press(findButton(api));
    fireEvent.press(findButton(api));

    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('applies hitSlop sufficient to clear the 44px floor on the vertical axis', () => {
    const api = render(<EditorialButton variant="filled" label="Save" onPress={() => {}} />);
    const button = findButton(api);
    const slop = button.props.hitSlop ?? {};
    const style = restingStyle(button);

    // Visual minHeight + 2 × vertical hitSlop must reach 44.
    const minHeight = (style.minHeight as number) ?? 0;
    const top = slop.top ?? 0;
    const bottom = slop.bottom ?? 0;
    expect(minHeight + top + bottom).toBeGreaterThanOrEqual(44);
  });

  it('defaults accessibilityLabel to label and lets the prop override', () => {
    const a = render(<EditorialButton variant="outline" label="Add note" onPress={() => {}} />);
    expect(findButton(a).props.accessibilityLabel).toBe('Add note');

    const b = render(
      <EditorialButton
        variant="outline"
        label="Add note"
        onPress={() => {}}
        accessibilityLabel="Add a note about this plant"
      />,
    );
    expect(findButton(b).props.accessibilityLabel).toBe('Add a note about this plant');
  });

  it('inverts correctly under the Midnight (dark) theme', () => {
    mockedUseTheme.mockReturnValue(darkTheme);
    const api = render(
      <EditorialButton variant="filled" label="Mark watered" onPress={() => {}} />,
    );
    const style = restingStyle(findButton(api));

    // In Midnight, theme.text is cream and theme.surface is forest. Filled
    // background must follow the text token (cream) and the label must
    // follow the surface token (forest).
    expect(style.backgroundColor).toBe(darkTheme.colors.text);
    const labelStyle = flattenStyle(api.getByText('Mark watered').props.style);
    expect(labelStyle.color).toBe(darkTheme.colors.surface);
  });

  it('forwards testID for end-to-end Maestro hooks', () => {
    const api = render(
      <EditorialButton variant="filled" label="Save" onPress={() => {}} testID="save-button" />,
    );
    expect(api.getByTestId('save-button')).toBeTruthy();
  });
});
