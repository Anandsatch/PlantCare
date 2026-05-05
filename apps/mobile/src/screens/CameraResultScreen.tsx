/**
 * E5-008 — `<CameraResultScreen>`: A-3 success path. The rescue moment.
 *
 * Receives a captured photo URI + capture mode from the camera flow, runs
 * `expo-image-manipulator` compression (E5-005), calls `useDiagnoseRequest()`
 * (E5-006), renders `<DiagnoseLoadingState>` (E5-007) while in-flight, and on
 * success renders the A-3 card from `designs/v1-screens-20260430/A-3-camera.png`:
 * hero photo, Fraunces species/disease label, a small all-caps "{N}% CONFIDENT"
 * tan accent line, an editorial 2-3 line narrative built from the LLM's
 * `fix_steps`, an outline "Get a second opinion" CTA (re-fires diagnose with
 * the same compressed photo, no re-compression), and a filled "Save to {nickname}"
 * primary CTA that hands the full discriminated-union payload + photo URI to
 * the parent via `onSave`. SQLite persistence is E5-011's job.
 *
 * Scope (V1 lock):
 *   - This file owns the A-3 SUCCESS PATH ONLY. The error / Layer-1 reject /
 *     low-confidence / queued / timeout / parse_error variants ship in E5-009.
 *     Until then, anything that isn't `result.ok === true` renders a small
 *     placeholder so the screen never crashes — but there is no styled error UI
 *     here, no retry button for those paths, no offline banner. See the
 *     `// TODO E5-009` markers below.
 *   - No SQLite write. `onSave` callback is invoked with the full payload +
 *     photo URI; E5-011 wires the actual `INSERT INTO diagnoses ...`.
 *   - Discriminated union is preserved verbatim. The parent (and E5-009 when
 *     it lands) gets every distinct kind from `ApiResult<DiagnoseResponse>` —
 *     no collapsing of `network` + `timeout` + `server` into a single bucket.
 *
 * Lifecycle:
 *   1. Mount with `{ photoUri, mode, plantContext? }` from the camera flow.
 *   2. Compress photo via `compressPhoto` (E5-005). Compression result is
 *      cached in a ref so "Try again" / "Get a second opinion" re-fire the
 *      diagnose request against the SAME compressed file — never recompress.
 *      (Recompression would re-encode the JPEG, producing a slightly different
 *      file each time and throwing away the document-directory copy we just
 *      paid for.)
 *   3. After compression resolves, fire `diagnose({ photoUri: compressed.uri,
 *      plantContext })` exactly once on the initial mount.
 *   4. While `status === 'requesting'` (or compression is in flight), render
 *      `<DiagnoseLoadingState>`.
 *   5. On `lastResult.ok === true`: render the A-3 success card.
 *   6. On any non-ok result: render the E5-009 placeholder.
 *
 * Re-fire semantics:
 *   - "Get a second opinion" / "Try again" calls `diagnose()` with the SAME
 *     compressed photo URI. The hook itself owns race-by-call-order (most
 *     recent call wins, never overwritten by an older slow-resolving call).
 *
 * AppState resume:
 *   - When the user backgrounds the app mid-request and returns, we DO NOT
 *     re-fire the diagnose call. The hook's in-flight request continues
 *     running on resume; the loading bucket clock is anchored to the wall
 *     clock at compression-resolve time, so the time bucket continues from
 *     where it was rather than restarting at "Looking closely…". This mirrors
 *     the resume pattern from CameraView (E5-004) where AppState 'active'
 *     re-syncs upstream snapshots without forcing a re-do of in-flight work.
 *
 * Reduce-motion:
 *   - The success-card reveal uses an Animated fade-in. When `useReduceMotion()`
 *     reports true, the animation is skipped entirely — the card mounts at full
 *     opacity. We do not damp the animation; we omit the transform. Audit-
 *     defensible compliance per the same lock as DiagnoseLoadingState (E5-007).
 *
 * Token verification (DESIGN.md):
 *   - Surface fill / hero skeleton: `theme.colors.surface` (cream / forest)
 *   - Body + headline text: `theme.colors.text`
 *   - Confidence accent line: `theme.colors.tan` (the A-3 mockup uses the tan
 *     soil color for the "92% CONFIDENT" small all-caps line — the only
 *     accent tan that exists in the palette, no `theme.warn` token exists)
 *   - Narrative body in muted text: `theme.colors.textMuted`
 *   - Buttons inherit from `<EditorialButton>` (already token-verified).
 */

import { fonts } from '@plantcare/theme';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from 'react';
import {
  Animated,
  AppState,
  type AppStateStatus,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import type { ApiClient, ApiResult, DiagnoseResponse } from '../api';
import { DiagnoseLoadingState } from '../components/DiagnoseLoadingState';
import { EditorialButton, HeroPhoto } from '../components/primitives';
import { useDiagnoseRequest, type PlantContext } from '../hooks/useDiagnoseRequest';
import { useReduceMotion } from '../hooks/useReduceMotion';
import { useTheme } from '../hooks/useTheme';
import {
  compressPhoto as defaultCompressPhoto,
  type CompressPhotoInput,
  type CompressPhotoResult,
} from '../photos';

/** Payload handed to `onSave` when the user saves the diagnosis. */
export type CameraResultSavePayload = {
  /** The full discriminated-union success result. The narrowed `ok: true`
   *  shape is the only one that reaches `onSave` because the Save button
   *  is only rendered on the success branch. */
  result: { ok: true; data: DiagnoseResponse };
  /** Compressed photo URI (the on-disk file in `documentDirectory/plants/...`). */
  photoUri: string;
  /** The capture mode (`'identify'` or `'diagnose'`) that produced this result. */
  mode: 'identify' | 'diagnose';
  /** The plant context, if any, that was attached to the diagnose request. */
  plantContext?: PlantContext;
};

export type CameraResultScreenProps = {
  /** The captured (uncompressed) photo URI from the camera flow. */
  photoUri: string;
  /** Mode the camera was in when the photo was taken. Forwarded to onSave. */
  mode: 'identify' | 'diagnose';
  /** Plant context attached to the diagnose request. */
  plantContext?: PlantContext;
  /**
   * Display name for the success-card primary CTA, e.g. `"Save to Steve"`.
   * Falls back to `"Save to my plants"` when omitted (the FAB long-press
   * "Quick diagnose" path doesn't have a plant nickname; E5-011 supplies it
   * from the plant context when it does).
   */
  plantNickname?: string;
  /** API client for `useDiagnoseRequest`. Injected so tests can mock cleanly. */
  apiClient: ApiClient;
  /**
   * Called when the user taps the success-card primary CTA. The actual
   * SQLite write lives in E5-011; this screen only signals intent and
   * forwards the payload upstream.
   */
  onSave: (payload: CameraResultSavePayload) => void;
  /**
   * Called when the user dismisses the result screen (close button — TODO,
   * not part of the A-3 success card per the mockup; reserved for E5-009).
   */
  onClose?: () => void;
  /** Test seam: override compression. Defaults to the production helper. */
  compressPhotoImpl?: (input: CompressPhotoInput) => Promise<CompressPhotoResult>;
  testID?: string;
};

type ScreenPhase =
  | { kind: 'compressing' }
  | { kind: 'compress-failed'; error: unknown }
  | { kind: 'ready'; compressed: CompressPhotoResult };

export function CameraResultScreen({
  photoUri,
  mode,
  plantContext,
  plantNickname,
  apiClient,
  onSave,
  onClose,
  compressPhotoImpl = defaultCompressPhoto,
  testID,
}: CameraResultScreenProps): ReactElement {
  const theme = useTheme();
  const reduceMotion = useReduceMotion();

  const { diagnose, status, lastResult } = useDiagnoseRequest({ apiClient });

  // Compression phase. Fires once on mount; the result is held for the lifetime
  // of the screen so re-fire ("Try again", "Get a second opinion") re-uses the
  // same compressed file rather than re-encoding from `photoUri` every time.
  const [phase, setPhase] = useState<ScreenPhase>({ kind: 'compressing' });
  // Track of the in-flight compression so unmount during compression doesn't
  // setState. The compress impl can take 100-500ms on a real device so this
  // window is non-trivial.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Track whether we've already fired the *initial* diagnose call so re-renders
  // don't double-fire it. Re-fire ("Try again") is an explicit user action that
  // calls `diagnose()` directly — it does not flip this ref.
  //
  // P2 (codex): the latch must reset when `photoUri` changes so a parent that
  // reuses the same mounted screen instance for a new capture (e.g. user takes
  // a second photo without unmounting) re-fires the initial diagnose call.
  // Reset happens in the same effect that re-runs compression on photoUri
  // change, before either side-effect kicks off.
  const initialDiagnoseFiredRef = useRef(false);

  // Fire compression once per `photoUri`. On a new photoUri, reset the
  // initial-diagnose latch and the compression phase so the screen restarts
  // its lifecycle without remount. The compressPhotoImpl prop is captured at
  // mount time per V1 convention (we don't anticipate it changing); the
  // eslint exhaustive-deps disable below is intentional.
  useEffect(() => {
    let cancelled = false;
    initialDiagnoseFiredRef.current = false;
    setPhase({ kind: 'compressing' });
    (async () => {
      try {
        const compressed = await compressPhotoImpl({ sourceUri: photoUri });
        if (cancelled || !mountedRef.current) return;
        setPhase({ kind: 'ready', compressed });
      } catch (err) {
        if (cancelled || !mountedRef.current) return;
        setPhase({ kind: 'compress-failed', error: err });
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [photoUri]);

  // Once compression is ready, fire the diagnose request exactly once.
  useEffect(() => {
    if (phase.kind !== 'ready') return;
    if (initialDiagnoseFiredRef.current) return;
    initialDiagnoseFiredRef.current = true;
    void diagnose({ photoUri: phase.compressed.uri, plantContext });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, diagnose]);

  // AppState resume: do nothing destructive. We register a no-op listener so
  // future telemetry / analytics can hook in (mirrors CameraView's pattern of
  // owning the AppState subscription for the screen). The diagnose hook's
  // mountedRef + race-by-call-order guards already ensure no double-fire on
  // resume; the loading bucket clock is anchored at compression-resolve time
  // so it continues from where it was rather than resetting.
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      // Background → active: do not re-fire diagnose. The in-flight request
      // (if any) continues; the loading-state bucket math is wall-clock based
      // (DiagnoseLoadingState's startedAtMs anchor), so on resume the bucket
      // is computed against the original anchor, not reset.
      appStateRef.current = next;
    });
    return () => sub.remove();
  }, []);

  // Re-fire callback for "Try again" / "Get a second opinion".
  // Crucially: re-uses `phase.compressed.uri` — never recompresses.
  const handleRetry = useCallback(() => {
    if (phase.kind !== 'ready') return;
    void diagnose({ photoUri: phase.compressed.uri, plantContext });
  }, [phase, diagnose, plantContext]);

  // Save callback. Only invokable when the result is a success.
  const handleSave = useCallback(() => {
    if (phase.kind !== 'ready') return;
    if (!lastResult || !lastResult.ok) return;
    onSave({
      result: lastResult,
      photoUri: phase.compressed.uri,
      mode,
      plantContext,
    });
  }, [phase, lastResult, onSave, mode, plantContext]);

  // Reveal fade for the success card. Skipped entirely under reduce-motion.
  const successOpacity = useRef(new Animated.Value(reduceMotion ? 1 : 0)).current;
  // Track when we transition into the success state so the fade fires once.
  const successFadedRef = useRef(false);
  useEffect(() => {
    if (status !== 'success') return;
    if (successFadedRef.current) return;
    successFadedRef.current = true;
    if (reduceMotion) {
      successOpacity.setValue(1);
      return;
    }
    Animated.timing(successOpacity, {
      toValue: 1,
      duration: 300,
      useNativeDriver: true,
    }).start();
  }, [status, reduceMotion, successOpacity]);

  // ─── Render ───────────────────────────────────────────────────────────

  const isLoading =
    phase.kind === 'compressing' ||
    (phase.kind === 'ready' && (status === 'idle' || status === 'requesting'));

  const isSuccess = lastResult !== null && lastResult.ok === true;

  return (
    <ScrollView
      testID={testID}
      style={[styles.scroll, { backgroundColor: theme.colors.bg }]}
      contentContainerStyle={styles.scrollContent}
    >
      {/* Hero photo (always present once compression resolves; falls back to
          original photoUri while compressing so the user has visual continuity
          from the camera flow). */}
      <HeroPhoto
        source={{
          uri: phase.kind === 'ready' ? phase.compressed.uri : photoUri,
        }}
        aspectRatio={1}
        rounded={16}
        accessibilityLabel="Captured photo"
        testID={testID ? `${testID}-hero` : undefined}
      />

      {isLoading && (
        <View style={styles.loadingDock} testID={testID ? `${testID}-loading` : undefined}>
          <DiagnoseLoadingState />
        </View>
      )}

      {isSuccess && lastResult.ok && (
        <Animated.View
          style={[styles.successCard, { opacity: successOpacity }]}
          testID={testID ? `${testID}-success` : undefined}
        >
          <Text
            accessibilityRole="text"
            style={[
              styles.confidenceLine,
              { color: theme.colors.tan, fontFamily: fonts.body.semibold },
            ]}
            testID={testID ? `${testID}-confidence` : undefined}
          >
            {`${Math.round(lastResult.data.confidence)}% CONFIDENT`}
          </Text>
          <Text
            accessibilityRole="header"
            style={[
              styles.headline,
              { color: theme.colors.text, fontFamily: fonts.display.semibold },
            ]}
            testID={testID ? `${testID}-headline` : undefined}
          >
            {lastResult.data.disease_label}
          </Text>
          <Text
            style={[
              styles.narrative,
              { color: theme.colors.textMuted, fontFamily: fonts.body.regular },
            ]}
            testID={testID ? `${testID}-narrative` : undefined}
          >
            {buildNarrative(lastResult.data)}
          </Text>

          <View style={styles.ctaStack}>
            <EditorialButton
              variant="outline"
              label="Get a second opinion"
              onPress={handleRetry}
              accessibilityLabel="Get a second opinion"
              accessibilityHint="Re-runs the diagnose request with the same photo"
              testID={testID ? `${testID}-retry` : undefined}
            />
            <View style={styles.ctaSpacer} />
            <EditorialButton
              variant="filled"
              label={plantNickname ? `Save to ${plantNickname}` : 'Save to my plants'}
              onPress={handleSave}
              accessibilityLabel={
                plantNickname ? `Save to ${plantNickname}` : 'Save to my plants'
              }
              testID={testID ? `${testID}-save` : undefined}
            />
          </View>
        </Animated.View>
      )}

      {/* TODO E5-009: render proper variants for non-success kinds. Until E5-009
          ships, render a small placeholder so the screen doesn't crash and the
          discriminated-union shape stays preserved upstream. The branch covers
          two cases:
            (1) `compress-failed` — `compressPhoto` rejected before diagnose
                ever ran. Surfaces with `kind: 'compress-failed'` so E5-009 can
                style this distinct from API-side errors.
            (2) any non-ok `lastResult` — the API path returned a non-success
                kind from the discriminated union; surface that kind verbatim. */}
      {phase.kind === 'compress-failed' && (
        <View
          style={styles.placeholder}
          testID={testID ? `${testID}-placeholder` : undefined}
        >
          <Text
            style={[
              styles.placeholderCopy,
              { color: theme.colors.textMuted, fontFamily: fonts.body.regular },
            ]}
          >
            {"We'll improve this in E5-009 (kind: compress-failed)."}
          </Text>
          {onClose && (
            <View style={styles.placeholderCtaSpacer}>
              <EditorialButton
                variant="outline"
                label="Close"
                onPress={onClose}
                testID={testID ? `${testID}-placeholder-close` : undefined}
              />
            </View>
          )}
        </View>
      )}
      {!isLoading && phase.kind !== 'compress-failed' && lastResult !== null && !lastResult.ok && (
        <View
          style={styles.placeholder}
          testID={testID ? `${testID}-placeholder` : undefined}
        >
          <Text
            style={[
              styles.placeholderCopy,
              { color: theme.colors.textMuted, fontFamily: fonts.body.regular },
            ]}
          >
            {`We'll improve this in E5-009 (kind: ${lastResult.kind}).`}
          </Text>
          {onClose && (
            <View style={styles.placeholderCtaSpacer}>
              <EditorialButton
                variant="outline"
                label="Close"
                onPress={onClose}
                testID={testID ? `${testID}-placeholder-close` : undefined}
              />
            </View>
          )}
        </View>
      )}
    </ScrollView>
  );
}

/**
 * Build the editorial narrative paragraph from the LLM payload.
 *
 * The A-3 mockup shows 2-3 sentences of warm-but-clinical prose. The
 * `DiagnoseResponse` carries `fix_steps: string[]` (0..8 short imperative
 * bullets) — we collapse those into a single editorial paragraph by joining
 * them with sentence punctuation. This is intentionally simple: the LLM
 * already wrote in editorial voice; we don't try to add prose that isn't
 * grounded in the model's output.
 *
 * Fallback chain:
 *   - if `fix_steps.length > 0`: join with periods.
 *   - else if `disease_slug === 'healthy'`: friendly all-clear line.
 *   - else: empty narrative (the headline + confidence line still carry
 *     meaning; this branch is rare and is the right place for a quiet
 *     editorial silence rather than a generic "no details available" line).
 */
function buildNarrative(data: DiagnoseResponse): string {
  if (data.fix_steps && data.fix_steps.length > 0) {
    return data.fix_steps
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map((s) => (s.endsWith('.') || s.endsWith('!') || s.endsWith('?') ? s : `${s}.`))
      .join(' ');
  }
  if (data.disease_slug === 'healthy') {
    return 'Looks healthy. Keep up your current routine.';
  }
  return '';
}

// Useful in tests to assert the narrative-builder behavior without rendering
// the screen. Exported for that purpose; not part of the public API.
export const __testing = { buildNarrative };

const styles = StyleSheet.create({
  scroll: {
    flex: 1,
  },
  scrollContent: {
    paddingBottom: 32,
  },
  loadingDock: {
    paddingTop: 32,
    paddingHorizontal: 24,
  },
  successCard: {
    paddingTop: 24,
    paddingHorizontal: 24,
  },
  confidenceLine: {
    fontSize: 12,
    letterSpacing: 1.2,
    marginBottom: 8,
  },
  headline: {
    fontSize: 32,
    lineHeight: 36,
    marginBottom: 12,
  },
  narrative: {
    fontSize: 16,
    lineHeight: 24,
    marginBottom: 24,
  },
  ctaStack: {
    marginTop: 8,
  },
  ctaSpacer: {
    height: 12,
  },
  placeholder: {
    paddingTop: 32,
    paddingHorizontal: 24,
  },
  placeholderCopy: {
    fontSize: 14,
    lineHeight: 20,
  },
  placeholderCtaSpacer: {
    marginTop: 16,
  },
});
