// FAB primitive tests (E2-009).
//
// Coverage:
//  - Renders 56×56 circle
//  - tap fires onPress
//  - long-press fires onLongPress
//  - accessibilityActions absent when onLongPress is undefined
//  - accessibilityActions present + 'longpress' included when onLongPress is set
//  - onAccessibilityAction routes the 'longpress' action to onLongPress
//    (screen-reader fallback for users who can't physically long-press)
//  - disabled blocks both onPress and onLongPress
//  - default accessibilityLabel = 'Add a plant'
//  - custom accessibilityLabel overrides
//  - accessibilityHint defaults to 'Long-press for quick diagnose' when
//    onLongPress is provided; undefined otherwise
//  - dark theme: bg uses theme.text token, which resolves to dark variant
//  - custom icon prop renders in place of default

import { darkTheme, lightTheme } from '@plantcare/theme';
import { fireEvent, render } from '@testing-library/react-native';
import * as RN from 'react-native';
import { Text } from 'react-native';

import { FAB, fabStyles } from '../FAB';
import { StyleSheet } from 'react-native';

// We don't replace the whole 'react-native' module (jest-expo's preset already
// shimmed the native turbomodules; replacing it pulls in DevMenu native bindings
// that fail outside the simulator). Instead we spy on useColorScheme so the
// hook drives the FAB through both the light and dark code paths.
type WidenedScheme = 'light' | 'dark' | 'unspecified' | null | undefined;
const useColorSchemeSpy = jest.spyOn(RN, 'useColorScheme') as unknown as jest.Mock<
  WidenedScheme,
  []
>;

function flattenStyle(style: unknown): Record<string, unknown> {
  if (Array.isArray(style)) {
    return style.reduce<Record<string, unknown>>(
      (acc, entry) => ({ ...acc, ...flattenStyle(entry) }),
      {},
    );
  }
  if (style && typeof style === 'object') {
    return style as Record<string, unknown>;
  }
  return {};
}

describe('FAB', () => {
  beforeEach(() => {
    useColorSchemeSpy.mockReturnValue('light');
  });

  afterAll(() => {
    useColorSchemeSpy.mockRestore();
  });

  it('renders a 56×56 circle', () => {
    const { getByRole } = render(<FAB onPress={jest.fn()} />);
    // RN's Pressable resolves the function-style before exposing it to the
    // host node, so props.style is already flattened. flattenStyle no-ops on
    // a plain object, which is how this assertion stays stable.
    const style = flattenStyle(getByRole('button').props.style);
    expect(style.width).toBe(56);
    expect(style.height).toBe(56);
    expect(style.borderRadius).toBe(28);
  });

  it('tap fires onPress', () => {
    const onPress = jest.fn();
    const { getByRole } = render(<FAB onPress={onPress} />);
    fireEvent.press(getByRole('button'));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('long-press fires onLongPress', () => {
    const onPress = jest.fn();
    const onLongPress = jest.fn();
    const { getByRole } = render(<FAB onPress={onPress} onLongPress={onLongPress} />);
    fireEvent(getByRole('button'), 'longPress');
    expect(onLongPress).toHaveBeenCalledTimes(1);
    // Long-press should NOT have triggered the tap path.
    expect(onPress).not.toHaveBeenCalled();
  });

  it('omits accessibilityActions when onLongPress is undefined', () => {
    const { getByRole } = render(<FAB onPress={jest.fn()} />);
    const pressable = getByRole('button');
    expect(pressable.props.accessibilityActions).toBeUndefined();
    expect(pressable.props.onAccessibilityAction).toBeUndefined();
  });

  it("includes the 'longpress' accessibilityAction when onLongPress is provided", () => {
    const { getByRole } = render(
      <FAB onPress={jest.fn()} onLongPress={jest.fn()} />,
    );
    const actions = getByRole('button').props.accessibilityActions as
      | ReadonlyArray<{ name: string; label?: string }>
      | undefined;
    expect(actions).toBeDefined();
    expect(actions?.some((a) => a.name === 'longpress')).toBe(true);
  });

  it('routes the longpress accessibility action to onLongPress (screen-reader fallback)', () => {
    const onLongPress = jest.fn();
    const { getByRole } = render(
      <FAB onPress={jest.fn()} onLongPress={onLongPress} />,
    );
    const handler = getByRole('button').props.onAccessibilityAction as (
      e: { nativeEvent: { actionName: string } },
    ) => void;
    handler({ nativeEvent: { actionName: 'longpress' } });
    expect(onLongPress).toHaveBeenCalledTimes(1);

    // Other action names must not invoke onLongPress.
    handler({ nativeEvent: { actionName: 'activate' } });
    expect(onLongPress).toHaveBeenCalledTimes(1);
  });

  it('disabled prevents onPress, onLongPress, and the longpress accessibility-action path', () => {
    const onPress = jest.fn();
    const onLongPress = jest.fn();
    const { getByRole } = render(
      <FAB onPress={onPress} onLongPress={onLongPress} disabled />,
    );
    const pressable = getByRole('button');
    fireEvent.press(pressable);
    fireEvent(pressable, 'longPress');
    expect(onPress).not.toHaveBeenCalled();
    expect(onLongPress).not.toHaveBeenCalled();
    expect(pressable.props.accessibilityState).toEqual({ disabled: true });
    // Critically: the accessibility-action path must also be inert when
    // disabled. Otherwise a TalkBack user could still invoke onLongPress via
    // the actions menu while the visual control is gated off.
    expect(pressable.props.accessibilityActions).toBeUndefined();
    expect(pressable.props.onAccessibilityAction).toBeUndefined();
  });

  it("defaults accessibilityLabel to 'Add a plant'", () => {
    const { getByRole } = render(<FAB onPress={jest.fn()} />);
    expect(getByRole('button').props.accessibilityLabel).toBe('Add a plant');
  });

  it('custom accessibilityLabel overrides the default', () => {
    const { getByRole } = render(
      <FAB onPress={jest.fn()} accessibilityLabel="Plant something new" />,
    );
    expect(getByRole('button').props.accessibilityLabel).toBe('Plant something new');
  });

  it("defaults accessibilityHint to 'Long-press for quick diagnose' when onLongPress is provided, undefined otherwise", () => {
    const { getByRole, rerender } = render(<FAB onPress={jest.fn()} />);
    expect(getByRole('button').props.accessibilityHint).toBeUndefined();

    rerender(<FAB onPress={jest.fn()} onLongPress={jest.fn()} />);
    expect(getByRole('button').props.accessibilityHint).toBe(
      'Long-press for quick diagnose',
    );
  });

  it('respects an explicit accessibilityHint override', () => {
    const { getByRole } = render(
      <FAB onPress={jest.fn()} onLongPress={jest.fn()} accessibilityHint="Custom hint" />,
    );
    expect(getByRole('button').props.accessibilityHint).toBe('Custom hint');
  });

  it('dark theme: backgroundColor uses theme.text (Midnight cream)', () => {
    useColorSchemeSpy.mockReturnValue('dark');
    const { getByRole } = render(<FAB onPress={jest.fn()} />);
    const style = flattenStyle(getByRole('button').props.style);
    expect(style.backgroundColor).toBe(darkTheme.colors.text);
    // Sanity: light + dark differ. If they ever collapse, the theme regressed.
    expect(darkTheme.colors.text).not.toBe(lightTheme.colors.text);
  });

  it('custom icon prop renders in place of the default "+"', () => {
    const { queryByTestId, getByText } = render(
      <FAB onPress={jest.fn()} icon={<Text>★</Text>} />,
    );
    expect(getByText('★')).toBeTruthy();
    expect(queryByTestId('fab-default-icon')).toBeNull();
  });

  it('default icon renders when no icon prop is supplied', () => {
    const { getByTestId } = render(<FAB onPress={jest.fn()} />);
    expect(getByTestId('fab-default-icon')).toBeTruthy();
  });

  it('idle render has no opacity override; pressed-state contract is opacity 0.85', () => {
    const { getByRole } = render(<FAB onPress={jest.fn()} />);
    // Pressable resolves its function-style on render with pressed=false. We
    // verify the idle branch through the host node, and the pressed branch
    // through the StyleSheet contract — V1 ships a static rule (no Reanimated,
    // no scale transform), so a structural assertion is equivalent to the
    // runtime contract Pressable will apply on press.
    const idle = flattenStyle(getByRole('button').props.style);
    expect(idle.opacity).toBeUndefined();
    const pressedRule = StyleSheet.flatten(fabStyles.pressed) as { opacity?: number };
    expect(pressedRule.opacity).toBe(0.85);
    // No transform / scale — explicit V1 lock against Reanimated tweens.
    expect((pressedRule as Record<string, unknown>).transform).toBeUndefined();
  });
});
