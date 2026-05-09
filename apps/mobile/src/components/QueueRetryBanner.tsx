/**
 * QueueRetryBanner — surfaces failed sync_queue rows with a Retry CTA.
 *
 * E7-006 ships the hook (`useFailedQueue`) + this banner together. This
 * file does NOT mount the banner anywhere — that's a future ticket
 * (likely part of E7-004 wiring or a follow-up that wires the banner at
 * the top of `<PlantsListScreen>`). Today the banner is a presentation
 * primitive ready to be composed.
 *
 * Renders only when `failedRows.length > 0`. Otherwise returns null so
 * the parent never has to wrap in conditional logic.
 *
 * Visual: composes `<ToastBanner type='pending'>` from the primitives
 * barrel. The 'pending' variant uses the tan accent + status role +
 * polite live region — the master plan's exact spec for offline sync
 * surfaces (line 633: "Failed/expired rows surface as a one-line tan
 * banner offering 'Tap to retry'").
 *
 * Copy: "{N} saved offline. Tap to retry." with a Retry CTA. The count
 * is in the message (so VoiceOver reads it) AND in the CTA's
 * accessibilityLabel ("Retry {N} saved request(s)") so a screen-reader
 * user can act on the count without reading the message twice.
 *
 * Accessibility:
 *   - role='status' is set on the inner ToastBanner (it routes 'pending'
 *     through the same status role as 'info'). This is the non-disruptive
 *     announce; a banner appearing because of accumulated failures
 *     should NOT interrupt the user mid-flow.
 *   - The Retry CTA's accessibilityLabel includes the count, so a
 *     screen-reader user activating the button hears how many requests
 *     they're retrying.
 *
 * Reduce-motion: the banner has NO entry animation in V1. We considered
 * a fade/slide on appearance; rejected because (a) reduce-motion would
 * have to disable it anyway and (b) the master plan's animation budget
 * is already tight. If a future ticket adds an entry animation, follow
 * the canonical pattern: useReduceMotion() → if true, init at end-state
 * (no animation runs). This file doesn't ship that animation today, so
 * the reduce-motion test pins the contract by asserting NO Animated.View
 * is rendered (confirms the static layout).
 *
 * Strict-mode double-mount: the banner is a pure render of its props.
 * The hook (`useFailedQueue`) handles its own strict-mode safety; the
 * banner component has no effects beyond what ToastBanner does
 * internally (and ToastBanner's auto-dismiss is disabled for 'pending').
 *
 * Theme: derives tan from `useTheme()` via ToastBanner. Dark mode swaps
 * to the Midnight Conservatory token automatically.
 *
 * V1 scope locks:
 *   - DO NOT mount in any screen here. Future ticket.
 *   - DO NOT add per-row dismiss / per-row retry list UI in V1. The
 *     master plan locks the surface to a single banner with a count
 *     and a single Retry CTA.
 *   - DO NOT swipe-to-dismiss. ToastBanner doesn't ship swipe in V1.
 *   - DO NOT animate entry. See above.
 */

import { Platform, StyleSheet, View } from 'react-native';

import { ToastBanner } from './primitives/ToastBanner';

export type QueueRetryBannerProps = {
  /**
   * Snapshot of failed rows from `useFailedQueue().failedRows`. The
   * banner only cares about the count for the message + label; the
   * full row shape is forwarded so future tickets can add per-row
   * detail without changing the prop surface.
   */
  readonly failedCount: number;
  /**
   * Called when the user taps Retry. Wire to
   * `useFailedQueue().retryAll`. The hook handles the reset
   * transaction + drainer.drainNow() + post-retry refresh.
   */
  readonly onRetry: () => void;
  /**
   * True while the hook is running a retry. Disables the CTA so a
   * second tap doesn't fire a parallel retry. The hook itself
   * single-flights, but disabling visually is the right UX cue.
   */
  readonly retrying?: boolean;
  readonly testID?: string;
};

function buildMessage(count: number): string {
  if (count === 1) {
    return '1 saved offline. Tap to retry.';
  }
  return `${count} saved offline. Tap to retry.`;
}

function buildRetryLabel(count: number): string {
  if (count === 1) {
    return 'Retry 1 saved request';
  }
  return `Retry ${count} saved requests`;
}

export function QueueRetryBanner(props: QueueRetryBannerProps) {
  const { failedCount, onRetry, retrying = false, testID } = props;

  // Renders nothing when no failed rows. The parent (future ticket) can
  // mount the hook unconditionally and rely on this null-render contract;
  // there's no need for the parent to wrap in `failedRows.length > 0 ?`.
  if (failedCount <= 0) {
    return null;
  }

  // Wrap the ToastBanner in a thin View so we can attach a testID at the
  // outer boundary (ToastBanner forwards its own testID to the inner
  // banner, but having a testID at the wrapper makes "is the banner
  // mounted at all?" assertions cleaner — strict-mode double-mount tests
  // can grep for one container without depending on banner internals).
  // Disabled-state guard: when retrying, the CTA is fully disabled —
  // ToastBanner's action.disabled flag routes through Pressable's
  // `disabled` prop AND `accessibilityState={{disabled:true}}` so
  // screen readers announce the busy state correctly. Closes codex P3.
  const ctaDisabled = retrying;

  // CTA label is count-aware so screen readers announce how many
  // requests they're retrying ("Retry 3 saved requests"). ToastBanner
  // uses `action.label` as both the visual label AND the
  // accessibilityLabel (single-string source today), so the count
  // shows up in both. Visually verbose but accessibility-correct;
  // a future ToastBanner upgrade can split visual vs a11y label, at
  // which point the visual can shrink back to "Retry".
  const ctaLabel = retrying ? 'Retrying' : buildRetryLabel(failedCount);

  return (
    <View
      testID={testID ?? 'queue-retry-banner'}
      style={styles.container}
      // accessibilityElementsHidden=false on iOS preserves the inner
      // banner's role/live-region; the wrapper is a layout-only View.
      // On Android, ToastBanner's accessibilityLiveRegion='polite'
      // (set by the 'pending' branch) routes to TalkBack correctly.
      accessibilityElementsHidden={Platform.OS === 'ios' ? false : undefined}
    >
      <ToastBanner
        type="pending"
        message={buildMessage(failedCount)}
        action={{
          label: ctaLabel,
          onPress: onRetry,
          disabled: ctaDisabled,
        }}
        testID="queue-retry-banner-toast"
      />
    </View>
  );
}


// Static export of the copy strings so tests can assert without
// duplicating the format. Keeps the contract greppable.
export const QUEUE_RETRY_BANNER_COPY = {
  buildMessage,
  buildRetryLabel,
};

const styles = StyleSheet.create({
  container: {
    // Layout-only wrapper. No padding/margin in this primitive — the
    // mounting parent decides positioning (top-of-screen vs inline).
  },
});
