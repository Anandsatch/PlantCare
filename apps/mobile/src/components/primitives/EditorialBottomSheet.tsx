/**
 * EditorialBottomSheet — Conservatory bottom sheet primitive (E2-011).
 *
 * A cream surface sliding up from the bottom of the screen. Used by
 * `<AddNoteSheet>` (E8) — the consumer's API drives the prop shape here.
 *
 * Accessibility decisions (codex-reviewed for a11y):
 * - `accessibilityRole='dialog'` + `accessibilityLabel` on the sheet itself
 *   makes VoiceOver / TalkBack announce it as a modal dialog when it opens.
 * - `accessibilityViewIsModal={true}` on iOS marks the sheet as the only
 *   focusable region while it's visible. RN's `Modal` already handles
 *   focus management for the cross-platform case (Android back button via
 *   `onRequestClose`, dismissal on Escape on web), so we lean on it rather
 *   than reimplementing a custom focus trap. The "no-hide-descendants"
 *   approach is impractical because Modal renders into a separate native
 *   container — RN already gives us the trap for free.
 *
 * Reduce-motion:
 * - `AccessibilityInfo.isReduceMotionEnabled()` is checked on mount and on
 *   `reduceMotionChanged`. When on, Modal's `animationType` flips to 'none'
 *   (no slide-in transition) and the spring snap-back on a sub-threshold
 *   drag is replaced by an instant set. This is the inline fallback the
 *   spec calls out — `useReduceMotion()` from E2-004 hadn't merged when
 *   E2-011 shipped, so the 5 lines live here rather than blocking on it.
 *
 * Gesture choice (PanResponder, not gesture-handler):
 * - `react-native-gesture-handler` is in the workspace deps but PanResponder
 *   is sufficient for a single vertical-drag gesture and avoids the
 *   `<GestureHandlerRootView>` wrapper requirement at the app root. V1 stays
 *   dep-light.
 * - PanResponder is bound ONLY to the top drag-zone (handle band), not the
 *   full sheet. This preserves nested ScrollView / FlatList scroll gestures
 *   in `children` (codex P2 fix). A future ticket that needs full-sheet
 *   drag-to-dismiss with composed scroll behavior can switch to
 *   gesture-handler at that point.
 */

import { useTheme } from '../../hooks/useTheme';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  AccessibilityInfo,
  Animated,
  Dimensions,
  Modal,
  PanResponder,
  Pressable,
  StyleSheet,
  View,
  type PanResponderGestureState,
  type ViewStyle,
} from 'react-native';

export type EditorialBottomSheetProps = {
  readonly open: boolean;
  readonly onDismiss: () => void;
  readonly children: ReactNode;
  /** Fraction of screen height the sheet occupies. Default 0.7. */
  readonly heightFraction?: number;
  /** VoiceOver / TalkBack announcement when the sheet opens. */
  readonly accessibilityLabel?: string;
  readonly testID?: string;
};

/**
 * Pure dismiss-decision helper. Extracted so tests can hit the threshold
 * logic directly without wrestling with PanResponder simulation.
 *
 * Threshold is the LARGER of:
 *   - 100px absolute drag distance, OR
 *   - 30% of the sheet's own rendered height
 *
 * The percentage component matters when `heightFraction` is small — a 30%
 * threshold of a 200px sheet is 60px, smaller than the 100px floor, so the
 * 100px floor wins. With a tall sheet (e.g. heightFraction=0.9 on a 900px
 * screen → 810px sheet), the 30% rule (243px) dominates and prevents
 * premature dismissal on a short flick.
 */
export function shouldDismissOnDragRelease(args: {
  readonly dy: number;
  readonly sheetHeight: number;
}): boolean {
  const { dy, sheetHeight } = args;
  if (dy <= 0) return false; // upward / horizontal drags don't dismiss
  const percentageThreshold = sheetHeight * 0.3;
  const threshold = Math.max(100, percentageThreshold);
  return dy >= threshold;
}

export function EditorialBottomSheet(props: EditorialBottomSheetProps) {
  const {
    open,
    onDismiss,
    children,
    heightFraction = 0.7,
    accessibilityLabel = 'Bottom sheet',
    testID,
  } = props;

  const theme = useTheme();
  const [reduceMotion, setReduceMotion] = useState(false);

  // Read reduce-motion state on mount + subscribe to changes. Inline
  // fallback for E2-004 (`useReduceMotion`) which hadn't merged yet.
  useEffect(() => {
    let mounted = true;
    AccessibilityInfo.isReduceMotionEnabled().then((value) => {
      if (mounted) setReduceMotion(value);
    });
    const sub = AccessibilityInfo.addEventListener(
      'reduceMotionChanged',
      (value: boolean) => {
        if (mounted) setReduceMotion(value);
      }
    );
    return () => {
      mounted = false;
      sub.remove();
    };
  }, []);

  // Translation animation for the drag gesture. Resets when the sheet opens.
  const translateY = useRef(new Animated.Value(0)).current;
  const sheetHeight = Dimensions.get('window').height * heightFraction;

  useEffect(() => {
    if (open) translateY.setValue(0);
  }, [open, translateY]);

  // PanResponder is created once (stable identity for the .panHandlers spread)
  // but reads the up-to-date `sheetHeight`, `reduceMotion`, and `onDismiss`
  // through this ref. Recreating the responder on every prop change would
  // re-run `PanResponder.create` and risk dropping an in-flight gesture.
  // The ref pattern keeps the responder stable while the closure stays fresh.
  const latestRef = useRef({ sheetHeight, reduceMotion, onDismiss });
  latestRef.current = { sheetHeight, reduceMotion, onDismiss };

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      // Only claim the gesture once the user has moved meaningfully
      // downward — this lets taps and short horizontal swipes pass
      // through to children (Pressables, scrollable lists, etc.).
      onMoveShouldSetPanResponder: (_evt, gestureState: PanResponderGestureState) =>
        gestureState.dy > 5 && Math.abs(gestureState.dy) > Math.abs(gestureState.dx),
      onPanResponderMove: (_evt, gestureState) => {
        if (gestureState.dy > 0) translateY.setValue(gestureState.dy);
      },
      onPanResponderRelease: (_evt, gestureState) => {
        const latest = latestRef.current;
        const dismiss = shouldDismissOnDragRelease({
          dy: gestureState.dy,
          sheetHeight: latest.sheetHeight,
        });
        if (dismiss) {
          latest.onDismiss();
          // Reset for next open. No animation needed — Modal will hide.
          translateY.setValue(0);
        } else if (latest.reduceMotion) {
          translateY.setValue(0);
        } else {
          Animated.spring(translateY, {
            toValue: 0,
            useNativeDriver: true,
            bounciness: 4,
          }).start();
        }
      },
      onPanResponderTerminate: () => {
        translateY.setValue(0);
      },
    })
  ).current;

  // Render nothing when closed. Modal's `visible` prop already guards this,
  // but the early return makes the no-op explicit and keeps the test for
  // open=false trivially deterministic.
  if (!open) return null;

  // Backdrop alpha is 50% (0.5 → '80' in two-digit hex). Composing onto
  // theme.text gives a near-black scrim in light mode and a near-cream
  // scrim in dark mode — both read as "everything behind is dim".
  const backdropColor = theme.colors.text + '80';

  const sheetStyle: Animated.WithAnimatedValue<ViewStyle> = {
    height: sheetHeight,
    backgroundColor: theme.colors.surface,
    transform: [{ translateY }],
  };

  return (
    <Modal
      visible={open}
      transparent
      animationType={reduceMotion ? 'none' : 'slide'}
      onRequestClose={onDismiss}
      testID={testID}
      // statusBarTranslucent on Android lets the backdrop cover the status bar
      statusBarTranslucent
    >
      <View style={styles.container} testID={testID ? `${testID}-container` : undefined}>
        <Pressable
          style={[StyleSheet.absoluteFill, { backgroundColor: backdropColor }]}
          accessibilityLabel="Close"
          accessibilityRole="button"
          onPress={onDismiss}
          testID={testID ? `${testID}-backdrop` : 'editorial-bottom-sheet-backdrop'}
        />
        <Animated.View
          style={[styles.sheet, sheetStyle]}
          // 'dialog' is a valid AccessibilityRole on iOS / web; the type cast
          // works around the legacy `ViewAccessibility` enum used by
          // `Animated.View`'s prop types.
          accessibilityRole={'dialog' as 'none'}
          accessibilityLabel={accessibilityLabel}
          accessibilityViewIsModal
          importantForAccessibility="yes"
          testID={testID ? `${testID}-sheet` : 'editorial-bottom-sheet'}
        >
          {/* Drag-zone wraps only the top region of the sheet (handle + a
              ~32px hit area around it). PanResponder lives here, NOT on the
              full sheet, so a nested ScrollView / FlatList in `children` keeps
              its gesture intact (codex P2 fix). hitSlop widens the touchable
              area for the handle without enlarging its visible footprint. */}
          <View
            {...panResponder.panHandlers}
            style={styles.dragZone}
            hitSlop={{ top: 8, bottom: 16, left: 24, right: 24 }}
            testID={testID ? `${testID}-drag-zone` : 'editorial-bottom-sheet-drag-zone'}
          >
            <View
              style={[styles.dragHandle, { backgroundColor: theme.colors.stroke }]}
              // Hidden from a11y — the dialog role + label is the announcement,
              // the handle is decorative.
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
              testID={testID ? `${testID}-handle` : undefined}
            />
          </View>
          {children}
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  sheet: {
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingHorizontal: 24,
    paddingBottom: 24,
  },
  dragZone: {
    // Top handle band — exclusive owner of the drag-to-dismiss gesture.
    paddingTop: 12,
    paddingBottom: 8,
    alignItems: 'center',
  },
  dragHandle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    opacity: 0.4,
  },
});
