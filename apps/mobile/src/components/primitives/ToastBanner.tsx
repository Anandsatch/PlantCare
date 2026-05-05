import { useEffect } from 'react';
import {
  type AccessibilityRole,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { useTheme } from '../../hooks/useTheme';

/**
 * ToastBanner — Conservatory tan/sage banner primitive.
 *
 * Renders the banner shape only. Positioning (top of screen, stacking, queue
 * management) is the parent's responsibility — this is a primitive per V1
 * scope locks (no provider, no portal, no animations, no swipe-to-dismiss).
 *
 * Per the master plan:
 *   - 'warn'    → tan, auto-dismiss (transient errors, budget meter at 40+)
 *   - 'info'    → sage, auto-dismiss (Day 1 nudges, low-priority hints)
 *   - 'pending' → tan, persistent (offline sync queue: "{N} items syncing")
 *
 * accessibilityRole='alert' on warn (announces immediately to VoiceOver).
 * accessibilityRole='status' on info/pending (non-disruptive). On Android,
 * accessibilityLiveRegion='polite' nudges TalkBack to read it without
 * interrupting the user mid-utterance — matches the master plan's "info and
 * pending are non-disruptive" stance.
 */

export type ToastBannerType = 'warn' | 'info' | 'pending';

export type ToastBannerAction = {
  readonly label: string;
  readonly onPress: () => void;
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

export function ToastBanner(props: ToastBannerProps) {
  const {
    type,
    message,
    action,
    autoDismissMs,
    onDismiss,
    visible = true,
    testID,
  } = props;

  const theme = useTheme();
  const dismissMs = resolveAutoDismissMs(type, autoDismissMs);

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
      <Text style={[styles.message, { color: theme.colors.text }]} numberOfLines={3}>
        {message}
      </Text>
      {action ? (
        <Pressable
          onPress={action.onPress}
          accessibilityRole="button"
          accessibilityLabel={action.label}
          hitSlop={8}
          style={styles.action}
        >
          <Text style={[styles.actionLabel, { color: theme.colors.text }]}>
            {action.label}
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
