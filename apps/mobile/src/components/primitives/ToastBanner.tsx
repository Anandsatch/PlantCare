import { useEffect, useRef } from 'react';
import {
  AccessibilityInfo,
  type AccessibilityRole,
  Animated,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { useReduceMotion } from '../../hooks/useReduceMotion';
import { useTheme } from '../../hooks/useTheme';

/**
 * ToastBanner — Conservatory tan/sage banner primitive.
 *
 * Renders the banner shape only. Positioning (top of screen, stacking, queue
 * management) is the parent's responsibility — this is a primitive per V1
 * scope locks (no provider, no portal, no swipe-to-dismiss).
 *
 * Per the master plan:
 *   - 'warn'    → tan, auto-dismiss (transient errors, budget meter at 40+)
 *   - 'info'    → sage, auto-dismiss (Day 1 nudges, low-priority hints)
 *   - 'pending' → tan, persistent (offline sync queue: "{N} items syncing"),
 *                 italic body, leading clock glyph, and a slow opacity pulse
 *                 on the glyph that hard-disables under reduce-motion. The
 *                 tan is deliberate — pending is "warm, queued, will resolve",
 *                 not "something went wrong" — reusing 'warn' would imply an
 *                 error when the actual semantics are "you're offline, we
 *                 saved it, we'll run it when you're back online."
 *
 * accessibilityRole='alert' on warn (announces immediately to VoiceOver).
 * accessibilityRole='status' on info/pending (non-disruptive). On Android,
 * accessibilityLiveRegion='polite' nudges TalkBack to read it without
 * interrupting the user mid-utterance — matches the master plan's "info and
 * pending are non-disruptive" stance.
 *
 * Reduce-motion (E9-003 lesson): the pulse Animated.Value is initialized at
 * end-state (1.0 opacity) UNCONDITIONALLY. `useReduceMotion()` returns false
 * synchronously and only flips to the OS-reported value after the
 * AccessibilityInfo probe resolves on the next tick — so a "init at min if
 * !reduceMotion, init at 1 if reduceMotion" pattern still paints a min-opacity
 * first frame for reduce-motion users in that brief async window. Init at 1.0
 * always; let the loop sequence run end-state → min → end-state so the first
 * painted opacity is 1.0 regardless of the hook's synchronous return; the
 * reduce-motion guard then skips the loop entirely on the next render.
 */

export type ToastBannerType = 'warn' | 'info' | 'pending';

export type ToastBannerAction = {
  readonly label: string;
  readonly onPress: () => void;
  /**
   * When true, the CTA is rendered with `accessibilityState={{ disabled: true }}`,
   * the `disabled` prop on the `Pressable`, and a non-pressable visual hint.
   * Used by E7-006's QueueRetryBanner to surface a "Retrying…" busy state
   * that screen readers announce as a disabled button. Default false.
   */
  readonly disabled?: boolean;
};

export type ToastBannerProps = {
  readonly type: ToastBannerType;
  readonly message: string;
  readonly action?: ToastBannerAction;
  /**
   * Auto-dismiss timeout in ms. Defaults to 4000 for 'warn' and 'info'.
   * Defaults to undefined (persistent) for 'pending'.
   * Pass `0` to disable auto-dismiss explicitly for any type.
   */
  readonly autoDismissMs?: number;
  readonly onDismiss?: () => void;
  /**
   * If controlled (parent owns visibility), the banner only renders when
   * `visible` is true. Defaults to true.
   */
  readonly visible?: boolean;
  /**
   * Pending-only: when provided, renders a small "Retry" CTA inside the
   * banner. Tapping fires `onRetry`. Used by E7-006 (tap-to-retry on
   * failed/expired sync_queue rows). Has no effect on 'warn' or 'info'
   * variants — those use the existing `action` prop for their CTAs.
   */
  readonly onRetry?: () => void;
  readonly testID?: string;
};

const DEFAULT_AUTO_DISMISS_MS = 4000;

function resolveAutoDismissMs(
  type: ToastBannerType,
  override: number | undefined,
): number | undefined {
  if (override !== undefined) {
    return override;
  }
  if (type === 'pending') {
    return undefined;
  }
  return DEFAULT_AUTO_DISMISS_MS;
}

function bannerColor(type: ToastBannerType, tan: string, sage: string): string {
  // Per master plan: 'warn' and 'pending' use tan; 'info' uses sage.
  return type === 'info' ? sage : tan;
}

// Pending-pulse opacity range. End-state (1.0) is what reduce-motion users
// see; the loop dips to PULSE_MIN_OPACITY and returns. Range is intentionally
// shallow — the pulse should read as a heartbeat, not a flash.
const PULSE_MIN_OPACITY = 0.55;
const PULSE_END_OPACITY = 1;
// Slow cycle: 1100ms in + 1100ms out → 2.2s round-trip. Calmer than the
// diagnose loading dots (1.0s round-trip) because pending state is ambient,
// not a foreground task waiting on a result.
const PULSE_DURATION_MS = 1100;

// Pending-only glyph. U+25F7 (◷) — "white circle with upper-right quadrant"
// — reads as a clock/timer at small sizes, has no emoji-presentation
// variation across iOS/Android (unlike ⏱️ which renders as a colored emoji
// on iOS), and ships in every base font we'd plausibly land on. Adding an
// icon library for one glyph is a V1 scope-lock violation.
const PENDING_GLYPH = '◷';

// Text on tan/sage banners is locked to the deep ink (#2A2A2A) regardless of
// theme. Reasoning (E10-001 dark-mode verification):
//   - tan (#C9A873) and sage (#B8C5A6) are constants across Conservatory and
//     Midnight (DESIGN.md "Status icon system" — the three accent hues do not
//     invert; the cream-paper banner aesthetic stays warm in dark mode).
//   - In dark mode, theme.colors.text = cream (#FAF6EE). cream on tan = 2.09:1
//     and cream on sage = 1.68:1 — both below the 4.5:1 floor.
//   - Locking to the deep ink keeps WCAG-AA legibility (tan: 6.38:1, sage:
//     7.91:1) without inventing a new "onAccent" token (V1 token table is
//     locked, see DESIGN.md and the master plan).
const ON_ACCENT_INK = '#2A2A2A';

export function ToastBanner(props: ToastBannerProps) {
  const {
    type,
    message,
    action,
    autoDismissMs,
    onDismiss,
    visible = true,
    onRetry,
    testID,
  } = props;

  const theme = useTheme();
  const reduceMotion = useReduceMotion();
  const dismissMs = resolveAutoDismissMs(type, autoDismissMs);

  // Init at end-state (1.0) UNCONDITIONALLY. `useReduceMotion()` returns
  // `false` synchronously and only flips to the OS-reported value after
  // `AccessibilityInfo.isReduceMotionEnabled()` resolves on the next tick
  // (see useReduceMotion.ts). If we initialized at PULSE_MIN_OPACITY when
  // reduceMotion was synchronously false, a reduce-motion user would see
  // a 0.55-opacity first frame before the hook's async resolve flipped us
  // to 1.0 — exactly the Wave 1 race the lesson warns about. The pulse
  // useEffect below starts the loop only when reduceMotion === false, and
  // the loop's first timing step is "1.0 → 0.55," which means even if the
  // effect runs one frame before reduce-motion flips on, the user has not
  // seen anything below 1.0.
  const pulseOpacity = useRef(new Animated.Value(PULSE_END_OPACITY)).current;

  useEffect(() => {
    if (!visible) {
      return;
    }
    if (dismissMs === undefined || dismissMs <= 0) {
      return;
    }
    const handle = setTimeout(() => {
      // onDismiss fires on TIMER EXPIRY, not on cleanup/unmount. Cleanup
      // returned below clears the timer so an unmounted parent never
      // receives a phantom dismiss.
      onDismiss?.();
    }, dismissMs);
    return () => {
      clearTimeout(handle);
    };
    // Re-arm whenever type, message, dismissMs, or visibility changes. A new
    // message replaces the old banner conceptually; the timer should restart
    // so the user gets the full read time on the new content.
  }, [type, message, dismissMs, visible, onDismiss]);

  // Pending-only opacity pulse on the leading glyph. Reduce-motion path
  // does not start the loop at all — the Animated.Value sits at its
  // end-state (1.0) so the glyph stays solid. Same pattern as
  // DiagnoseLoadingState (E9-003) per the Wave 1 reduce-motion lesson.
  // The loop sequence runs end-state → min → end-state so even if the
  // effect mounts one frame before useReduceMotion() resolves to true,
  // the user does not see anything below opacity 1.0.
  useEffect(() => {
    if (type !== 'pending' || !visible) {
      return;
    }
    if (reduceMotion) {
      // Defensive: pin to end-state in case a prior render mounted with
      // reduceMotion=false and a pulse cycle drove the value below 1.0.
      pulseOpacity.setValue(PULSE_END_OPACITY);
      return;
    }
    // Async-window guard (E11-004 sweep). `useReduceMotion()` returns false
    // synchronously during the boot window before
    // AccessibilityInfo.isReduceMotionEnabled() resolves. The previous design
    // started the loop immediately and relied on "first painted opacity is
    // 1.0" — but that still fires Animated.loop / Animated.timing inside
    // the boot window for a reduce-motion user, which is a structural
    // compliance bug (per the v0.1.55.0 E9-005 P3 lesson). Mirrors the
    // FABPopover P1 fix: probe the OS synchronously; only start the loop
    // when the OS confirms motion is allowed. The Animated.Value already
    // sits at PULSE_END_OPACITY so the visible opacity stays at 1.0 across
    // the probe resolution either way.
    pulseOpacity.setValue(PULSE_END_OPACITY);
    let cancelled = false;
    let loop: Animated.CompositeAnimation | null = null;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((osSaysReduce) => {
        if (cancelled) return;
        if (osSaysReduce) {
          // OS confirms reduce-motion. No loop.
          pulseOpacity.setValue(PULSE_END_OPACITY);
          return;
        }
        // OS confirms motion allowed. Start the loop now. The first timing
        // step dips down to PULSE_MIN_OPACITY, the second returns to
        // PULSE_END_OPACITY.
        loop = Animated.loop(
          Animated.sequence([
            Animated.timing(pulseOpacity, {
              toValue: PULSE_MIN_OPACITY,
              duration: PULSE_DURATION_MS,
              useNativeDriver: true,
            }),
            Animated.timing(pulseOpacity, {
              toValue: PULSE_END_OPACITY,
              duration: PULSE_DURATION_MS,
              useNativeDriver: true,
            }),
          ]),
        );
        loop.start();
      })
      .catch(() => {
        // Probe failed — biased toward no-motion. Pulse stays static.
      });
    return () => {
      cancelled = true;
      if (loop) loop.stop();
    };
  }, [type, visible, reduceMotion, pulseOpacity]);

  if (!visible) {
    return null;
  }

  // RN's `AccessibilityRole` type omits 'status' (it's a web-platform role
   // that the native accessibility bridges don't surface). The master plan
   // specifies 'status' for info/pending so we set it as a literal — it
   // round-trips through the View's accessibility props for tests + any
   // consumer reading the prop, and on native it falls through harmlessly
   // because TalkBack/VoiceOver ignore unknown roles. The semantically
   // correct native announcement signal is `accessibilityLiveRegion` below.
  const accessibilityRole = (type === 'warn' ? 'alert' : 'status') as AccessibilityRole;

  // Android-only. iOS doesn't have a parallel View prop; per-event
  // announcements there require `AccessibilityInfo.announceForAccessibility`,
  // which is a parent concern (this primitive doesn't own when to announce).
  // 'assertive' on warn → interrupts the user (matches the 'alert' role).
  // 'polite'    on info/pending → waits for a natural pause.
  const accessibilityLiveRegion = Platform.OS === 'android'
    ? (type === 'warn' ? 'assertive' : 'polite')
    : undefined;

  const isPending = type === 'pending';

  return (
    <View
      accessibilityRole={accessibilityRole}
      accessibilityLiveRegion={accessibilityLiveRegion}
      testID={testID}
      style={[
        styles.container,
        { backgroundColor: bannerColor(type, theme.colors.tan, theme.colors.sage) },
      ]}
    >
      {isPending ? (
        <Animated.Text
          // The glyph is decorative — the message text carries the meaning,
          // and the live region announces the message. Hiding the glyph
          // from screen readers prevents "white circle with upper right
          // quadrant" being read aloud.
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          // E11-003: chrome glyph (decorative) opts out of Dynamic Type so
          // it stays sized to the row's pulse animation footprint. The
          // banner's flowing message text still scales normally.
          allowFontScaling={false}
          testID={testID ? `${testID}-pending-glyph` : undefined}
          style={[styles.pendingGlyph, { color: ON_ACCENT_INK, opacity: pulseOpacity }]}
        >
          {PENDING_GLYPH}
        </Animated.Text>
      ) : null}
      <Text
        style={[
          styles.message,
          isPending ? styles.messageItalic : null,
          { color: ON_ACCENT_INK },
        ]}
        numberOfLines={3}
      >

        {message}
      </Text>
      {action ? (
        <Pressable
          onPress={action.disabled ? undefined : action.onPress}
          disabled={action.disabled}
          accessibilityRole="button"
          accessibilityLabel={action.label}
          accessibilityState={action.disabled ? { disabled: true } : undefined}
          // E11-002 (touch target audit): visual height is fontSize 12 +
          // lineHeight ~16 + paddingV 4×2 = ~24, below the 44pt iOS HIG /
          // Material a11y floor. Bumping hitSlop from 8 to 12 raises the
          // effective hit area to ~48pt vertically, comfortably above the
          // threshold. The banner row is its own row (no adjacent siblings
          // within 24pt), so the larger slop cannot overlap another control.
          hitSlop={12}
          style={styles.action}
        >
          <Text style={[styles.actionLabel, { color: ON_ACCENT_INK }]}>
            {action.label}
          </Text>
        </Pressable>
      ) : null}
      {isPending && onRetry ? (
        <Pressable
          onPress={onRetry}
          accessibilityRole="button"
          accessibilityLabel="Retry"
          // E11-002: same 24-vertical / sub-44pt math as the `action` CTA
          // above — both share `styles.action`. Bumping to 12 keeps the
          // RETRY chip's effective hit area at ~48pt without resizing the
          // visible glyph (DESIGN.md locks the compact ALL-CAPS label).
          hitSlop={12}
          testID={testID ? `${testID}-retry` : undefined}
          style={styles.action}
        >
          <Text style={[styles.actionLabel, { color: ON_ACCENT_INK }]}>
            RETRY
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    padding: 16,
    borderRadius: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  message: {
    flex: 1,
    fontSize: 14,
    lineHeight: 20,
  },
  // Pending body uses italic to read as ambient/in-flight rather than a
  // hard error. fontStyle:'italic' synthesizes from the loaded Inter
  // regular face (we don't ship a separate Inter italic) — Hermes/RN
  // handle synthetic italic across iOS and Android.
  messageItalic: {
    fontStyle: 'italic',
  },
  pendingGlyph: {
    fontSize: 16,
    lineHeight: 20,
    marginRight: 10,
  },
  action: {
    marginLeft: 12,
    paddingVertical: 4,
    paddingHorizontal: 4,
  },
  actionLabel: {
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
});
