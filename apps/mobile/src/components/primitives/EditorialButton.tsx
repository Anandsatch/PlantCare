import { fonts } from '@plantcare/theme';
import { useCallback, useRef, type ReactElement } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, type PressableProps } from 'react-native';

import { useTheme } from '../../hooks/useTheme';

// EditorialButton — the only button primitive in V1.
//
// Two variants per the master plan and DESIGN.md:
//   - 'outline': surface (cream) fill, hairline forest border, forest Fraunces label.
//   - 'filled':  text-token (forest in light, sage in dark) fill, surface label.
//
// Tokens invert correctly between Conservatory (light) and Midnight (dark) by
// reading `theme.colors.surface`/`theme.colors.text` via useTheme(). No
// per-variant dark-mode branch — the token table in DESIGN.md is the source of
// truth and `darkTheme` already inverts surface/text.
//
// Sizing: vertical 12 + horizontal 24 around a Fraunces 16px label gives a
// rendered touch target of ~40h × ~110w on the canonical "Mark watered" copy.
// 40 < the WCAG/HIG 44px floor, so we hitSlop +4 vertically; horizontally the
// label always exceeds 44px in real copy ("Mark watered", "Add note", "Add a
// plant"). hitSlop is defensive: any future tighter padding stays at-spec.
//
// Loading state shows ActivityIndicator instead of label and disables onPress.
// Disabled state collapses to opacity 0.4 + onPress no-op. Both states still
// surface accessibilityState ({ disabled, busy }) for VoiceOver/TalkBack.
//
// Pressable's pressed-state style callback is the modern RN idiom (replaces
// TouchableOpacity in V1). The {pressed} flag drives a 0.7 opacity dim while
// held — matches the master plan's "soft press" feel without burning a
// useState round-trip.

const RADIUS = 8;
const PADDING_V = 12;
const PADDING_H = 24;
const MIN_TARGET = 44;

// hitSlop fills any gap below the 44px floor on the vertical axis. With
// 12 + 16 (Fraunces line height ~ font size at default) + 12 = 40, we need 4
// more, split top/bottom.
const HIT_SLOP_V = Math.max(0, Math.ceil((MIN_TARGET - (PADDING_V * 2 + 16)) / 2));
const HIT_SLOP = { top: HIT_SLOP_V, bottom: HIT_SLOP_V, left: 0, right: 0 } as const;

export type EditorialButtonProps = {
  variant: 'outline' | 'filled';
  label: string;
  onPress: () => void;
  disabled?: boolean;
  loading?: boolean;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  testID?: string;
};

export function EditorialButton({
  variant,
  label,
  onPress,
  disabled = false,
  loading = false,
  accessibilityLabel,
  accessibilityHint,
  testID,
}: EditorialButtonProps): ReactElement {
  const theme = useTheme();
  const isInert = disabled || loading;

  // Filled variant: bg = text token, label = surface token.
  // Outline variant: bg = surface token, label + border = text token.
  const bg = variant === 'filled' ? theme.colors.text : theme.colors.surface;
  const fg = variant === 'filled' ? theme.colors.surface : theme.colors.text;
  const borderColor = theme.colors.text;
  const borderWidth = variant === 'outline' ? 1 : 0;

  // Same-render double-tap latch (codex P2): two synchronous presses fired
  // before the parent flips `loading=true` would otherwise both invoke
  // `onPress`, double-submitting mutations. The ref drops every press after
  // the first within a single tick. Cleared on the next macrotask so the
  // button stays responsive once the parent's loading state has settled.
  const pressedThisTickRef = useRef(false);
  const handlePress = useCallback(() => {
    if (isInert || pressedThisTickRef.current) return;
    pressedThisTickRef.current = true;
    setTimeout(() => {
      pressedThisTickRef.current = false;
    }, 0);
    onPress();
  }, [isInert, onPress]);

  // Pressable's style callback is typed as
  //   StyleProp<ViewStyle> | ((state: PressableStateCallbackType) => StyleProp<ViewStyle>)
  // Annotating the parameter as PressableProps['style'] would lose the {pressed}
  // narrowing, so we let the function-form callback infer naturally.
  const styleFn: PressableProps['style'] = ({ pressed }) => [
    styles.base,
    {
      backgroundColor: bg,
      borderColor,
      borderWidth,
    },
    pressed && !isInert && styles.pressed,
    isInert && styles.inert,
  ];

  return (
    <Pressable
      onPress={handlePress}
      disabled={isInert}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: isInert, busy: loading }}
      testID={testID}
      hitSlop={HIT_SLOP}
      style={styleFn}
    >
      {loading ? (
        <ActivityIndicator color={fg} testID={testID ? `${testID}-loading` : undefined} />
      ) : (
        <Text style={[styles.label, { color: fg }]} numberOfLines={1}>
          {label}
        </Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    paddingVertical: PADDING_V,
    paddingHorizontal: PADDING_H,
    borderRadius: RADIUS,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: MIN_TARGET - HIT_SLOP_V * 2, // visual height; hitSlop covers the rest
  },
  label: {
    fontFamily: fonts.display.semibold,
    fontSize: 16,
    lineHeight: 20,
    textAlign: 'center',
  },
  pressed: {
    opacity: 0.7,
  },
  inert: {
    opacity: 0.4,
  },
});
