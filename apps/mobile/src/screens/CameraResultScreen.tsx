/**
 * E5-008 + E5-009 — `<CameraResultScreen>`: A-3 success path AND every error
 * variant. The rescue moment, end-to-end.
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
 *   - This file owns the A-3 SUCCESS PATH (E5-008) and every distinct error
 *     variant from `ApiResult<DiagnoseResponse>` (E5-009). The discriminated
 *     union STAYS distinct — no collapsing of `network` + `timeout` + `server`
 *     + `parse_error` into a single bucket. Each kind gets its own headline,
 *     narrative, and CTA pair per the master plan's Interaction-states section.
 *   - No SQLite write. `onSave` callback is invoked with the full payload +
 *     photo URI; E5-011 wires the actual `INSERT INTO diagnoses ...`.
 *   - `kind: 'queued'` re-uses the `<ToastBanner type='pending'>` primitive
 *     when present (E2 primitives barrel). The parent screen owns the actual
 *     sync_queue persistence (E7) — this screen renders the visual treatment
 *     only.
 *
 * Error variants (per kind, all from `ApiResult<DiagnoseResponse>`):
 *   - `low_confidence`: editorial Fraunces "We're not quite sure" headline,
 *     Inter narrative explaining the model wasn't confident, candidate species
 *     list (`message` field — alternatives aren't on the union, only inside
 *     `data` which `low_confidence` doesn't carry), primary "Pick from list"
 *     CTA → `onPickFromList()`, secondary "Try a different photo" → `onRetake()`.
 *     Does NOT auto-save anything (the brief: "DO NOT auto-save anything").
 *   - `timeout`: tan banner editorial "Diagnose is taking longer than usual."
 *     Primary "Try again" → re-fires `diagnose()` with the SAME compressed
 *     photo (never recompress). Secondary "Save photo for now" →
 *     `onSavePhotoOnly(payload)` so parent can persist a photo-only record
 *     without the diagnose result.
 *   - `network`: distinct copy from timeout — "We can't reach the server.
 *     Check your connection?" Same retry + save-for-now CTA pair. (Note: the
 *     `useDiagnoseRequest` hook coerces api-client `network` → `queued` for the
 *     V1 offline UX. But the discriminated union still has `network`, and a
 *     future netInfo-aware path or an api client change could surface it
 *     directly. We render proper UI for it so the kind isn't dead code.)
 *   - `server`: "Something went wrong on our end." Primary "Try again" →
 *     re-fires diagnose. Secondary "Report" → `onReportError(payload)` so the
 *     parent can hand a redacted payload to telemetry. The retry copy on the
 *     CTA itself stays "Try again", consistent with the timeout/network
 *     primary-CTA voice. The `retry_after` field on the union is not consumed
 *     yet — V1 leaves backoff to the user.
 *   - `parse_error`: distinct from `server` because the failure mode is local
 *     parse, not upstream. "We got a response we couldn't understand. Try
 *     again?" Single "Try again" CTA → re-fires diagnose.
 *   - `layer1_reject`: kind editorial card — Fraunces "We're focused on plant
 *     care", Inter body explaining the photo doesn't appear to be a plant.
 *     Primary "Try a different photo" → `onRetake()`. Voice mirrors the
 *     E8-003 AddNoteSheet's reject card.
 *   - `queued`: pending toast-style state — "We'll save when you're back
 *     online." Uses `<ToastBanner type='pending'>` from the primitives barrel.
 *     Stack dependency: ToastBanner ships from the E2 primitives barrel which
 *     is in the stack base under `apps/mobile/src/components/primitives/index.ts`.
 *     This is a hard import (compile-time dep), not a feature-flagged optional
 *     — the codex adversarial pass flagged this; verified the symbol is in
 *     `origin/Anandsatch/e5-camera-result` so the stack is consistent. No retry
 *     CTA — the sync layer (E7) drains the queue when connectivity returns.
 *   - `compress-failed` (screen-internal, not from `ApiResult`): the same
 *     editorial tone as `parse_error` — "We had trouble preparing your photo.
 *     Try a different shot?" Primary "Try a different photo" → `onRetake()`.
 *     This kind isn't on the union; it's a screen-local phase from the
 *     compression pipeline.
 *
 * Reduce-motion (every error variant):
 *   - The reveal fade follows the same hard-disable pattern as the success
 *     card: `useRef(new Animated.Value(reduceMotion ? 1 : 0))` + a guard that
 *     skips `Animated.timing` entirely when reduce-motion is on. Audit-
 *     defensible compliance per the lock from `DiagnoseLoadingState` (E5-007).
 *
 * A11y (every error variant):
 *   - Container `accessibilityRole='alert'` for error states; `'status'` for
 *     queued (non-disruptive). The role drives VoiceOver to announce the new
 *     state immediately on transition.
 *   - On transition into a non-success state, the screen calls
 *     `AccessibilityInfo.announceForAccessibility(headline)` so VoiceOver
 *     surfaces the editorial copy without requiring a node-handle round-trip.
 *     We chose `announceForAccessibility` over `setAccessibilityFocus` because
 *     the latter requires a `findNodeHandle` lookup that is fragile under
 *     React strict-mode and adds noise to the test harness.
 *   - CTAs have role `button` + label via `<EditorialButton>` (already
 *     a11y-verified in its own ticket).
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
  useRef,
  useState,
  type ReactElement,
} from 'react';
import {
  AccessibilityInfo,
  type AccessibilityRole,
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
import { EditorialButton, HeroPhoto, ToastBanner } from '../components/primitives';
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

/**
 * Payload handed to `onSavePhotoOnly` when the user saves a photo without a
 * diagnose result (timeout / network / similar). Carries the unresolved
 * discriminated-union result so the parent can record the failure kind
 * alongside the photo for later retry.
 */
export type CameraResultSavePhotoOnlyPayload = {
  /** The compressed photo URI. */
  photoUri: string;
  /** The capture mode that produced this photo. */
  mode: 'identify' | 'diagnose';
  /** The plant context, if any. */
  plantContext?: PlantContext;
  /** The non-success result that triggered the save-for-later flow. Null if
   *  saving from the `compress-failed` branch (no result was ever produced). */
  result: Extract<ApiResult<DiagnoseResponse>, { ok: false }> | null;
};

/**
 * Payload handed to `onReportError` from the server-error variant. The
 * `message` field on the discriminated union is forwarded so the parent's
 * telemetry pipeline can include a redacted server hint.
 */
export type CameraResultReportErrorPayload = {
  /** The error kind that triggered the report. */
  kind: 'server' | 'parse_error' | 'timeout' | 'network';
  /** Optional server-supplied message from the union, if any. */
  message?: string;
  /** The compressed photo URI (or the original photoUri if compression failed). */
  photoUri: string;
  /** Capture mode. */
  mode: 'identify' | 'diagnose';
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
   * Called when the user taps "Try a different photo" on a `layer1_reject`
   * card or "Try a different photo" on a `low_confidence` / `compress-failed`
   * card. The parent navigates back to the camera flow. When omitted, the CTA
   * still renders but the press is a no-op — the brief calls out that
   * `onRetake` is the parent's wiring concern.
   */
  onRetake?: () => void;
  /**
   * Called when the user taps "Pick from list" on the `low_confidence` card.
   * Opens the manual species picker — same shape E5-010 uses. When omitted
   * the CTA still renders but is a no-op.
   */
  onPickFromList?: () => void;
  /**
   * Called when the user taps "Save photo for now" on the `timeout` /
   * `network` cards. Parent owns the actual persistence; this screen just
   * emits the callback. When omitted, the CTA is hidden so the screen
   * doesn't promise an action it can't fulfill.
   */
  onSavePhotoOnly?: (payload: CameraResultSavePhotoOnlyPayload) => void;
  /**
   * Called when the user taps "Report" on the `server` / `parse_error`
   * variants. Parent forwards a redacted payload to telemetry. When omitted
   * the CTA is hidden.
   */
  onReportError?: (payload: CameraResultReportErrorPayload) => void;
  /**
   * Called when the user dismisses the result screen (e.g. close button on
   * an error variant). Optional — when omitted, no Close affordance renders.
   */
  onClose?: () => void;
  /** Test seam: override compression. Defaults to the production helper. */
  compressPhotoImpl?: (input: CompressPhotoInput) => Promise<CompressPhotoResult>;
  /**
   * Test seam: override `AccessibilityInfo.announceForAccessibility`. Defaults
   * to the platform implementation. Tests use this to assert the headline
   * announcement on transition into a non-success state without coupling to
   * the AccessibilityInfo native module.
   */
  announceForAccessibilityImpl?: (announcement: string) => void;
  /**
   * E11-006 insertion path. Forwarded to `useDiagnoseRequest` so a
   * terminal-success diagnose call advances the SQLite budget meter
   * `useLlmBudget()` reads. Optional — when omitted, the hook is a
   * no-op on the budget side. Production wires this from the route
   * layer with a `() => openDb()` factory.
   */
  budgetDb?: import('../lib/llmBudget').LlmCallWriter
    | (() => Promise<import('../lib/llmBudget').LlmCallWriter>);
  testID?: string;
};

type ScreenPhase =
  | { kind: 'compressing' }
  | { kind: 'compress-failed'; error: unknown }
  | { kind: 'ready'; compressed: CompressPhotoResult };

/**
 * Discriminator for which error variant is currently active. Combines the
 * screen-internal `compress-failed` phase with the `ApiResult` non-success
 * kinds. `null` means "no error variant should render right now."
 */
type ErrorVariantKind =
  | 'compress-failed'
  | 'low_confidence'
  | 'timeout'
  | 'network'
  | 'server'
  | 'parse_error'
  | 'layer1_reject'
  | 'queued';

type ErrorVariant = {
  kind: ErrorVariantKind;
  /** Editorial copy strings used to render the variant + announce a11y. */
  copy: {
    headline: string;
    body: string;
  };
  /** The forwarded `message` field from the union, when present. Used by the
   *  low_confidence variant to surface candidate species hints, and by the
   *  server variant for telemetry forwarding. */
  message?: string;
};

/**
 * Map the current screen phase + last API result into a single error variant
 * (or null when none should render). Centralizes the precedence rules so the
 * JSX stays declarative.
 *
 * Precedence: `compress-failed` always wins over an API result — if compression
 * never succeeded, we never even fired diagnose, so any prior `lastResult` is
 * stale from a previous photoUri lifecycle.
 */
function resolveErrorVariant(
  phase: ScreenPhase,
  lastResult: ApiResult<DiagnoseResponse> | null,
): ErrorVariant | null {
  if (phase.kind === 'compress-failed') {
    return {
      kind: 'compress-failed',
      copy: {
        headline: 'We had trouble preparing your photo.',
        body: "Try a different shot — the camera or the file may not have saved cleanly.",
      },
    };
  }
  if (phase.kind !== 'ready') return null;
  if (lastResult === null || lastResult.ok) return null;

  switch (lastResult.kind) {
    case 'low_confidence':
      return {
        kind: 'low_confidence',
        copy: {
          headline: "We're not quite sure.",
          body:
            "The model wasn't confident enough to give a definitive answer. Pick from the list of candidates, or try a different photo with clearer light.",
        },
        message: lastResult.message,
      };
    case 'timeout':
      return {
        kind: 'timeout',
        copy: {
          headline: 'Diagnose is taking longer than usual.',
          body:
            'The lab is working on it but we lost patience. Try again in a moment, or save the photo for now and we will diagnose later.',
        },
        message: lastResult.message,
      };
    case 'network':
      return {
        kind: 'network',
        copy: {
          headline: "We can't reach the server.",
          body: 'Check your connection? Once you are back online, try again or save the photo for now.',
        },
        message: lastResult.message,
      };
    case 'server':
      return {
        kind: 'server',
        copy: {
          headline: 'Something went wrong on our end.',
          body: 'Try again in a moment, or report it so we can take a look.',
        },
        message: lastResult.message,
      };
    case 'parse_error':
      return {
        kind: 'parse_error',
        copy: {
          headline: "We got a response we couldn't understand.",
          body: 'Try again — this usually clears on the next request.',
        },
        message: lastResult.message,
      };
    case 'layer1_reject':
      return {
        kind: 'layer1_reject',
        copy: {
          headline: "We're focused on plant care.",
          body: "This photo doesn't look like a plant to us. Try a different shot of a plant or leaf.",
        },
        message: lastResult.message,
      };
    case 'queued':
      return {
        kind: 'queued',
        copy: {
          headline: "We'll save when you're back online.",
          body: 'Your photo is queued. We will diagnose it the next time you have a connection.',
        },
      };
    default: {
      // Exhaustiveness: TypeScript flags any new kind that isn't handled.
      const _exhaustive: never = lastResult.kind;
      void _exhaustive;
      return null;
    }
  }
}

export function CameraResultScreen({
  photoUri,
  mode,
  plantContext,
  plantNickname,
  apiClient,
  onSave,
  onRetake,
  onPickFromList,
  onSavePhotoOnly,
  onReportError,
  onClose,
  compressPhotoImpl = defaultCompressPhoto,
  announceForAccessibilityImpl,
  budgetDb,
  testID,
}: CameraResultScreenProps): ReactElement {
  const theme = useTheme();
  const reduceMotion = useReduceMotion();

  const { diagnose, status, lastResult } = useDiagnoseRequest({
    apiClient,
    ...(budgetDb ? { budgetDb } : {}),
  });

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

  // "Save photo for now" — fires from timeout / network variants. Parent owns
  // the persistence; this screen forwards the compressed photoUri + the
  // unresolved discriminated-union result so the parent can record both.
  const handleSavePhotoOnly = useCallback(() => {
    if (!onSavePhotoOnly) return;
    if (phase.kind !== 'ready') return;
    if (!lastResult || lastResult.ok) return;
    onSavePhotoOnly({
      photoUri: phase.compressed.uri,
      mode,
      plantContext,
      result: lastResult,
    });
  }, [phase, lastResult, onSavePhotoOnly, mode, plantContext]);

  // "Report" — fires from server / parse_error variants. Parent forwards a
  // redacted payload to telemetry. We only emit kinds for which a "Report"
  // CTA is meaningful (server, parse_error, timeout, network — i.e. failure
  // modes the user might want to report).
  const handleReportError = useCallback(() => {
    if (!onReportError) return;
    if (phase.kind !== 'ready') return;
    if (!lastResult || lastResult.ok) return;
    if (
      lastResult.kind !== 'server' &&
      lastResult.kind !== 'parse_error' &&
      lastResult.kind !== 'timeout' &&
      lastResult.kind !== 'network'
    ) {
      return;
    }
    onReportError({
      kind: lastResult.kind,
      message: lastResult.message,
      photoUri: phase.compressed.uri,
      mode,
    });
  }, [phase, lastResult, onReportError, mode]);

  // "Try a different photo" / "Pick from list" passthroughs. Wrapped in
  // useCallback so the buttons get stable handler references; the parent's
  // callback is the source of truth for navigation.
  const handleRetake = useCallback(() => {
    onRetake?.();
  }, [onRetake]);

  const handlePickFromList = useCallback(() => {
    onPickFromList?.();
  }, [onPickFromList]);

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

  // Reveal fade for the error / queued cards. Same reduce-motion gate as
  // success — init at 1 when reduce-motion is on, otherwise init at 0 and
  // run an Animated.timing on transition. The same `Animated.Value` is shared
  // across every error variant; only one error card is visible at a time so
  // re-using one driver keeps the code simple and avoids per-kind animation
  // bookkeeping.
  const errorOpacity = useRef(new Animated.Value(reduceMotion ? 1 : 0)).current;
  // Latch so the fade only fires the first time we transition into a non-
  // success state per `phase` lifetime. A re-fire of `diagnose()` from "Try
  // again" that resolves to another non-success kind doesn't re-animate; the
  // card is already visible. The latch resets via `phase` change (new photo).
  const errorFadedRef = useRef(false);
  useEffect(() => {
    if (phase.kind === 'compressing') {
      errorFadedRef.current = false;
      return;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase.kind]);

  // The error state fires on (a) compress-failed phase, or (b) a non-ok
  // lastResult after loading completes. Either way, we run the fade once.
  const isErrorVariantVisible =
    phase.kind === 'compress-failed' ||
    (phase.kind === 'ready' &&
      lastResult !== null &&
      !lastResult.ok &&
      status !== 'requesting');

  useEffect(() => {
    if (!isErrorVariantVisible) return;
    if (errorFadedRef.current) return;
    errorFadedRef.current = true;
    if (reduceMotion) {
      errorOpacity.setValue(1);
      return;
    }
    Animated.timing(errorOpacity, {
      toValue: 1,
      duration: 300,
      useNativeDriver: true,
    }).start();
  }, [isErrorVariantVisible, reduceMotion, errorOpacity]);

  // A11y announcement on transition into a non-success state. Defaults to the
  // platform implementation; tests inject a spy via the prop.
  //
  // We chose `announceForAccessibility` over `setAccessibilityFocus` because
  // the latter requires a `findNodeHandle` lookup that is fragile under
  // React strict-mode and adds noise to the test harness. The screen-reader
  // semantic is identical: VoiceOver/TalkBack reads the editorial headline
  // immediately on transition.
  const announceImpl =
    announceForAccessibilityImpl ?? AccessibilityInfo.announceForAccessibility;
  const lastAnnouncedKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const variant = resolveErrorVariant(phase, lastResult);
    if (!variant) {
      lastAnnouncedKeyRef.current = null;
      return;
    }
    if (lastAnnouncedKeyRef.current === variant.kind) return;
    lastAnnouncedKeyRef.current = variant.kind;
    try {
      announceImpl(variant.copy.headline);
    } catch {
      // AccessibilityInfo throws are non-fatal; ignore.
    }
  }, [phase, lastResult, announceImpl]);

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

      {/* E5-009: distinct UI per error kind. resolveErrorVariant() centralizes
          the precedence (compress-failed beats any stale API result). The
          discriminated-union shape stays preserved through the variant copy
          + the testID suffix per kind.

          Codex P2 fix: gate on `isErrorVariantVisible` so a stale error card
          does not co-render with the loading dock during a "Try again" retry.
          When `status === 'requesting'` (re-fire in flight), the loading dock
          is the only visible surface — the previous error result is still on
          the hook, but we don't render it until the retry resolves. */}
      {isErrorVariantVisible && (() => {
        const variant = resolveErrorVariant(phase, lastResult);
        if (!variant) return null;
        return (
          <Animated.View
            style={[styles.errorCard, { opacity: errorOpacity }]}
            // RN's `AccessibilityRole` type omits 'status' (it's a web-platform
            // role that the native bridges don't surface). Master plan locks
            // 'status' for queued (non-disruptive); we cast through
            // `AccessibilityRole` so it round-trips for tests + any consumer
            // reading the prop. On native, TalkBack/VoiceOver ignore unknown
            // roles harmlessly. See ToastBanner for the same pattern.
            accessibilityRole={
              (variant.kind === 'queued' ? 'status' : 'alert') as AccessibilityRole
            }
            accessibilityLabel={variant.copy.headline}
            testID={testID ? `${testID}-error-${variant.kind}` : undefined}
          >
            {variant.kind === 'queued' ? (
              // Queued state uses the ToastBanner pending primitive when E7-005
              // (the primitives barrel ToastBanner) has merged. The brief notes
              // both possibilities; we use the primitive directly because it is
              // already exported from `@/components/primitives` (see E2 ticket
              // E2-007). If a future barrel split renames the primitive, the
              // import location is the single update point — the visual
              // treatment (tan accent, italic copy) is owned by ToastBanner.
              <ToastBanner
                type="pending"
                message={variant.copy.headline}
                autoDismissMs={0}
                testID={testID ? `${testID}-queued-banner` : undefined}
              />
            ) : (
              <Text
                accessibilityRole="header"
                style={[
                  styles.errorHeadline,
                  { color: theme.colors.text, fontFamily: fonts.display.semibold },
                ]}
                testID={testID ? `${testID}-error-headline` : undefined}
              >
                {variant.copy.headline}
              </Text>
            )}

            {variant.kind !== 'queued' && (
              <Text
                style={[
                  styles.errorBody,
                  { color: theme.colors.textMuted, fontFamily: fonts.body.regular },
                ]}
                testID={testID ? `${testID}-error-body` : undefined}
              >
                {variant.copy.body}
              </Text>
            )}

            {/* Per-kind CTA stack. Layer-1-reject + low_confidence + retake-
                centric variants share the "Try a different photo" affordance;
                timeout / network / server / parse_error share the "Try again"
                affordance that re-fires diagnose. */}
            <View style={styles.errorCtaStack}>
              {variant.kind === 'low_confidence' && (
                <>
                  <EditorialButton
                    variant="filled"
                    label="Pick from list"
                    onPress={handlePickFromList}
                    accessibilityLabel="Pick from list"
                    accessibilityHint="Open the manual species picker"
                    testID={testID ? `${testID}-pick-from-list` : undefined}
                  />
                  <View style={styles.ctaSpacer} />
                  <EditorialButton
                    variant="outline"
                    label="Try a different photo"
                    onPress={handleRetake}
                    accessibilityLabel="Try a different photo"
                    testID={testID ? `${testID}-retake` : undefined}
                  />
                </>
              )}

              {(variant.kind === 'timeout' || variant.kind === 'network') && (
                <>
                  <EditorialButton
                    variant="filled"
                    label="Try again"
                    onPress={handleRetry}
                    accessibilityLabel="Try again"
                    accessibilityHint="Re-runs the diagnose request with the same photo"
                    testID={testID ? `${testID}-try-again` : undefined}
                  />
                  {onSavePhotoOnly && (
                    <>
                      <View style={styles.ctaSpacer} />
                      <EditorialButton
                        variant="outline"
                        label="Save photo for now"
                        onPress={handleSavePhotoOnly}
                        accessibilityLabel="Save photo for now"
                        testID={testID ? `${testID}-save-photo-only` : undefined}
                      />
                    </>
                  )}
                </>
              )}

              {variant.kind === 'server' && (
                <>
                  <EditorialButton
                    variant="filled"
                    label="Try again"
                    onPress={handleRetry}
                    accessibilityLabel="Try again"
                    testID={testID ? `${testID}-try-again` : undefined}
                  />
                  {onReportError && (
                    <>
                      <View style={styles.ctaSpacer} />
                      <EditorialButton
                        variant="outline"
                        label="Report"
                        onPress={handleReportError}
                        accessibilityLabel="Report this error"
                        testID={testID ? `${testID}-report` : undefined}
                      />
                    </>
                  )}
                </>
              )}

              {variant.kind === 'parse_error' && (
                <EditorialButton
                  variant="filled"
                  label="Try again"
                  onPress={handleRetry}
                  accessibilityLabel="Try again"
                  testID={testID ? `${testID}-try-again` : undefined}
                />
              )}

              {variant.kind === 'layer1_reject' && (
                <EditorialButton
                  variant="filled"
                  label="Try a different photo"
                  onPress={handleRetake}
                  accessibilityLabel="Try a different photo"
                  testID={testID ? `${testID}-retake` : undefined}
                />
              )}

              {variant.kind === 'compress-failed' && (
                <EditorialButton
                  variant="filled"
                  label="Try a different photo"
                  onPress={handleRetake}
                  accessibilityLabel="Try a different photo"
                  testID={testID ? `${testID}-retake` : undefined}
                />
              )}

              {/* No CTA for queued — the sync layer (E7) drains the queue
                  when connectivity returns. The pending banner reads as a
                  non-disruptive status, not an actionable error. */}
            </View>

            {onClose && variant.kind !== 'queued' && (
              <View style={styles.placeholderCtaSpacer}>
                <EditorialButton
                  variant="outline"
                  label="Close"
                  onPress={onClose}
                  testID={testID ? `${testID}-close` : undefined}
                />
              </View>
            )}
          </Animated.View>
        );
      })()}
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

// Useful in tests to assert the narrative-builder + variant-resolver behavior
// without rendering the screen. Exported for that purpose; not part of the
// public API.
export const __testing = { buildNarrative, resolveErrorVariant };

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
    // E11-003: 32 × 1.40 = 45 → 44 (was 36, ratio 1.125 — Fraunces
    // descenders clipped at 310%).
    lineHeight: 44,
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
  errorCard: {
    paddingTop: 32,
    paddingHorizontal: 24,
  },
  errorHeadline: {
    fontSize: 28,
    // E11-003: 28 × 1.43 = 40 (was 32, ratio 1.14).
    lineHeight: 40,
    marginBottom: 12,
  },
  errorBody: {
    fontSize: 16,
    lineHeight: 24,
    marginBottom: 24,
  },
  errorCtaStack: {
    marginTop: 8,
  },
  placeholderCtaSpacer: {
    marginTop: 16,
  },
});
