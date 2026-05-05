// FAB — floating action button primitive (E2-009).
//
// Usage on Plants list (A-1):
//   - Tap → camera capture in identify mode
//   - Long-press → popover ("Add a plant" / "Quick diagnose"); popover is
//     wired in E3-004, this primitive only plumbs the onLongPress callback.
//
// Visual: 56×56 forest circle with cream "+" icon. The 56×56 size is the
// Material Design FAB default and exceeds the 44×44 a11y minimum, so no
// hitSlop is needed. Positioning is the parent's responsibility — the
// primitive does not absolutely position itself, so it composes inside any
// container (the A-1 screen anchors it bottom-right).
//
// A11y notes:
//   - accessibilityRole='button'
//   - accessibilityLabel defaults to 'Add a plant'
//   - accessibilityHint is set to 'Long-press for quick diagnose' ONLY when
//     onLongPress is provided. Announcing a long-press affordance that does
//     nothing would be worse than silence.
//   - When onLongPress is provided we also expose an `accessibilityActions`
//     entry named 'longpress' with onAccessibilityAction routing it to
//     onLongPress(). Per React Native's accessibility docs the 'longpress'
//     action is surfaced by TalkBack on Android (the local-context menu);
//     iOS VoiceOver does not surface it as a discoverable rotor action. The
//     accessibilityHint copy ("Long-press for quick diagnose") therefore
//     remains the iOS-side affordance — sighted-but-motor-impaired users on
//     iOS still get the hint announcement and can attempt the gesture; the
//     E3-004 popover provides the accessible Quick Diagnose alternative path.
//
// Pressed state: opacity 0.85 via Pressable's style callback (RN built-in,
// no Reanimated dep — V1 scope lock). Scale was the alternative; we chose
// opacity to avoid a transform that could compound with the parent's layout.

import type { ReactNode } from 'react';
import {
  type AccessibilityActionEvent,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  type ViewStyle,
} from 'react-native';

import { useTheme } from '../../hooks';

const SIZE = 56;
const PRESSED_OPACITY = 0.85;

export type FABProps = {
  onPress: () => void;
  onLongPress?: () => void;
  icon?: ReactNode;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  disabled?: boolean;
  testID?: string;
};

export function FAB({
  onPress,
  onLongPress,
  icon,
  accessibilityLabel = 'Add a plant',
  accessibilityHint,
  disabled = false,
  testID,
}: FABProps) {
  const theme = useTheme();

  // Hint defaults to the long-press affordance copy when long-press is wired,
  // and stays undefined otherwise so screen readers don't announce a gesture
  // that has no handler.
  const resolvedHint =
    accessibilityHint ?? (onLongPress ? 'Long-press for quick diagnose' : undefined);

  // accessibilityActions only surfaces when there's a real handler AND the
  // control isn't disabled. Disabled must mean "no path reaches the
  // callback" — including the TalkBack actions-menu path, which would
  // otherwise let a screen-reader user invoke an action the FAB visually
  // rejects.
  const accessibilityActions =
    onLongPress && !disabled
      ? ([{ name: 'longpress', label: 'Quick diagnose' }] as const)
      : undefined;

  const handleAccessibilityAction =
    onLongPress && !disabled
      ? (event: AccessibilityActionEvent) => {
          if (event.nativeEvent.actionName === 'longpress') {
            onLongPress();
          }
        }
      : undefined;

  const baseStyle: ViewStyle = {
    width: SIZE,
    height: SIZE,
    borderRadius: SIZE / 2,
    backgroundColor: theme.colors.text,
    alignItems: 'center',
    justifyContent: 'center',
    // Cross-platform shadow. iOS reads shadow*; Android needs elevation.
    shadowColor: theme.colors.text,
    shadowOpacity: 0.15,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 3,
  };

  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      disabled={disabled}
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={resolvedHint}
      accessibilityState={{ disabled }}
      accessibilityActions={
        accessibilityActions as unknown as { name: string; label?: string }[] | undefined
      }
      onAccessibilityAction={handleAccessibilityAction}
      style={({ pressed }) => [baseStyle, pressed && !disabled ? styles.pressed : null]}
    >
      {icon ?? (
        // Default icon: Fraunces "+" sized 28. Per the master plan this can be
        // upgraded to an SVG cross once react-native-svg lands as a dep
        // (not in this PR's history). A Text "+" reads correctly even before
        // Fraunces finishes loading because RN falls back to system "+" with
        // the same glyph metrics.
        <Text
          // Marker testID on the default glyph helps tests assert the
          // default-vs-custom branch without exporting it from the module.
          testID="fab-default-icon"
          allowFontScaling={false}
          style={[styles.icon, { color: theme.colors.surface }]}
        >
          +
        </Text>
      )}
    </Pressable>
  );
}

// Exported for tests + future composition. The pressed-state contract
// (opacity 0.85, no scale transform — V1 scope lock against Reanimated) is
// asserted directly against this object; Pressable's runtime state machine
// is RN's responsibility.
export const fabStyles = StyleSheet.create({
  pressed: {
    opacity: PRESSED_OPACITY,
  },
  icon: {
    fontSize: 28,
    lineHeight: 32,
    fontWeight: '400',
    // Fraunces if loaded, otherwise system. Both render "+" with correct metrics.
    fontFamily: Platform.select({ ios: 'Fraunces', android: 'Fraunces', default: undefined }),
    textAlign: 'center',
    includeFontPadding: false,
  },
});

const styles = fabStyles;
