import { fonts } from '@plantcare/theme';
import { useCameraPermissions } from 'expo-camera';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Linking,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { useTheme } from '../hooks/useTheme';

// E5-003 — Conservatory cream pre-prompt that fronts the iOS / Android camera
// permission dialog. The plan (master plan §"Camera permission") locks this in
// as a V1 hard requirement: a pre-prompt dramatically lifts grant rate over
// the raw OS dialog because users who refuse the pre-prompt can be re-asked
// later, but a denied OS dialog with `canAskAgain=false` is permanent — we
// never want to burn that path on someone who isn't ready.
//
// State machine:
//   resolving — initial state. `useCameraPermissions()` returns `null` on first
//               render and resolves to a real PermissionResponse one render
//               later. Render nothing during this window so users with an
//               already-granted permission never flash the cream pre-prompt
//               between mount and the effect that fires onGranted().
//   idle      — render the cream pre-prompt (Fraunces headline + Inter body
//               + filled forest CTA + ghost cancel). Reached when the OS
//               reports `undetermined` or a non-permanent refusal.
//   requesting — transient; CTA disabled with ActivityIndicator while the OS
//               dialog is in flight. Reached only by tapping the CTA from
//               'idle'. Always transitions out within one awaited call.
//   denied    — render the tan banner-style card "Camera blocked — open
//               Settings to enable" with a forest CTA that fires
//               Linking.openSettings(). Reached when canAskAgain=false either
//               on mount (user previously denied permanently) or after a
//               request response with granted=false && canAskAgain=false.
//   granted   — onGranted() has fired; render nothing. The parent screen owns
//               what comes next (e.g. mounting <CameraView> in E5-004).
//
// Edge cases handled:
//   * Promise rejection from requestPermission → fall back to 'idle' so the
//     user can retry. We treat a thrown error as a transient OS hiccup, not
//     a permanent denial; the next tap will hit the same code path.
//   * Already-granted on mount → onGranted() fires immediately and the
//     component renders null (no flash of the cream card).
//   * Already-permanently-denied on mount (canAskAgain=false, status='denied')
//     → jump straight to 'denied' and surface the Settings recovery path.
//   * Cancel ('Not now') never triggers the OS dialog — V1 lock per the
//     autonomous-build prompt. The parent decides what cancel means.

type State = 'resolving' | 'idle' | 'requesting' | 'denied' | 'granted';

export type CameraPermissionPrePromptProps = {
  /** Called once permission has been granted (either pre-existing on mount or after the request resolves). */
  onGranted: () => void;
  /** Called when the user taps "Not now". V1 lock: this never triggers the OS dialog. */
  onCancel: () => void;
  /** Optional testID forwarded to the root View for E2E selectors. */
  testID?: string;
};

export function CameraPermissionPrePrompt({
  onGranted,
  onCancel,
  testID,
}: CameraPermissionPrePromptProps): React.ReactElement | null {
  const theme = useTheme();
  const [permission, requestPermission] = useCameraPermissions();
  // Start in 'resolving' so we render nothing until the permission hook gives
  // us a real snapshot. Without this, an already-granted user sees the cream
  // pre-prompt for one frame before the effect collapses it (codex P2 from
  // E5-003 adversarial review).
  const [state, setState] = useState<State>('resolving');

  // React to the latest permission snapshot. The hook from expo-camera resolves
  // to `null` on first render, then resolves to a real PermissionResponse on
  // a subsequent render — that's why this is in an effect rather than inline.
  useEffect(() => {
    if (permission == null) return;
    if (permission.granted) {
      setState((prev) => (prev === 'granted' ? prev : 'granted'));
      return;
    }
    if (!permission.canAskAgain) {
      setState((prev) => (prev === 'denied' ? prev : 'denied'));
      return;
    }
    // Fresh undetermined response → leave the user on the cream pre-prompt.
    // Don't clobber 'requesting' (a tap-in-flight) or 'granted' (post-request
    // success): only graduate from the initial 'resolving' window.
    setState((prev) => (prev === 'resolving' ? 'idle' : prev));
  }, [permission]);

  // Fire onGranted exactly once when we reach the 'granted' state. Mount-time
  // grants land here on the second render after the permission hook resolves;
  // post-request grants land here from handlePress.
  useEffect(() => {
    if (state === 'granted') {
      onGranted();
    }
  }, [state, onGranted]);

  const handlePress = useCallback(async () => {
    setState('requesting');
    try {
      const response = await requestPermission();
      if (response.granted) {
        setState('granted');
      } else if (!response.canAskAgain) {
        setState('denied');
      } else {
        // User dismissed the OS dialog without flipping canAskAgain — let
        // them try again from the pre-prompt.
        setState('idle');
      }
    } catch {
      // Treat OS rejections as a transient hiccup: stay in 'idle' so the
      // user can retry without being locked out.
      setState('idle');
    }
  }, [requestPermission]);

  const handleOpenSettings = useCallback(() => {
    void Linking.openSettings();
  }, []);

  // 'resolving': permission hook hasn't given us a snapshot yet. Rendering
  // null avoids a flash of the cream pre-prompt for already-granted users.
  // 'granted': onGranted() has fired; let the parent take over.
  if (state === 'resolving' || state === 'granted') return null;

  if (state === 'denied') {
    return (
      <View
        testID={testID}
        accessibilityLiveRegion="polite"
        style={[styles.card, { backgroundColor: theme.colors.surface, borderColor: theme.colors.tan }]}
      >
        <Text
          accessibilityRole="header"
          style={[styles.headline, { color: theme.colors.text }]}
        >
          Camera blocked
        </Text>
        <Text style={[styles.body, { color: theme.colors.textMuted }]}>
          Open Settings to enable camera access for PlantCare.
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Open the Settings app to enable camera access"
          onPress={handleOpenSettings}
          style={[styles.ctaPrimary, { backgroundColor: theme.colors.primary }]}
        >
          <Text style={[styles.ctaPrimaryLabel, { color: theme.colors.surface }]}>
            Open Settings
          </Text>
        </Pressable>
      </View>
    );
  }

  const isRequesting = state === 'requesting';

  return (
    <View
      testID={testID}
      style={[styles.card, { backgroundColor: theme.colors.surface, borderColor: theme.colors.stroke }]}
    >
      <Text
        accessibilityRole="header"
        style={[styles.headline, { color: theme.colors.text }]}
      >
        PlantCare wants your camera
      </Text>
      <Text style={[styles.body, { color: theme.colors.textMuted }]}>
        To identify and diagnose your plants from photos. We never upload anything you don&apos;t ask us to.
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Allow camera access"
        accessibilityState={{ disabled: isRequesting, busy: isRequesting }}
        disabled={isRequesting}
        onPress={handlePress}
        style={[
          styles.ctaPrimary,
          { backgroundColor: theme.colors.primary },
          isRequesting && styles.ctaPrimaryDisabled,
        ]}
      >
        {isRequesting ? (
          <ActivityIndicator
            testID="camera-pre-prompt-spinner"
            color={theme.colors.surface}
          />
        ) : (
          <Text style={[styles.ctaPrimaryLabel, { color: theme.colors.surface }]}>
            Allow camera access
          </Text>
        )}
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Not now"
        disabled={isRequesting}
        onPress={onCancel}
        style={styles.ctaSecondary}
      >
        <Text style={[styles.ctaSecondaryLabel, { color: theme.colors.text }]}>
          Not now
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  // Conservatory paper card. Hairline border via the theme stroke color (forest
  // in light, cream in dark) per DESIGN.md § Surface treatment. No drop shadow.
  card: {
    borderRadius: 24,
    borderWidth: StyleSheet.hairlineWidth,
    paddingVertical: 32,
    paddingHorizontal: 24,
    gap: 16,
  },
  headline: {
    fontFamily: fonts.display.semibold,
    fontSize: 24,
    // E11-003: 24 × 1.42 = 34 (was 30, ratio 1.25).
    lineHeight: 34,
  },
  body: {
    fontFamily: fonts.body.regular,
    fontSize: 15,
    lineHeight: 22,
  },
  ctaPrimary: {
    marginTop: 8,
    paddingVertical: 14,
    paddingHorizontal: 20,
    borderRadius: 12,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ctaPrimaryDisabled: {
    opacity: 0.7,
  },
  ctaPrimaryLabel: {
    fontFamily: fonts.body.semibold,
    fontSize: 15,
    letterSpacing: 0.2,
  },
  ctaSecondary: {
    paddingVertical: 12,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ctaSecondaryLabel: {
    fontFamily: fonts.body.medium,
    fontSize: 14,
  },
});
