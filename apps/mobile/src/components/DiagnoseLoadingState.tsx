import { fonts } from '@plantcare/theme';
import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, StyleSheet, Text, View } from 'react-native';

import { useReduceMotion } from '../hooks/useReduceMotion';
import { useTheme } from '../hooks/useTheme';

// 3-bucket editorial copy. Source: DESIGN.md "Diagnose loading copy" + master
// plan section "Camera result / Diagnose (A-3)". The 20s+ line is also the
// signal that the LLM router escalated from the free tier to Claude 3.5 Sonnet
// — the elapsed clock implicitly reports router behavior to the user.
const COPY = ['Looking closely…', 'Almost there…', 'Trying a more careful look…'] as const;

// Boundary semantics, locked: elapsed < 8000 → bucket 0; elapsed < 20000 →
// bucket 1; otherwise bucket 2. So elapsed === 8000 lands in bucket 1 and
// elapsed === 20000 lands in bucket 2 (each boundary is the start of the next
// bucket). Tested explicitly in __tests__/DiagnoseLoadingState.test.tsx.
const BUCKET_1_AT_MS = 8000;
const BUCKET_2_AT_MS = 20000;

// Internal clock cadence. 250ms is the minimum tick rate that lets the bucket
// transitions land within ~one frame of the canonical boundary, without
// burning render budget when nothing visual is changing. The interval also
// auto-stops once bucket 2 is reached (final state — no further transitions
// to drive).
const TICK_INTERVAL_MS = 250;

// Pulse animation timing. Each dot fades 0.3 → 1.0 over 600ms, with a 150ms
// stagger across the three dots so the row reads as a left-to-right wave
// rather than a synchronized blink. Reduce-motion path skips the Animated
// machinery entirely and renders dots at a flat 0.6 opacity.
const PULSE_DURATION_MS = 600;
const PULSE_STAGGER_MS = 150;
const PULSE_MIN_OPACITY = 0.3;
const PULSE_MAX_OPACITY = 1.0;
const STATIC_DOT_OPACITY = 0.6;

export type DiagnoseLoadingStateProps = {
  /**
   * Wall-clock time in ms when the diagnose request fired. Defaults to the
   * value of `Date.now()` captured at first mount via `useRef`. Pinning to a
   * ref (rather than `useState(() => Date.now())`) avoids the rare edge case
   * where React's strict-mode double-invocation of state initializers
   * advances the clock before the component is committed.
   */
  startedAtMs?: number;
  /**
   * Override for the current wall clock. Test seam: a fake clock can be
   * injected to drive deterministic bucket assertions. When omitted, the
   * component manages its own 250ms-tick clock via `setInterval`.
   */
  nowMs?: number;
  accessibilityLabel?: string;
  testID?: string;
};

export function DiagnoseLoadingState({
  startedAtMs,
  nowMs,
  accessibilityLabel = 'Diagnosing your plant photo',
  testID,
}: DiagnoseLoadingStateProps): React.ReactElement {
  const theme = useTheme();
  const reduceMotion = useReduceMotion();

  // Pin start time to first render. If the parent re-renders without passing
  // startedAtMs, we keep the original anchor — the bucket clock starts when
  // the component mounts, not on parent churn. If the caller passes
  // startedAtMs explicitly, we still respect it (so an external request store
  // can own the timer), but the ref is only used as the fallback default.
  const startedAtRef = useRef<number | null>(null);
  if (startedAtRef.current === null) {
    startedAtRef.current = startedAtMs ?? Date.now();
  }
  const effectiveStartedAt = startedAtMs ?? startedAtRef.current;

  // Internal bucket state. We store the *bucket index* — not the raw clock
  // tick — so React only re-renders when the visible copy actually changes.
  // An earlier draft kept a `clockTick` integer in state and recomputed the
  // bucket via `useMemo`, but `useMemo` only memoizes the bucket value;
  // setting state every 250ms still reconciled the entire subtree four
  // times per second. Storing the bucket directly + bailing on `setBucket(b)`
  // when `b` is already current gives React's bail-out path: same value,
  // no re-render. Caught by codex P2 review.
  const computeBucket = (now: number): 0 | 1 | 2 => {
    const e = now - effectiveStartedAt;
    if (e < BUCKET_1_AT_MS) return 0;
    if (e < BUCKET_2_AT_MS) return 1;
    return 2;
  };

  const [internalBucket, setInternalBucket] = useState<0 | 1 | 2>(() =>
    computeBucket(Date.now()),
  );

  // When the caller drives `nowMs` directly (test path or external request
  // store), the bucket comes straight from props — no internal state, no
  // interval. Otherwise we use the self-managed bucket above.
  const bucket: 0 | 1 | 2 = nowMs !== undefined ? computeBucket(nowMs) : internalBucket;

  // Self-managed clock. Skipped when `nowMs` is provided (test path) and
  // also stopped once bucket 2 is reached — there are no further transitions
  // to drive, so the interval is dead weight. The interval calls
  // `setInternalBucket(next)`; React's setState bail-out skips the re-render
  // when `next === current`, so the subtree only reconciles on actual bucket
  // flips (twice over the 0→1→2 lifecycle).
  useEffect(() => {
    if (nowMs !== undefined) return;
    if (internalBucket === 2) return;
    const id = setInterval(() => {
      setInternalBucket(computeBucket(Date.now()));
    }, TICK_INTERVAL_MS);
    return () => clearInterval(id);
    // `effectiveStartedAt` is stable across the component's lifetime once
    // the ref is initialized (see `startedAtRef` above) so it doesn't need
    // to be in the dep list — but adding it doesn't hurt and keeps the
    // exhaustive-deps lint quiet for any future startedAtMs prop changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nowMs, internalBucket, effectiveStartedAt]);

  return (
    <View
      accessibilityLabel={accessibilityLabel}
      // 'polite' announces bucket transitions on Android. iOS ignores this
      // prop on View — the accessibilityLabel still wins on first focus,
      // and the visible copy carries the rest of the meaning.
      accessibilityLiveRegion="polite"
      style={styles.root}
      testID={testID}
    >
      <Text
        style={[
          styles.copy,
          {
            color: theme.colors.text,
            fontFamily: fonts.display.italic,
          },
        ]}
        testID={testID ? `${testID}-copy` : undefined}
      >
        {COPY[bucket]}
      </Text>
      <PulseDots reduceMotion={reduceMotion} color={theme.colors.text} testID={testID} />
    </View>
  );
}

type PulseDotsProps = {
  reduceMotion: boolean;
  color: string;
  testID?: string;
};

function PulseDots({ reduceMotion, color, testID }: PulseDotsProps): React.ReactElement {
  // Three independent Animated.Value instances — staggered start times mean
  // each dot's loop runs out of phase. Pin to refs so they survive re-renders
  // without restarting the loop (Animated.Value identity matters: starting a
  // new loop on every render would queue infinite animations).
  //
  // Init at STATIC_DOT_OPACITY UNCONDITIONALLY (E11-004 async-window fix).
  // `useReduceMotion()` returns false synchronously during the boot window
  // before AccessibilityInfo.isReduceMotionEnabled() resolves. Initializing
  // at PULSE_MIN_OPACITY when the hook said false-by-default meant a reduce-
  // motion user briefly saw dim dots before the loop started — AND the loop
  // itself fired before the OS preference resolved. Init-at-end-state +
  // async OS-probe inside the effect (mirrors FABPopover P1 pattern)
  // guarantees zero Animated.* call AND zero visible drift in the boot
  // window for reduce-motion users. Non-reduce-motion users see the
  // pulse start ~one microtask later — negligible.
  const dot0 = useRef(new Animated.Value(STATIC_DOT_OPACITY)).current;
  const dot1 = useRef(new Animated.Value(STATIC_DOT_OPACITY)).current;
  const dot2 = useRef(new Animated.Value(STATIC_DOT_OPACITY)).current;

  useEffect(() => {
    // Reduce-motion path: do not start an Animated.loop at all. The dots
    // were initialized at STATIC_DOT_OPACITY above, so there is nothing to
    // do. The Animated.timing/loop calls are the bug class for vestibular
    // disorders — skipping them entirely (rather than just clamping the
    // output range) is the only audit-defensible compliance.
    if (reduceMotion) {
      // Snap any in-flight value back to static (covers the live-toggle case
      // where the user enables reduce-motion mid-render).
      dot0.setValue(STATIC_DOT_OPACITY);
      dot1.setValue(STATIC_DOT_OPACITY);
      dot2.setValue(STATIC_DOT_OPACITY);
      return;
    }

    // Async-window guard (E11-004). Hook says motion allowed, but the OS
    // probe might disagree during the boot window. We do NOT start the
    // loop until the probe confirms motion is allowed. The dots stay at
    // STATIC_DOT_OPACITY in the meantime — a visually neutral state for
    // reduce-motion users while the probe resolves.
    let cancelled = false;
    let animations: Animated.CompositeAnimation[] | null = null;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((osSaysReduce) => {
        if (cancelled) return;
        if (osSaysReduce) {
          // OS confirms reduce-motion. Keep dots at static; no loop.
          return;
        }
        // OS confirms motion allowed. Drop the dots to PULSE_MIN_OPACITY
        // (the loop's natural starting point) then start the staggered
        // loop. Setting the start value inside the resolved branch means
        // a reduce-motion user never sees the min-opacity dim frame.
        dot0.setValue(PULSE_MIN_OPACITY);
        dot1.setValue(PULSE_MIN_OPACITY);
        dot2.setValue(PULSE_MIN_OPACITY);

        const makePulse = (value: Animated.Value, delay: number) =>
          Animated.loop(
            Animated.sequence([
              Animated.delay(delay),
              Animated.timing(value, {
                toValue: PULSE_MAX_OPACITY,
                duration: PULSE_DURATION_MS,
                useNativeDriver: true,
              }),
              Animated.timing(value, {
                toValue: PULSE_MIN_OPACITY,
                duration: PULSE_DURATION_MS,
                useNativeDriver: true,
              }),
            ]),
          );

        animations = [
          makePulse(dot0, 0),
          makePulse(dot1, PULSE_STAGGER_MS),
          makePulse(dot2, PULSE_STAGGER_MS * 2),
        ];
        animations.forEach((a) => a.start());
      })
      .catch(() => {
        // Probe failed — biased toward no-motion. Dots stay static.
      });

    return () => {
      cancelled = true;
      if (animations) animations.forEach((a) => a.stop());
    };
  }, [reduceMotion, dot0, dot1, dot2]);

  return (
    <View style={styles.dotsRow} testID={testID ? `${testID}-dots` : undefined}>
      <Animated.View style={[styles.dot, { backgroundColor: color, opacity: dot0 }]} />
      <Animated.View style={[styles.dot, { backgroundColor: color, opacity: dot1 }]} />
      <Animated.View style={[styles.dot, { backgroundColor: color, opacity: dot2 }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 16,
  },
  copy: {
    fontSize: 18,
    lineHeight: 26,
    textAlign: 'center',
  },
  dotsRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 12,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    marginHorizontal: 4,
  },
});
