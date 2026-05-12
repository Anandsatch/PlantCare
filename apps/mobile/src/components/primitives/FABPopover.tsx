/**
 * FABPopover — long-press popover for the A-1 FAB (E3-004).
 *
 * Two menu items: "Add a plant" (tap-equivalent — same destination as the
 * FAB tap) and "Quick diagnose" (the rescue path — A-5 in diagnose mode,
 * no plant or diagnosis saved). Master plan § "FAB behavior on Plants list"
 * locks both copy strings; do not rename without updating that section.
 *
 * # Why a custom popover instead of @gorhom/bottom-sheet / react-native-popover
 *
 * V1 scope locks (master plan + ticket spec): no popover library, no
 * @gorhom/bottom-sheet, no react-native-modal, no Reanimated. RN's built-in
 * `Modal` + a `Pressable` backdrop covers every behavior we need:
 * - statusBar-translucent overlay (Android),
 * - Android hardware-back to dismiss (`onRequestClose`),
 * - tap-outside dismiss (the backdrop Pressable),
 * - automatic focus management when the Modal opens (RN handles
 *   accessibilityViewIsModal-equivalent semantics on iOS via the Modal,
 *   and Android focus is naturally trapped because the host activity is
 *   covered by the modal window).
 *
 * # A11y discipline
 *
 * - Surface is announced as `accessibilityRole='menu'` with the label
 *   "Add a plant menu". Items are `menuitem` role. The cast through
 *   `as 'none'` works around RN's legacy `AccessibilityRole` enum that
 *   doesn't list 'menu' / 'menuitem' literally — both roles are valid on
 *   iOS / web; on Android TalkBack falls back to button announcements.
 * - `accessibilityViewIsModal` on iOS (set on the menu container) marks the
 *   menu as the only focusable region while open — VoiceOver focus can't
 *   leak to the FAB or list rows behind. RN's Modal already gives Android
 *   the same trap because the modal window covers the host.
 * - `importantForAccessibility="yes"` on the menu container ensures
 *   TalkBack reaches the menu first; the backdrop is `accessibilityRole='button'`
 *   so screen-reader users can dismiss it explicitly without finding the
 *   menu first.
 *
 * # Reduce-motion init-at-end-state pattern
 *
 * `useReduceMotion()` resolves async on mount: `false` for the brief window
 * before `AccessibilityInfo.isReduceMotionEnabled()` resolves. If we
 * initialized opacity at 0 and started a fade-in based on that first-render
 * `false`, a Reduce Motion user could see a partial fade before the hook
 * flipped to `true`. Init-at-end-state biases toward "no animation when
 * unknown" which is the safe default. The fade only runs after we've
 * confirmed reduceMotion === false on a render AND it hasn't run yet on
 * this open. Pattern matches E9-003 / E7-005 / E5-012 (CHANGELOG references).
 *
 * # Tap-outside vs item dismiss
 *
 * Backdrop's onPress fires `onDismiss()` only. Item Pressables call the
 * provided handler THEN `onDismiss()`. The order matters: the handler
 * navigates / opens a sheet that may render on top, and the popover
 * dismissing first would briefly flash the unobscured Plants list. Calling
 * the handler first — which itself enqueues a navigation transition —
 * means the dismiss happens after the new screen has started its mount.
 *
 * # StrictMode double-fire defense
 *
 * Each item's onPress is wrapped to mark a per-mount ref before calling
 * onDismiss. A second tap (StrictMode double-mount, double-tap, or a
 * second event firing during the navigation transition) hits the early
 * return and is a no-op. The ref resets when the popover re-opens.
 *
 * # V1 scope locks (rejected)
 * - No @gorhom/bottom-sheet — RN Modal covers our needs.
 * - No react-native-popover — same.
 * - No react-native-modal — RN Modal covers our needs.
 * - No Reanimated — Animated.timing on opacity is sufficient.
 * - No new color tokens — surface / text / tan from the existing Theme.
 * - No state management library — local state.
 */

import { type RefObject, useEffect, useRef } from 'react';
import {
  AccessibilityInfo,
  Animated,
  findNodeHandle,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
  type AccessibilityRole,
  type ViewStyle,
} from 'react-native';

import { useTheme } from '../../hooks/useTheme';
import { useReduceMotion } from '../../hooks/useReduceMotion';

const FADE_IN_MS = 120;

export type FABPopoverProps = {
  readonly open: boolean;
  readonly onDismiss: () => void;
  /** Tap "Add a plant" — same destination as a FAB tap. Master plan A-1 → A-5 identify mode. */
  readonly onAddPlant: () => void;
  /** Tap "Quick diagnose" — A-5 in diagnose mode, no save. Master plan A-1 § FAB behavior. */
  readonly onQuickDiagnose: () => void;
  /**
   * Optional ref to the FAB trigger. When the popover dismisses (tap-outside,
   * back, or item selection that doesn't navigate elsewhere), focus is
   * returned here via `AccessibilityInfo.setAccessibilityFocus` so screen-reader
   * users land back on the trigger they came from instead of getting stranded
   * at the top of the screen. Codex P2 fix.
   */
  readonly triggerRef?: RefObject<unknown>;
  readonly testID?: string;
};

type MenuItem = {
  readonly id: 'add' | 'diagnose';
  readonly label: string;
  readonly handler: () => void;
};

export function FABPopover(props: FABPopoverProps): React.ReactElement | null {
  const { open, onDismiss, onAddPlant, onQuickDiagnose, triggerRef, testID } = props;
  const theme = useTheme();
  const reduceMotion = useReduceMotion();

  // Init-at-end-state. opacity = 1 by default; fade-in only runs when we've
  // confirmed reduceMotion === false on a render AND haven't played yet on
  // THIS open. We track "have we played" by an `openId` counter that
  // increments on each open=false→open=true edge. The effect compares
  // `playedForOpenIdRef` against the current `openId`; this makes the
  // "play once per open" guard StrictMode-safe (a discarded render's
  // cleanup leaves the ref in a state that the replay sees as "already
  // played for this id" and skips the second start). Without the counter,
  // the original `hasPlayedRef = boolean` could leave opacity at 0 if
  // StrictMode discarded the first effect after it set the value to 0
  // and started + stopped the anim. (Codex P1 fix.)
  const opacity = useRef(new Animated.Value(1)).current;
  const openIdRef = useRef(0);
  const playedForOpenIdRef = useRef<number | null>(null);
  const prevOpenRef = useRef(false);
  if (open && !prevOpenRef.current) {
    openIdRef.current += 1;
  }
  prevOpenRef.current = open;
  const currentOpenId = openIdRef.current;

  useEffect(() => {
    if (!open) {
      // No-op when closed; Modal will hide the tree.
      return;
    }
    if (playedForOpenIdRef.current === currentOpenId) return;
    if (reduceMotion) {
      opacity.setValue(1);
      playedForOpenIdRef.current = currentOpenId;
      return;
    }
    // Reduce-motion async window guard (codex P1 fix). `useReduceMotion()`
    // returns false for the brief async window before
    // `AccessibilityInfo.isReduceMotionEnabled()` resolves. If we set
    // opacity=0 + start the timing based on that boot-window false, a Reduce
    // Motion user can see a partial fade. Defensive synchronous probe:
    // initialize opacity at the END state synchronously (=1, already its
    // initial value), then probe asynchronously and only kick off the
    // timing if the OS confirms reduce-motion is OFF. The ASYNC probe
    // means the visible opacity NEVER drops to 0 inside the async window
    // — biased toward "no animation" when unknown, the safe default.
    // Mirrors the WeeklyReviewScreen E9-003 pattern.
    let cancelled = false;
    let activeAnim: Animated.CompositeAnimation | null = null;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((osSaysReduce) => {
        if (cancelled) return;
        if (osSaysReduce) {
          // OS confirms reduce-motion is on. Snap to end state, no timing.
          opacity.setValue(1);
          playedForOpenIdRef.current = currentOpenId;
          return;
        }
        // OS confirms motion is allowed. NOW set the start state and run
        // the fade. Setting setValue(0) inside the resolved branch means
        // the partial-fade window can't open before the OS answer.
        opacity.setValue(0);
        playedForOpenIdRef.current = currentOpenId;
        activeAnim = Animated.timing(opacity, {
          toValue: 1,
          duration: FADE_IN_MS,
          useNativeDriver: true,
        });
        activeAnim.start();
      })
      .catch(() => {
        // Probe failed — snap to end state, skip animation. Biased toward
        // no-motion is the safer fallback.
        if (!cancelled) {
          opacity.setValue(1);
          playedForOpenIdRef.current = currentOpenId;
        }
      });
    return () => {
      cancelled = true;
      if (activeAnim) activeAnim.stop();
    };
  }, [open, reduceMotion, opacity, currentOpenId]);

  // StrictMode + double-tap latch. Once a menu item fires its handler, any
  // subsequent tap on the same OR another item is a no-op. Resets on
  // re-open. The ref pattern matches the camera-flow integration tests'
  // shutter-once latch (E5-012).
  const dispatchedRef = useRef(false);
  useEffect(() => {
    if (open) dispatchedRef.current = false;
  }, [open]);

  // VoiceOver announcement on open — only when accessibility services are
  // active. The Modal's own focus shift announces the menu label, but a
  // belt-and-suspenders announcement covers the rare iOS case where
  // accessibilityViewIsModal doesn't fire the focus shift on the first
  // render frame.
  useEffect(() => {
    if (!open) return;
    AccessibilityInfo.isScreenReaderEnabled()
      .then((enabled) => {
        if (enabled) AccessibilityInfo.announceForAccessibility('Menu opened');
      })
      .catch(() => {
        // Silent — announcement is a nice-to-have, not load-bearing.
      });
  }, [open]);

  // Focus-return on dismiss (codex P2 fix). When the popover transitions
  // from open=true → open=false, hand a11y focus back to the trigger so
  // VoiceOver / TalkBack users don't land at the top of the screen. We
  // use `findNodeHandle(triggerRef.current)` + `setAccessibilityFocus` —
  // the same pattern as WeeklyReviewScreen's setAccessibilityFocus on
  // headlineRef. Silently no-ops if no triggerRef, no current node, or
  // the platform fails to resolve a handle (older Android RN builds).
  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (wasOpenRef.current && !open) {
      const trigger = triggerRef?.current;
      if (trigger) {
        const handle = findNodeHandle(trigger as never);
        if (handle !== null) {
          try {
            AccessibilityInfo.setAccessibilityFocus(handle);
          } catch {
            // Focus moves are nice-to-have, not load-bearing.
          }
        }
      }
    }
    wasOpenRef.current = open;
  }, [open, triggerRef]);

  if (!open) return null;

  const items: ReadonlyArray<MenuItem> = [
    { id: 'add', label: 'Add a plant', handler: onAddPlant },
    { id: 'diagnose', label: 'Quick diagnose', handler: onQuickDiagnose },
  ];

  // Backdrop is a 35% scrim — softer than the bottom-sheet's 50% because the
  // popover is a small floating menu, not a full modal surface. Composing
  // alpha onto theme.text gives a near-black scrim in light mode and a
  // near-cream scrim in dark mode (same approach as EditorialBottomSheet).
  const backdropColor = theme.colors.text + '59'; // 0x59 ≈ 0.35 alpha

  const menuStyle: Animated.WithAnimatedValue<ViewStyle> = {
    backgroundColor: theme.colors.surface,
    borderColor: theme.colors.tan,
    transform: [],
    opacity,
  };

  return (
    <Modal
      visible={open}
      transparent
      animationType="none"
      onRequestClose={onDismiss}
      statusBarTranslucent
      testID={testID}
    >
      <Pressable
        style={[StyleSheet.absoluteFill, { backgroundColor: backdropColor }]}
        accessibilityRole="button"
        accessibilityLabel="Close menu"
        onPress={onDismiss}
        testID={testID ? `${testID}-backdrop` : 'fab-popover-backdrop'}
      />
      <View pointerEvents="box-none" style={styles.anchor}>
        <Animated.View
          style={[styles.menu, menuStyle]}
          // 'menu' is a valid AccessibilityRole on iOS / web. The cast works
          // around RN's legacy enum that types it as a string subset.
          accessibilityRole={'menu' as AccessibilityRole}
          accessibilityLabel="Add a plant menu"
          accessibilityViewIsModal
          importantForAccessibility="yes"
          testID={testID ? `${testID}-menu` : 'fab-popover-menu'}
        >
          {items.map((item, index) => {
            const isLast = index === items.length - 1;
            return (
              <Pressable
                key={item.id}
                onPress={() => {
                  if (dispatchedRef.current) return;
                  dispatchedRef.current = true;
                  // Handler first, then dismiss — see file header.
                  item.handler();
                  onDismiss();
                }}
                accessibilityRole={'menuitem' as AccessibilityRole}
                accessibilityLabel={item.label}
                style={({ pressed }) => [
                  styles.item,
                  // Item divider uses `tan` (warm Conservatory accent that's
                  // theme-invariant per DESIGN.md "Status icon system") so the
                  // hairline matches the menu border and stays within the
                  // locked token set (surface / text / tan). Codex P3 fix:
                  // previously used `stroke` which inverts to cream in dark
                  // mode and would render heavier than the tan border.
                  !isLast && {
                    borderBottomColor: theme.colors.tan,
                    borderBottomWidth: StyleSheet.hairlineWidth,
                  },
                  pressed && { opacity: 0.85 },
                ]}
                testID={testID ? `${testID}-item-${item.id}` : `fab-popover-item-${item.id}`}
              >
                <Text style={[styles.label, { color: theme.colors.text }]}>{item.label}</Text>
              </Pressable>
            );
          })}
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  anchor: {
    // Anchor the menu above the bottom-right FAB. The FAB anchor in
    // PlantsListScreen is `right: 16, bottom: 24`; the FAB itself is 56px
    // tall. Menu sits 16px above the FAB top edge → bottom: 24 + 56 + 16 = 96.
    // Right-aligned to mirror the FAB's right edge.
    position: 'absolute',
    right: 16,
    bottom: 96,
  },
  menu: {
    minWidth: 200,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    paddingVertical: 4,
    // Cross-platform shadow. iOS reads shadow*; Android needs elevation.
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  item: {
    paddingVertical: 14,
    paddingHorizontal: 20,
  },
  label: {
    fontFamily: 'Inter_500Medium',
    fontSize: 16,
    // E11-003: 16 × 1.5 = 24 (was 20, ratio 1.25 — Inter popover labels
    // like "Add a note" need descender room at 310% Dynamic Type).
    lineHeight: 24,
  },
});

// Exported for test assertions on the static layout contract (V1 scope lock:
// no Reanimated, no transform-based scale anim).
export const fabPopoverStyles = styles;
