import { fonts } from '@plantcare/theme';
import * as Location from 'expo-location';
import {
  type ElementRef,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  AppState,
  BackHandler,
  findNodeHandle,
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { useTheme } from '../hooks/useTheme';

// E6-003 — Conservatory cream pre-prompt that fronts the iOS / Android
// foreground-location permission dialog, with a manual ZIP fallback for users
// who prefer to share a postal code instead. Mirrors the structure of E5-003's
// `<CameraPermissionPrePrompt>` but with one extra branching state ('zip-
// fallback') because the master plan §"Watering rules — missing inputs"
// guarantees a ZIP-entry path for users who decline the OS dialog or who
// previously denied permanently.
//
// **Foreground only.** V1 lock: we never request background-location. The
// weather modifier consults a single point-in-time forecast at watering
// rule evaluation, not a continuous track.
//
// **Component scope.** This component COLLECTS a ZIP and EMITS it via
// `onZipSubmit`; it does NOT geocode. Geocoding lives on the backend behind
// the Open-Meteo wrapper (E6-001 / E6-002). This keeps the trust boundary
// honest: the device never holds an Open-Meteo key, and the cache is
// server-side per-lat/lon.
//
// **onGranted contract.** When the user's foreground request resolves
// granted=true, this component fires `onGranted({ latitude, longitude })`
// from a single follow-up `getCurrentPositionAsync` call. We chose to fetch
// position here (rather than `onGranted()` and let the parent fetch) for two
// reasons: (1) we already own the await window and the parent shouldn't have
// to also handle the resolving state, and (2) `getCurrentPositionAsync`
// shares the same permission-denied failure modes as the request — keeping
// them co-located means the parent never sees a half-granted state. If the
// position fetch itself rejects (rare; airplane mode mid-grant), we fall
// back to surfacing the ZIP fallback so the user has a recovery path.
//
// State machine:
//   resolving    — initial. `Location.getForegroundPermissionsAsync()` is
//                  in flight. Render a single blank `theme.colors.bg` frame
//                  so already-granted users never flash the cream pre-prompt
//                  (mirrors E5-003 codex P2 fix).
//   undetermined — render the cream pre-prompt with the WHY copy + two CTAs
//                  ("Use my location" → request, "Enter ZIP instead" →
//                  zip-fallback).
//   requesting   — transient; CTA disabled with ActivityIndicator while the
//                  OS dialog is in flight.
//   denied       — permission denied with `canAskAgain=false`. Tan banner
//                  card with `Linking.openSettings()` deep-link CTA + a
//                  secondary "Enter ZIP instead" CTA. The ZIP path keeps
//                  the user from being stranded if they decline both.
//   zip-fallback — TextInput for a 5-digit US ZIP. Validates length=5,
//                  digit-only, leading zeros preserved (06511 stays 06511).
//                  Strips paste-style suffixes ("12345-6789" → "12345"). On
//                  submit, fires `onZipSubmit(zip)`. The component does NOT
//                  geocode — backend Open-Meteo wrapper owns that.
//   granted      — transient; we fired `onGranted({ lat, lon })` and now
//                  render nothing. Parent owns what comes next.
//
// Edge cases:
//   * `requestForegroundPermissionsAsync` rejection → return to
//     'undetermined' so the user can retry.
//   * `getCurrentPositionAsync` rejection (post-grant) → flip to
//     'zip-fallback' so the user has a working alternative; permission
//     itself was granted, so no canAskAgain budget burned.
//   * AppState transition to 'active' → re-query
//     `getForegroundPermissionsAsync()`. Never `request*` from this path
//     (would burn `canAskAgain`). Mirrors `<PlantCareCameraView>`.
//   * Android hardware back → `onCancel()` + return true. We register the
//     listener at the root regardless of state so the user always has a
//     working back path; the parent can treat cancel as "navigate back".
//   * Reduce-motion → no animations in this component currently, but the
//     listener is wired (parity with the camera pre-prompt) so future
//     polish can read the value without re-plumbing.

type State =
  | 'resolving'
  | 'undetermined'
  | 'requesting'
  | 'denied'
  | 'zip-fallback'
  | 'granted';

export type LocationCoords = {
  latitude: number;
  longitude: number;
};

export type LocationPermissionPrePromptProps = {
  /**
   * Fired exactly once when the user has granted foreground-location
   * permission AND we successfully fetched a position. The parent can use
   * the coords to call `/api/weather` for the weather modifier.
   */
  onGranted: (coords: LocationCoords) => void;
  /**
   * Fired exactly once when the user submits a 5-digit US ZIP from the
   * fallback state. The parent forwards this to the backend's geocoding
   * wrapper (E6-001) — the device never holds the Open-Meteo key.
   */
  onZipSubmit: (zip: string) => void;
  /** Fired when the user dismisses (Android back, "Not now"). */
  onCancel: () => void;
  /** Optional testID forwarded to the root View for E2E selectors. */
  testID?: string;
};

export function LocationPermissionPrePrompt({
  onGranted,
  onZipSubmit,
  onCancel,
  testID,
}: LocationPermissionPrePromptProps): React.ReactElement | null {
  const theme = useTheme();
  const [state, setState] = useState<State>('resolving');
  const [zip, setZip] = useState<string>('');
  // Track which coords we emitted so onGranted fires exactly once even if
  // React re-renders us with a stale state transition.
  const grantedFiredRef = useRef<boolean>(false);
  // Single mutable ref for component-lifetime cancellation. Codex P1 (E6-003):
  // a per-call captured snapshot ({current: cancelled}) is broken because the
  // value is fixed at call time — a late `getCurrentPositionAsync` can still
  // call setState after unmount. One ref shared across every async path means
  // unmount cleanup actually stops late callbacks.
  const unmountedRef = useRef<boolean>(false);
  // In-flight guard for fetchAndEmitGranted. Codex P1 (E6-003): without this
  // an AppState resume that races the mount-path resolve can both observe
  // `!grantedFiredRef.current` before either flips it, double-firing onGranted.
  // The `inFlightRef` short-circuits overlapping invocations.
  const grantInFlightRef = useRef<boolean>(false);
  // Refs for accessibility focus handoff on state transitions (codex P3).
  // We forward the ref to whichever heading View is currently rendered;
  // after a state change, the effect below moves screen-reader focus to it.
  const focusTargetRef = useRef<ElementRef<typeof View> | null>(null);

  // Helper: fetch current position and emit onGranted exactly once. On
  // failure, drop into ZIP fallback so the user isn't stranded. Cancel-safe
  // via the component-scoped `unmountedRef`; single-flight via
  // `grantInFlightRef` so racing call sites (mount + AppState resume) can't
  // both pass the `grantedFiredRef` check. Both refs are codex P1 fixes.
  const fetchAndEmitGranted = useCallback(async () => {
    if (grantInFlightRef.current || grantedFiredRef.current) return;
    grantInFlightRef.current = true;
    try {
      const position = await Location.getCurrentPositionAsync({});
      if (unmountedRef.current) return;
      if (!grantedFiredRef.current) {
        grantedFiredRef.current = true;
        setState('granted');
        onGranted({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
        });
      }
    } catch {
      if (unmountedRef.current) return;
      // Permission was granted but we couldn't get a fix (airplane mode,
      // GPS disabled, etc.) — give the user a working alternative.
      setState('zip-fallback');
    } finally {
      grantInFlightRef.current = false;
    }
  }, [onGranted]);

  // Resolve the initial permission snapshot. Mirrors the E5-003 codex P2 fix:
  // render a blank surface frame in 'resolving' so already-granted users
  // never see the cream pre-prompt flash on mount. We DO fetch the
  // foreground permission here (vs. relying on a hook) because expo-location
  // ships an async function rather than a hook tuple — we own the resolve.
  useEffect(() => {
    unmountedRef.current = false;
    (async () => {
      try {
        const snapshot = await Location.getForegroundPermissionsAsync();
        if (unmountedRef.current) return;
        if (snapshot.granted) {
          await fetchAndEmitGranted();
        } else if (!snapshot.canAskAgain) {
          setState('denied');
        } else {
          setState('undetermined');
        }
      } catch {
        // OS hiccup; show the cream pre-prompt so the user can try the
        // request flow which will surface the OS dialog itself.
        if (!unmountedRef.current) setState('undetermined');
      }
    })();
    return () => {
      unmountedRef.current = true;
    };
  }, [fetchAndEmitGranted]);

  // AppState resume: re-query the snapshot when the user returns from
  // Settings. Never call `requestForegroundPermissionsAsync` here — that
  // would burn the `canAskAgain` budget on a non-user-initiated event.
  useEffect(() => {
    const sub = AppState.addEventListener('change', async (next) => {
      if (next !== 'active') return;
      if (unmountedRef.current) return;
      try {
        const snapshot = await Location.getForegroundPermissionsAsync();
        if (unmountedRef.current) return;
        if (snapshot.granted && !grantedFiredRef.current) {
          await fetchAndEmitGranted();
        } else if (!snapshot.canAskAgain) {
          setState((prev) => (prev === 'zip-fallback' ? prev : 'denied'));
        }
      } catch {
        // No-op; next focus event will retry.
      }
    });
    return () => sub.remove();
  }, [fetchAndEmitGranted]);

  // Android hardware back / system back gesture → onCancel. iOS has no
  // equivalent, so this is Android-only. Always registered (regardless of
  // state) because every state in this flow has a meaningful "go back".
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onCancel();
      return true;
    });
    return () => sub.remove();
  }, [onCancel]);

  // Reduce-motion observer (inlined to mirror E5-003 / E5-004; E2-004's
  // `useReduceMotion` may already be in main but the stacked base for this
  // PR keeps the inline pattern for parity with sibling permission flows).
  // The hook subscribes purely so that consumers can wire animations later
  // without re-plumbing; we don't currently animate anything here.
  const [, setReduceMotion] = useState<boolean>(false);
  useEffect(() => {
    let cancelled = false;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((enabled) => {
        if (!cancelled) setReduceMotion(enabled);
      })
      .catch(() => {
        // Defaults to false; harmless biased-toward-motion fallback.
      });
    const sub = AccessibilityInfo.addEventListener(
      'reduceMotionChanged',
      (enabled: boolean) => setReduceMotion(enabled),
    );
    return () => {
      cancelled = true;
      sub.remove();
    };
  }, []);

  // Codex P3 (E6-003): screen-reader focus handoff. When the card swaps
  // (undetermined → denied → zip-fallback), VoiceOver/TalkBack focus can
  // remain on a removed element. Move focus to the new state's heading
  // container so the screen reader announces the new context. Skip the
  // 'resolving' and 'granted' renders (no semantic content).
  useEffect(() => {
    if (state === 'resolving' || state === 'granted') return;
    const node = focusTargetRef.current;
    if (node == null) return;
    const handle = findNodeHandle(node);
    if (handle == null) return;
    AccessibilityInfo.setAccessibilityFocus(handle);
  }, [state]);

  const handleRequest = useCallback(async () => {
    setState('requesting');
    try {
      const response = await Location.requestForegroundPermissionsAsync();
      if (unmountedRef.current) return;
      if (response.granted) {
        await fetchAndEmitGranted();
      } else if (!response.canAskAgain) {
        setState('denied');
      } else {
        // User dismissed without flipping canAskAgain → let them retry.
        setState('undetermined');
      }
    } catch {
      if (unmountedRef.current) return;
      // Treat OS rejections as transient; user can retry.
      setState('undetermined');
    }
  }, [fetchAndEmitGranted]);

  const handleEnterZip = useCallback(() => {
    setState('zip-fallback');
  }, []);

  const handleOpenSettings = useCallback(() => {
    void Linking.openSettings();
  }, []);

  // ZIP input sanitizer. Three paste shapes to handle:
  //   * "12345"       → "12345"  (typed)
  //   * "12345-6789"  → "12345"  (ZIP+4)
  //   * "+1 94110"    → "94110"  (US phone country-code prefix; codex P2 catch)
  // Strategy: strip a leading "+1" or "1 " country-code prefix first so the
  // phone-paste case doesn't silently consume the user's actual ZIP digits,
  // then strip remaining non-digits and clamp to the first 5. Leading zeros
  // are preserved because we operate on strings throughout — Number(zip)
  // would drop a "06511" → 6511.
  const handleZipChange = useCallback((next: string) => {
    const withoutCountryCode = next.replace(/^\s*\+?1[\s-]+/, '');
    const digitsOnly = withoutCountryCode.replace(/[^0-9]/g, '');
    setZip(digitsOnly.slice(0, 5));
  }, []);

  const handleZipSubmit = useCallback(() => {
    if (zip.length !== 5) return;
    onZipSubmit(zip);
  }, [zip, onZipSubmit]);

  // 'resolving' / 'granted': render nothing semantic. For 'resolving' we
  // return a single blank surface frame so an already-granted user never
  // sees the cream card flash. For 'granted', the parent has taken over.
  if (state === 'resolving') {
    return (
      <View
        testID={testID}
        style={[styles.resolvingFrame, { backgroundColor: theme.colors.bg }]}
      />
    );
  }
  if (state === 'granted') return null;

  if (state === 'denied') {
    return (
      <View
        ref={focusTargetRef}
        testID={testID}
        accessibilityLiveRegion="polite"
        style={[
          styles.card,
          { backgroundColor: theme.colors.surface, borderColor: theme.colors.tan },
        ]}
      >
        <Text
          accessibilityRole="header"
          style={[styles.headline, { color: theme.colors.text }]}
        >
          Location blocked
        </Text>
        <Text style={[styles.body, { color: theme.colors.textMuted }]}>
          Open Settings to enable location, or enter your ZIP instead.
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Open the Settings app to enable location access"
          onPress={handleOpenSettings}
          style={[styles.ctaPrimary, { backgroundColor: theme.colors.primary }]}
        >
          <Text style={[styles.ctaPrimaryLabel, { color: theme.colors.surface }]}>
            Open Settings
          </Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Enter ZIP instead"
          onPress={handleEnterZip}
          style={styles.ctaSecondary}
        >
          <Text style={[styles.ctaSecondaryLabel, { color: theme.colors.text }]}>
            Enter ZIP instead
          </Text>
        </Pressable>
        {/* Codex P2 (E6-003): direct cancel affordance from denied. Without
            this a user who refuses both location AND ZIP is stranded on the
            denied card with no exit. The parent owns what cancel means. */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Not now"
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

  if (state === 'zip-fallback') {
    const isValid = zip.length === 5;
    return (
      <View
        ref={focusTargetRef}
        testID={testID}
        style={[
          styles.card,
          { backgroundColor: theme.colors.surface, borderColor: theme.colors.stroke },
        ]}
      >
        <Text
          accessibilityRole="header"
          style={[styles.headline, { color: theme.colors.text }]}
        >
          Enter your ZIP
        </Text>
        <Text style={[styles.body, { color: theme.colors.textMuted }]}>
          We&apos;ll use it to check the local forecast for your watering
          schedule.
        </Text>
        <TextInput
          accessibilityLabel="ZIP code"
          accessibilityHint="Enter a 5-digit US ZIP code"
          testID="location-zip-input"
          value={zip}
          onChangeText={handleZipChange}
          onSubmitEditing={handleZipSubmit}
          keyboardType="number-pad"
          maxLength={5}
          placeholder="12345"
          placeholderTextColor={theme.colors.textMuted}
          style={[
            styles.zipInput,
            {
              color: theme.colors.text,
              borderColor: theme.colors.stroke,
              backgroundColor: theme.colors.bg,
            },
          ]}
          returnKeyType="done"
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Submit ZIP"
          accessibilityState={{ disabled: !isValid }}
          disabled={!isValid}
          onPress={handleZipSubmit}
          style={[
            styles.ctaPrimary,
            { backgroundColor: theme.colors.primary },
            !isValid && styles.ctaPrimaryDisabled,
          ]}
        >
          <Text style={[styles.ctaPrimaryLabel, { color: theme.colors.surface }]}>
            Continue
          </Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Not now"
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

  // 'undetermined' or 'requesting' → cream pre-prompt.
  const isRequesting = state === 'requesting';

  return (
    <View
      ref={focusTargetRef}
      testID={testID}
      style={[
        styles.card,
        { backgroundColor: theme.colors.surface, borderColor: theme.colors.stroke },
      ]}
    >
      <Text
        accessibilityRole="header"
        style={[styles.headline, { color: theme.colors.text }]}
      >
        PlantCare wants your location
      </Text>
      <Text style={[styles.body, { color: theme.colors.textMuted }]}>
        To check the forecast for your watering decisions. Used only on this
        device.
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Use my location"
        accessibilityState={{ disabled: isRequesting, busy: isRequesting }}
        disabled={isRequesting}
        onPress={handleRequest}
        style={[
          styles.ctaPrimary,
          { backgroundColor: theme.colors.primary },
          isRequesting && styles.ctaPrimaryDisabled,
        ]}
      >
        {isRequesting ? (
          <ActivityIndicator
            testID="location-pre-prompt-spinner"
            color={theme.colors.surface}
          />
        ) : (
          <Text style={[styles.ctaPrimaryLabel, { color: theme.colors.surface }]}>
            Use my location
          </Text>
        )}
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Enter ZIP instead"
        disabled={isRequesting}
        onPress={handleEnterZip}
        style={styles.ctaSecondary}
      >
        <Text style={[styles.ctaSecondaryLabel, { color: theme.colors.text }]}>
          Enter ZIP instead
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
  // Single blank frame rendered while we resolve the initial snapshot. Sized
  // to fill its parent so it doesn't reflow when we transition out.
  resolvingFrame: {
    flex: 1,
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
  zipInput: {
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    paddingVertical: 12,
    paddingHorizontal: 16,
    minHeight: 44,
    fontFamily: fonts.body.regular,
    fontSize: 17,
    letterSpacing: 2,
  },
});
