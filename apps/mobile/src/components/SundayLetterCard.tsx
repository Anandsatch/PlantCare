// SundayLetterCard — the editorial "Sunday letter" card that surfaces above the
// Plants list (A-1) on Sundays or after a 7+ day care drought. Pass 7 (Weekly
// Letter) per the master plan: a postcard, not a notification — gentle
// invitation into the weekly review (E9-004 / WeeklyReviewScreen) rather than
// a red-dot reminder.
//
// === The dual-gate pattern ===
// Visibility is decided by `shouldRender(nowMs, lastReviewedAtMs, dismissedAtMs)`,
// a pure helper exported from this file. Parent screens call it to decide
// whether to mount the card at all (so React doesn't pay for the subtree on
// the 6 days of the week the card isn't shown). The component ALSO calls
// `shouldRender` internally and returns `null` when the gate is closed — this
// is defense in depth: if a parent forgets to gate, or a future refactor races
// the props, the component still hides itself.
//
// Why a helper instead of internal state: the parent (PlantsListScreen) already
// owns `lastReviewedAtMs` and `dismissedAtMs` because it reads them from
// SQLite. Letting the parent ask `shouldRender(...)` keeps the SQLite read on
// the parent and keeps this component pure. The parent is also the right
// place to skip the heavy A-1 layout work when the card isn't going to render.
//
// === Time math: local-tz calendar walks, never UTC ms floor ===
// Two questions the helper answers:
//   1) Is today a Sunday in the device's local time zone?
//   2) Has it been 7+ local-calendar-days since `lastReviewedAtMs`?
//
// Both use `new Date(ms).getDay()` / `getDate()` — Date is local-tz by default
// in JS — and a setDate-based day-walk for (2). We do NOT compute "7 days" via
// `Math.floor((now - last) / 86_400_000)`; on DST-fall-back days that gives a
// 25-hour day a calendar-delta of 1 (correct number of midnights crossed) but
// on DST-spring-forward + sub-day-precision boundaries it can off-by-one. The
// floor-of-ms trick also fails the 6d 23h 59m vs 7d 0h 1m sub-day-precision
// regression that the WORKBACK.md test plan demands.
//
// DST 25-hour fall-back day: a Sunday whose wall-clock runs 25 hours still has
// `getDay() === 0` for the entire day, so (1) trivially holds. The dismiss
// window logic uses `setDate(getDate() + 7)` and `setHours(0,0,0,0)` to walk
// to the next Sunday, which preserves the calendar-day boundary even when the
// intervening week contains a 25h or 23h day.
//
// IDL travel: when the user's device crosses the international date line, the
// device's tz updates with the OS clock. `new Date(nowMs).getDay()` reads the
// local-tz day at the new location, so a Sunday in Honolulu after a Tokyo
// Sunday-night flight still registers as a Sunday — Date is anchored to the
// device, not the originating UTC instant.
//
// === Sunday-window dismiss semantics ===
// "Most recent Sunday window" = [mostRecentSundayMidnightLocal(nowMs),
//  mostRecentSundayMidnightLocal(nowMs) + 7 local-calendar-days). On a Sunday
// that window starts today; on Mon-Sat it starts at the past Sunday and ends
// at the upcoming Sunday's 00:00. A dismiss inside this window suppresses the
// card; on the next Sunday's 00:00 the window slides forward and the dismiss
// timestamp is now BEFORE the current window, so the card surfaces again.
//
// Saturday 23:59 vs Sunday 00:01 dismiss: a Sat 23:59 dismiss falls inside the
// PRIOR Sunday's window. Once the clock crosses to Sunday 00:00, the current
// window starts there, and Sat 23:59 is BEFORE it → card shows. A Sun 00:01
// dismiss is inside the current window → card hides for the rest of the
// Sunday window. This is the behavior the test plan requires.
//
// === Reduce-motion ===
// The card uses a single Animated.timing fade-in on mount. When
// `useReduceMotion()` returns true, the animation is hard-disabled (opacity
// stays at 1; no Animated work runs at all). Per the DESIGN.md a11y baseline
// and the same pattern as DiagnoseLoadingState (E5-007).
//
// === V1 scope locks (do not add) ===
// - No date-fns / dayjs / luxon / Temporal API. Native Date + getDay/setDate
//   only — calendar walks are the V1 contract.
// - No internal SQLite write for dismiss; `onDismiss` emits upward and the
//   parent persists. This component owns no storage.
// - No <WeeklyReviewScreen> here; `onOpen` navigates to E9-004.
// - No internal "this is the only place we compute Sunday-ness" assumption —
//   the helper is exported so other surfaces (a future Today-tab dot, a push
//   gate) can reuse the same calendar logic.

import * as React from 'react';
import { useEffect, useMemo, useRef } from 'react';
import { Animated, Pressable, StyleSheet, Text, View } from 'react-native';

import { useReduceMotion } from '../hooks/useReduceMotion';
import { useTheme } from '../hooks/useTheme';

const SUNDAY = 0; // Date#getDay() — 0=Sun, 6=Sat
const STALE_THRESHOLD_DAYS = 7;
const FADE_IN_MS = 260;

export const TITLE_TEXT = 'Sunday letter';
export const BODY_TEXT =
  'A quiet check-in with your garden. Three minutes, your week with your plants.';
export const OPEN_LABEL = 'Read this week';
export const DISMISS_LABEL = 'Dismiss';

export type SundayLetterCardProps = {
  /** Fired when the user taps "Read this week". Parent navigates to A-6. */
  onOpen: () => void;
  /** Fired when the user taps "Dismiss". Parent persists the timestamp. */
  onDismiss: () => void;
  /**
   * Optional anchor for "now" in unix ms. Default `Date.now()`. Test seam.
   * Local-tz semantics: `new Date(nowMs)` reads the device's current tz.
   */
  nowMs?: number;
  /**
   * Most recent weekly review timestamp the user actually opened, in unix ms.
   * `undefined` / `null` means the user has never opened a weekly review —
   * which alone is NOT enough to surface the card; today must also be Sunday.
   * (See `shouldRender` empty-state branch.)
   */
  lastReviewedAtMs?: number | null;
  /**
   * Most recent dismiss timestamp from this card, in unix ms. The parent
   * reads it from SQLite and passes it down. When this falls inside the
   * current Sunday window, the card stays hidden until the next Sunday rolls
   * over — see "Sunday-window dismiss semantics" in the file header.
   */
  dismissedAtMs?: number | null;
  accessibilityLabel?: string;
  testID?: string;
};

/**
 * Walk back to the most recent Sunday at local midnight. Returns the unix ms
 * of that Sunday 00:00:00 in the device's local tz. If `nowMs` itself falls on
 * a Sunday, returns that Sunday's 00:00. Day-walks, not ms-arithmetic, so DST
 * transitions land on the correct calendar day.
 */
function mostRecentSundayMidnightLocal(nowMs: number): number {
  const d = new Date(nowMs);
  const dayIdx = d.getDay(); // 0..6, 0=Sun
  // setDate(getDate() - dayIdx) walks calendar days; setHours(0,0,0,0) snaps
  // to local midnight. Calendar-walking handles DST without arithmetic.
  d.setDate(d.getDate() - dayIdx);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * Local-calendar-day delta between `thenMs` and `nowMs`. Positive when `then`
 * is in the past relative to `now`. Returns 0 for same local day or future.
 *
 * Implementation: anchor each timestamp to its local-midnight reading and walk
 * `then` forward one calendar day at a time until it reaches `now`'s local
 * midnight. This is the same approach PhotoTimeline uses for its bucketing —
 * see `localDayDelta` there. Walking (not dividing by 86_400_000) is what
 * makes the 6d 23h 59m / 7d 0h 1m regression assertions pass: dividing rounds
 * down across DST boundaries; walking counts midnights.
 */
function localCalendarDayDelta(thenMs: number, nowMs: number): number {
  const now = new Date(nowMs);
  const then = new Date(thenMs);
  const nowMidnight = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  ).getTime();
  const thenMidnight = new Date(
    then.getFullYear(),
    then.getMonth(),
    then.getDate(),
  ).getTime();
  if (thenMidnight >= nowMidnight) return 0;

  let days = 0;
  let cursor = new Date(then.getFullYear(), then.getMonth(), then.getDate());
  // Cap at 366 to bound iteration on absurd inputs (years-old timestamps).
  // Anything 7+ already trips the staleness branch; the exact value past that
  // doesn't matter to `shouldRender`.
  while (cursor.getTime() < nowMidnight && days < 366) {
    cursor = new Date(
      cursor.getFullYear(),
      cursor.getMonth(),
      cursor.getDate() + 1,
    );
    days += 1;
  }
  return days;
}

/**
 * Pure visibility helper. Returns true when the card should appear at the top
 * of A-1 (the Plants list). Used by the parent screen to gate mount AND by
 * the component itself to defensively render `null` if mounted anyway.
 *
 * Visibility rules (any one is sufficient EXCEPT the dismiss override):
 *   1. Today is Sunday in the device's local tz, OR
 *   2. `lastReviewedAtMs` is set AND ≥ 7 local-calendar-days ago.
 *
 * Override: if `dismissedAtMs` falls inside the current Sunday window
 * `[mostRecentSundayMidnightLocal(nowMs), +7 local days)`, the card stays
 * hidden — even if (1) or (2) would otherwise show it.
 */
export function shouldRender(
  nowMs: number,
  lastReviewedAtMs: number | null | undefined,
  dismissedAtMs: number | null | undefined,
): boolean {
  const now = new Date(nowMs);
  const isSundayToday = now.getDay() === SUNDAY;
  const hasReviewed =
    typeof lastReviewedAtMs === 'number' && Number.isFinite(lastReviewedAtMs);
  const isStale =
    hasReviewed &&
    localCalendarDayDelta(lastReviewedAtMs as number, nowMs) >=
      STALE_THRESHOLD_DAYS;

  // Empty state: never reviewed AND not Sunday → don't show. This matches the
  // master plan's "the card surfaces ONLY on Sundays or after a stale week"
  // contract; a brand-new user on a Wednesday sees the empty-garden welcome,
  // not a Sunday letter.
  if (!isSundayToday && !isStale) return false;

  // Dismiss override. The window starts at the most recent Sunday's local
  // midnight and runs 7 calendar days. A dismiss inside that window suppresses
  // the card until the window slides forward (next Sunday at 00:00).
  if (typeof dismissedAtMs === 'number' && Number.isFinite(dismissedAtMs)) {
    const sundayStart = mostRecentSundayMidnightLocal(nowMs);
    // End of window = sundayStart + 7 local-calendar-days, computed by
    // setDate-walking (not + 7 * 86_400_000 — that would skew on DST weeks).
    const sundayEndDate = new Date(sundayStart);
    sundayEndDate.setDate(sundayEndDate.getDate() + 7);
    sundayEndDate.setHours(0, 0, 0, 0);
    const sundayEnd = sundayEndDate.getTime();
    if (dismissedAtMs >= sundayStart && dismissedAtMs < sundayEnd) {
      return false;
    }
  }

  return true;
}

export function SundayLetterCard({
  onOpen,
  onDismiss,
  nowMs,
  lastReviewedAtMs,
  dismissedAtMs,
  accessibilityLabel = 'Sunday letter — read this week',
  testID,
}: SundayLetterCardProps): React.ReactElement | null {
  const theme = useTheme();
  const reduceMotion = useReduceMotion();

  // Pin "now" once per mount unless a fresh nowMs prop is passed. We don't
  // want a tick clock here: the card's visibility doesn't change minute to
  // minute, and re-evaluating shouldRender on every render is fine because
  // the helper is cheap. The effective-now memo is purely so the prop change
  // is the trigger, not Date.now() drift.
  const effectiveNow = useMemo(() => nowMs ?? Date.now(), [nowMs]);

  // Dual-gate defense: even though the parent should have used shouldRender to
  // decide whether to mount us at all, render `null` if the gate is closed.
  // This makes us safe to drop into a layout that doesn't yet wire the gate.
  if (!shouldRender(effectiveNow, lastReviewedAtMs, dismissedAtMs)) {
    return null;
  }

  return (
    <SundayLetterCardInner
      theme={theme}
      reduceMotion={reduceMotion}
      onOpen={onOpen}
      onDismiss={onDismiss}
      accessibilityLabel={accessibilityLabel}
      testID={testID}
    />
  );
}

type InnerProps = {
  theme: ReturnType<typeof useTheme>;
  reduceMotion: boolean;
  onOpen: () => void;
  onDismiss: () => void;
  accessibilityLabel: string;
  testID?: string;
};

// The inner component owns the fade-in Animated.Value. Splitting it out
// guarantees the Animated.Value is allocated only when the card is actually
// visible — the outer component's early-return-null path never reaches the
// useRef/useEffect, which is the cheapest fast-path on the 6 days the card
// doesn't render.
function SundayLetterCardInner({
  theme,
  reduceMotion,
  onOpen,
  onDismiss,
  accessibilityLabel,
  testID,
}: InnerProps): React.ReactElement {
  // Reduce-motion contract — initial-render-safe.
  //
  // `useReduceMotion()` resolves async on mount: it returns `false` for the
  // brief window before `AccessibilityInfo.isReduceMotionEnabled()` resolves
  // (codex caught this in adversarial review). If we initialized
  // `opacity = new Animated.Value(0)` and started the fade based on that
  // first-render `false`, a Reduce Motion user could see a partial fade in
  // before the hook flips to `true` and the effect re-runs to cancel it.
  //
  // Fix: initial opacity is ALWAYS 1 (the static end state). The fade-in only
  // runs after we've confirmed reduceMotion === false on a render, AND it
  // hasn't run yet on this mount. We track "have we played?" via a ref so the
  // effect re-running on later reduceMotion changes doesn't replay the fade.
  // This biases toward "no fade" when the preference is unknown — the safe
  // default for accessibility.
  const opacity = useRef(new Animated.Value(1)).current;
  const hasPlayedRef = useRef(false);
  useEffect(() => {
    if (reduceMotion) {
      // Reduce-motion is on — make sure we're at the static end state and
      // mark "played" so a later flip to false doesn't kick off the anim.
      opacity.setValue(1);
      hasPlayedRef.current = true;
      return;
    }
    if (hasPlayedRef.current) return;
    hasPlayedRef.current = true;
    opacity.setValue(0);
    const anim = Animated.timing(opacity, {
      toValue: 1,
      duration: FADE_IN_MS,
      useNativeDriver: true,
    });
    anim.start();
    return () => {
      anim.stop();
    };
  }, [reduceMotion, opacity]);

  const styles = StyleSheet.create({
    card: {
      backgroundColor: theme.colors.surface,
      borderRadius: 16,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.stroke,
      paddingVertical: 20,
      paddingHorizontal: 20,
      marginHorizontal: 16,
    },
    title: {
      fontFamily: 'Fraunces_600SemiBold',
      fontSize: 22,
      lineHeight: 28,
      color: theme.colors.text,
      marginBottom: 8,
    },
    body: {
      fontFamily: 'Inter_400Regular',
      fontSize: 15,
      lineHeight: 22,
      color: theme.colors.textMuted,
      marginBottom: 16,
    },
    ctaRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'flex-start',
      gap: 16,
    },
    openCta: {
      paddingVertical: 10,
      paddingHorizontal: 18,
      borderRadius: 12,
      backgroundColor: theme.colors.primary,
      minHeight: 44,
      justifyContent: 'center',
    },
    openCtaLabel: {
      fontFamily: 'Fraunces_600SemiBold',
      fontSize: 15,
      lineHeight: 20,
      // Conservatory: filled forest CTA → cream label. Midnight: filled sage
      // CTA → forest label. theme.colors.surface satisfies both via the
      // approved DESIGN.md table (Light surface = cream; Dark surface = forest).
      color: theme.colors.surface,
    },
    dismissCta: {
      paddingVertical: 10,
      paddingHorizontal: 8,
      minHeight: 44,
      justifyContent: 'center',
    },
    dismissCtaLabel: {
      fontFamily: 'Inter_500Medium',
      fontSize: 14,
      lineHeight: 20,
      color: theme.colors.textMuted,
    },
  });

  return (
    <Animated.View
      // role="region" + accessible groups the card under one VoiceOver swipe
      // stop rather than reading the title, body, and CTAs as four separate
      // landmarks. The CTAs remain individually focusable because they're
      // Pressables nested inside.
      accessible
      accessibilityRole="summary"
      accessibilityLabel={accessibilityLabel}
      testID={testID}
      style={[styles.card, { opacity }]}
    >
      <Text
        accessibilityRole="header"
        style={styles.title}
        testID={testID ? `${testID}-title` : undefined}
      >
        {TITLE_TEXT}
      </Text>
      <Text
        style={styles.body}
        testID={testID ? `${testID}-body` : undefined}
      >
        {BODY_TEXT}
      </Text>
      <View style={styles.ctaRow}>
        <Pressable
          onPress={onOpen}
          accessibilityRole="button"
          accessibilityLabel={OPEN_LABEL}
          testID={testID ? `${testID}-open` : undefined}
          hitSlop={8}
          style={({ pressed }) => [
            styles.openCta,
            { opacity: pressed ? 0.85 : 1 },
          ]}
        >
          <Text style={styles.openCtaLabel}>{OPEN_LABEL}</Text>
        </Pressable>
        <Pressable
          onPress={onDismiss}
          accessibilityRole="button"
          accessibilityLabel={DISMISS_LABEL}
          testID={testID ? `${testID}-dismiss` : undefined}
          hitSlop={8}
          style={({ pressed }) => [
            styles.dismissCta,
            { opacity: pressed ? 0.6 : 1 },
          ]}
        >
          <Text style={styles.dismissCtaLabel}>{DISMISS_LABEL}</Text>
        </Pressable>
      </View>
    </Animated.View>
  );
}
