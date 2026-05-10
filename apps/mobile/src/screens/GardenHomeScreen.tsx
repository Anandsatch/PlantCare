/**
 * E5-011 — `<GardenHomeScreen>`: the A-1 host that owns the FAB → camera
 * routing.
 *
 * The master plan locks the FAB behavior on the Plants list:
 *   - Tap "+"            → A-5 in `identify` mode (the explicit "add a plant"
 *                          path).
 *   - Long-press "+"     → FAB popover (E3-004) with two items:
 *      - "Add a plant"   → A-5 in `identify` mode (same as the tap default).
 *      - "Quick diagnose"→ A-5 in `diagnose` mode. Master plan line 325:
 *                          "launches A-5 in diagnose mode, then A-3 result,
 *                          but does NOT save the plant or the diagnosis to
 *                          the user's garden."
 *
 * `<PlantsListScreen>` (E3-003 + E3-004) already exposes the callback surface
 * for both gestures; the popover wires itself when `onQuickDiagnose` is
 * provided. This screen owns the *destination* of those callbacks: a small
 * `view` discriminated union switches between the list, `<CameraView>`, and
 * `<CameraResultScreen>`.
 *
 * # The transient-diagnose contract (V1 lock)
 *
 * The Quick Diagnose path is "transient, not saved." We enforce that here, not
 * inside `<CameraResultScreen>` — the result screen is mode-agnostic and
 * forwards its `mode` prop to whatever `onSave` callback the parent provides.
 * In diagnose mode, this screen wires `onSave` to a *dismiss-only* callback
 * that resets `view` back to `{ kind: 'list' }`. No SQLite write, no AddPlant
 * navigation, no parent-prop forwarding. The narrowed `mode === 'diagnose'`
 * branch is the only path that gets this dismiss-only handler; identify mode
 * forwards `onSave` upstream via `onIdentifySave` so a future ticket
 * (E5-010 → AddPlantScreen integration) can route the payload into the actual
 * persistence flow.
 *
 * The same dismiss-only treatment applies to `onSavePhotoOnly` and
 * `onReportError` for diagnose mode — both are wired to the dismiss handler so
 * a user who taps "Save photo for now" on a `timeout` variant from the Quick
 * Diagnose entry point lands back on the Plants list with no persistence side
 * effect. This matches the master-plan rescue-moment contract: "the friend's
 * sick plant" never enters the user's garden.
 *
 * # Cancel paths
 *
 * - Camera close (pre-shutter) from any entry point → `view` resets to list.
 *   No API call, no SQLite write, no compression. The camera view itself
 *   handles the close button; we just reset the view state.
 * - Result screen `onClose` (error variants) → reset to list. Error variants
 *   in `<CameraResultScreen>` render their own Close button when `onClose` is
 *   provided; we always provide it so any non-queued error has a dismiss path.
 * - Result screen `onRetake` (low_confidence, layer1_reject, compress-failed)
 *   → reset to camera in the SAME mode the user originally chose. Re-entering
 *   the camera flow after a retake should not silently flip identify ↔
 *   diagnose; the mode is preserved through the round trip.
 *
 * # Why this screen owns the camera modal, not PlantsListScreen
 *
 * `<PlantsListScreen>` is the data-bearing surface — it owns SQLite reads, the
 * AppState resume listener, and the FAB. Mounting `<CameraView>` inside it
 * would tangle "I show your garden" with "I am the camera host," and a future
 * deep-link route (open Camera directly from a notification) would have to
 * either re-mount the list or hoist the camera state up anyway. We hoist it
 * once, here, and `<PlantsListScreen>` stays a pure list surface with
 * callbacks.
 *
 * # V1 scope locks (do not add)
 * - No new navigation library. The view state is local `useState`. When this
 *   project graduates to expo-router or react-navigation, this screen is the
 *   migration point — but until then, a discriminated union + conditional
 *   render is the smallest correct shape.
 * - No state management library beyond `useState`. The view state is purely
 *   local (it does not survive screen unmount, by design — a navigate-away
 *   should reset to list).
 * - No re-architecting `<PlantsListScreen>`'s mount. The list keeps its own
 *   FAB + popover wiring; this screen passes through the callbacks.
 * - No collapse of the `<CameraView>` mode toggle or the
 *   `<CameraResultScreen>` discriminated union. Both stay distinct end-to-end.
 * - No automatic mode-switching mid-flow. If the user is in identify mode and
 *   uses the camera's mode-toggle pill to flip to diagnose, the captured
 *   payload carries `mode='diagnose'` and the result screen wires the
 *   dismiss-only `onSave`. The `mode` is read from the capture payload at the
 *   moment the user takes a picture, not from the entry-point intent.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { BackHandler } from 'react-native';

import type { ApiClient } from '../api';
import { PlantCareCameraView, type CameraCaptureResult, type CameraMode } from '../components/CameraView';
import type { Plant } from '../db/types';
import type { CompressPhotoInput, CompressPhotoResult } from '../photos';
import {
  CameraResultScreen,
  type CameraResultReportErrorPayload,
  type CameraResultSavePayload,
  type CameraResultSavePhotoOnlyPayload,
} from './CameraResultScreen';
import { PlantsListScreen } from './PlantsListScreen';

/**
 * Discriminated view state. The `result` shape carries everything the result
 * screen needs to mount: the captured photo URI, the mode it was captured in,
 * and the entry-point mode (so retake routes back to the camera in the same
 * mode the user originally chose, even if they flipped the in-camera mode
 * pill before pressing the shutter).
 *
 * Why entry-mode AND capture-mode are both tracked: the in-camera mode pill
 * is a real affordance (E5-004 ships it). A user who long-pressed the FAB
 * for Quick Diagnose can tap the pill to switch to identify before the
 * shutter; the captured payload's `mode` is the source of truth for the
 * result screen's behavior. But on retake, we want the camera to re-mount in
 * the entry mode (the user's original intent), not the post-flip mode — that
 * way "Try a different photo" doesn't silently change which path the user
 * thought they were on.
 */
export type GardenHomeView =
  | { kind: 'list' }
  | { kind: 'camera'; entryMode: CameraMode }
  | {
      kind: 'result';
      entryMode: CameraMode;
      captureMode: CameraMode;
      photoUri: string;
    };

export type GardenHomeScreenProps = {
  /** API client for `<CameraResultScreen>`'s `useDiagnoseRequest`. */
  apiClient: ApiClient;
  /** Tap a plant row in the list → caller routes to A-2 detail. */
  onPlantPress: (plant: Plant) => void;
  /**
   * Identify-mode save passthrough. When the user captures in identify mode
   * and taps "Save to my plants" on the success card, we forward the payload
   * here. Future E5-010 integration wires this into `<AddPlantScreen>` and
   * the SQLite `plants` insert. When omitted, the success-card save in
   * identify mode is a no-op dismiss (defensive — same shape as Quick
   * Diagnose) so a misconfigured caller can't accidentally persist a plant
   * without an explicit handler.
   */
  onIdentifySave?: (payload: CameraResultSavePayload) => void;
  /**
   * Identify-mode save-photo-only passthrough (E5-009 timeout / network
   * variants). Forwarded for identify-mode captures only; diagnose-mode
   * save-photo-only is intentionally dismiss-only per the transient
   * contract.
   */
  onIdentifySavePhotoOnly?: (payload: CameraResultSavePhotoOnlyPayload) => void;
  /**
   * Identify-mode report-error passthrough. Same scoping rules as save-photo-
   * only: forwarded for identify-mode captures only; diagnose mode swallows
   * the report tap into a dismiss.
   */
  onIdentifyReportError?: (payload: CameraResultReportErrorPayload) => void;
  /**
   * Optional analytics observer for the FAB long-press gesture itself.
   * Forwarded straight to `<PlantsListScreen>`. Fires alongside the popover
   * open per the E3-004 contract.
   */
  onLongPressFAB?: () => void;
  /** Test seam — deterministic `now` for the list's relative-date copy. */
  nowMs?: number;
  /**
   * Test seam — passthrough for `<CameraResultScreen>`'s `compressPhotoImpl`
   * prop so tests can drive the result lifecycle without spinning up
   * `expo-image-manipulator`. Production callers omit this and the result
   * screen falls through to the real `compressPhoto`.
   */
  compressPhotoImpl?: (input: CompressPhotoInput) => Promise<CompressPhotoResult>;
  /**
   * Deep-link readiness — optional initial view-state. When omitted (the
   * normal mount path) the screen starts at `'list'`. When `'camera'` is
   * passed, the camera mounts directly using `initialMode` (defaults to
   * `'identify'`). Future ticket: a notification-tap deep-link route opens
   * Camera in diagnose mode by passing `initialView='camera'` +
   * `initialMode='diagnose'`. Tests that mount the screen without props
   * remain unaffected — both fields are pure additions.
   *
   * `'result'` is intentionally NOT a valid initial view: a deep-link can't
   * hydrate a captured `photoUri` from a cold start, so result-state can
   * only be reached through the in-app capture flow.
   */
  initialView?: 'list' | 'camera';
  /**
   * Initial camera mode when `initialView === 'camera'`. Ignored when
   * `initialView` is `'list'` or omitted. Defaults to `'identify'` to match
   * the FAB-tap entry point.
   */
  initialMode?: CameraMode;
  testID?: string;
};

export function GardenHomeScreen({
  apiClient,
  onPlantPress,
  onIdentifySave,
  onIdentifySavePhotoOnly,
  onIdentifyReportError,
  onLongPressFAB,
  nowMs,
  compressPhotoImpl,
  initialView,
  initialMode,
  testID,
}: GardenHomeScreenProps) {
  // Initial view derives from the deep-link prop pair (or defaults to list).
  // We compute it lazily inside `useState`'s initializer so the cold-start
  // value is the props value at first commit; subsequent changes to
  // `initialView` are intentionally ignored — the screen owns its own view
  // state once mounted, and a parent that re-renders with a different
  // initialView shouldn't yank the user out of an in-flight capture flow.
  const [view, setView] = useState<GardenHomeView>(() => {
    if (initialView === 'camera') {
      return { kind: 'camera', entryMode: initialMode ?? 'identify' };
    }
    return { kind: 'list' };
  });
  // Mirror of `view` for callbacks that need to read entryMode without
  // re-creating themselves on every state change. Updated after commit (not
  // during render) so it always reflects the just-rendered state.
  const viewRef = useRef<GardenHomeView>(view);
  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  // Reset to list — the canonical "user dismissed the camera flow" handler.
  // Pulled out so every dismiss path (camera close, result close, dismiss-
  // after-save) routes through the same state transition.
  const dismissToList = useCallback(() => {
    setView({ kind: 'list' });
  }, []);

  // ── List-screen entry points ──────────────────────────────────────────

  // The camera view is a controlled component re: the mode-toggle pill —
  // the parent owns `mode` and reacts to `onModeChange`. We seed it from
  // the entry-mode when transitioning into the camera and keep it in sync
  // with the in-camera pill while the camera is mounted. The result screen
  // reads its `mode` prop from THIS state at the moment of capture, not
  // from the entry-mode, so a user who flips the pill mid-flow gets the
  // captured-mode behavior they chose.
  const [cameraMode, setCameraMode] = useState<CameraMode>(() =>
    initialView === 'camera' ? initialMode ?? 'identify' : 'identify',
  );

  // Tap "+" on the list → identify mode (also wired as the popover's "Add a
  // plant" item per the E3-004 contract — the popover invokes `onAddPlant`
  // which is this same callback). Seeds the camera mode together with the
  // view transition so `<CameraView>` mounts already in the right mode (no
  // post-mount mode-correction flicker).
  //
  // Codex P2 fix: when the gesture is the FAB long-press → popover → item
  // tap, the popover's RN `Modal` is still in the React tree at the moment
  // this callback fires (FABPopover invokes the item handler before
  // `onDismiss`). If we synchronously swap the parent view to the camera,
  // RN's `Modal` teardown races the camera mount and Android's hardware-
  // back routes through the popover's `onRequestClose` instead of the
  // camera's `BackHandler`. Defer the view transition to the next microtask
  // (Promise.resolve().then) so the popover's `setOpen(false)` from
  // `onDismiss` flushes first; the camera mounts after the popover Modal
  // has unmounted. The FAB-tap path also deferr to keep the two entry
  // points symmetrical (timing parity is cheaper than two-path debugging).
  const transitionToCamera = useCallback((entryMode: CameraMode) => {
    Promise.resolve().then(() => {
      setCameraMode(entryMode);
      setView({ kind: 'camera', entryMode });
    });
  }, []);

  const handleAddPlant = useCallback(() => {
    transitionToCamera('identify');
  }, [transitionToCamera]);

  // Long-press "+" → popover "Quick diagnose" item → diagnose mode. The
  // popover only mounts when `onQuickDiagnose` is provided (E3-004 gating);
  // we always provide it because the diagnose entry point is the whole point
  // of this screen.
  const handleQuickDiagnose = useCallback(() => {
    transitionToCamera('diagnose');
  }, [transitionToCamera]);

  // ── Camera screen handlers ────────────────────────────────────────────

  const handleCapture = useCallback(
    (result: CameraCaptureResult) => {
      // The view at the moment of capture is the source of truth for entry-
      // mode; we narrow on the discriminator instead of trusting a stale ref.
      // If the view isn't 'camera' (impossible under normal flow but possible
      // in StrictMode replay or a navigation race), drop the capture rather
      // than mount a result screen against a list view.
      setView((current) => {
        if (current.kind !== 'camera') return current;
        return {
          kind: 'result',
          entryMode: current.entryMode,
          captureMode: cameraMode,
          photoUri: result.uri,
        };
      });
    },
    [cameraMode],
  );

  // ── Result screen handlers ────────────────────────────────────────────
  //
  // ALL persistence/telemetry forwarding gates on `entryMode`, NOT on the
  // capture-time `payload.mode`. Why: the master plan's transient-diagnose
  // contract is entry-point scoped — a user who long-presses the FAB and
  // chooses "Quick diagnose" is committing to "this plant is not mine."
  // The in-camera mode-toggle pill is a *correction* affordance ("oops I
  // wanted to identify"), not a persistence-mode switch. Routing on
  // payload.mode would let a Quick-Diagnose entry point reach
  // `onIdentifySave` after a mid-flow flip — which is exactly the contract
  // the brief explicitly forbids ("Quick Diagnose path should NOT route
  // through AddPlantScreen"). Codex P1 caught this in the first adversarial
  // review pass; the fix is to gate every parent-prop forward on
  // `viewRef.current.entryMode === 'identify'`. The mode-toggle pill still
  // works as a UI affordance — it changes which `/api/diagnose` payload
  // gets sent (identify vs diagnose backend route via `<CameraView>`'s
  // mode prop) and threads through to the result screen's `mode` for
  // copy/CTA labeling — but it CANNOT promote a transient capture into a
  // garden-saving capture.

  /**
   * True iff this flow was started via the explicit identify entry point
   * (FAB tap or popover "Add a plant"). Reads from the viewRef so the
   * callbacks don't need to re-create themselves when `view` changes; the
   * ref is updated after commit, so it always sees the just-rendered view.
   */
  const isIdentifyEntry = useCallback((): boolean => {
    const current = viewRef.current;
    if (current.kind === 'result') return current.entryMode === 'identify';
    if (current.kind === 'camera') return current.entryMode === 'identify';
    // 'list' is unreachable for result-screen callbacks, but guard the
    // narrowing exhaustively rather than asserting.
    return false;
  }, []);

  const handleResultSave = useCallback(
    (payload: CameraResultSavePayload) => {
      if (isIdentifyEntry()) {
        onIdentifySave?.(payload);
        // Defensive dismiss: even when the parent handles save, we reset the
        // view here so a parent that re-mounts us with the same prop set
        // doesn't see a stale result. The parent (e.g. a future
        // AddPlantScreen) is expected to handle its own navigation; this
        // screen leaves the modal-stack idle.
        dismissToList();
        return;
      }
      // Quick-Diagnose entry: dismiss with no side effect. Transient contract.
      dismissToList();
    },
    [isIdentifyEntry, onIdentifySave, dismissToList],
  );

  // "Save photo for now" — same entry-mode gating as save.
  const handleResultSavePhotoOnly = useCallback(
    (payload: CameraResultSavePhotoOnlyPayload) => {
      if (isIdentifyEntry()) {
        onIdentifySavePhotoOnly?.(payload);
        dismissToList();
        return;
      }
      // Quick-Diagnose entry: dismiss only — no photo persistence on the
      // rescue path.
      dismissToList();
    },
    [isIdentifyEntry, onIdentifySavePhotoOnly, dismissToList],
  );

  // "Report" — same entry-mode gating. Quick-Diagnose entry reports are
  // swallowed; the rescue moment isn't expected to feed telemetry per V1.
  const handleResultReportError = useCallback(
    (payload: CameraResultReportErrorPayload) => {
      if (isIdentifyEntry()) {
        onIdentifyReportError?.(payload);
        dismissToList();
        return;
      }
      dismissToList();
    },
    [isIdentifyEntry, onIdentifyReportError, dismissToList],
  );

  // "Try a different photo" — re-mount the camera in the ORIGINAL entry mode
  // (not the captured mode). User intent is "try again with my original
  // path"; flipping mid-retake would surprise.
  const handleResultRetake = useCallback(() => {
    setView((current) => {
      if (current.kind !== 'result') return current;
      // Reset cameraMode to entryMode for the same reason we set it on the
      // initial transition: the camera should mount in the user's original
      // intent, not the post-flip mode they captured with.
      setCameraMode(current.entryMode);
      return { kind: 'camera', entryMode: current.entryMode };
    });
  }, []);

  // ── Android hardware back: result view-state ──────────────────────────
  //
  // `<PlantCareCameraView>` already registers its own `hardwareBackPress`
  // listener (E5-004) and routes to `onCancel` (which is our `dismissToList`).
  // `<PlantsListScreen>` is the app root — Android's default back behavior
  // there is "exit the app," and we don't override it. `<CameraResultScreen>`
  // does NOT own a back handler, so the result view-state's hardware-back is
  // ours to define here, per the master-plan rescue-path semantics:
  //
  //   - result + entryMode='diagnose' → dismiss to list, discard the result.
  //     The transient contract: a Quick Diagnose flow ending at "back" lands
  //     on the garden, not the camera, because re-entering the rescue camera
  //     after seeing a result is a new gesture (long-press + popover).
  //   - result + entryMode='identify' → re-enter camera in entry-mode. Mirrors
  //     "Try a different photo" semantics so back-from-result on the
  //     identify path doesn't strand a user who just wants to retake.
  //
  // BackHandler returns `true` from the listener to signal "we handled it,
  // don't propagate." When the view isn't `'result'`, we return `false` so
  // the camera's own listener (or the OS default) sees it.
  useEffect(() => {
    const onBack = (): boolean => {
      const current = viewRef.current;
      if (current.kind !== 'result') return false;
      if (current.entryMode === 'identify') {
        // Discard the diagnose result, re-mount camera in entry-mode.
        setCameraMode(current.entryMode);
        setView({ kind: 'camera', entryMode: current.entryMode });
        return true;
      }
      // Diagnose entry: dismiss to list, transient contract.
      dismissToList();
      return true;
    };
    const sub = BackHandler.addEventListener('hardwareBackPress', onBack);
    return () => sub.remove();
  }, [dismissToList]);

  // "Pick from list" on `low_confidence`. V1 routes to dismiss; future
  // E5-010 wiring will lift this to the species-picker entry point. We don't
  // distinguish identify vs diagnose here because the manual species picker
  // is identify-only by definition (diagnose doesn't have alternatives), so
  // the diagnose-side caller would never see this path in practice.
  const handlePickFromList = useCallback(() => {
    dismissToList();
  }, [dismissToList]);

  // ── Render ────────────────────────────────────────────────────────────
  //
  // Switch on the discriminator and let TypeScript exhaustiveness-check the
  // `default` branch. Codex P3 fix: a future view-state addition (e.g. an
  // 'add-plant-form' state when E5-010 wires AddPlantScreen as an in-flow
  // step) will trip the `never` assignment at compile-time, forcing the
  // author to handle the new state explicitly.
  switch (view.kind) {
    case 'list':
      return (
        <PlantsListScreen
          onAddPlant={handleAddPlant}
          onQuickDiagnose={handleQuickDiagnose}
          onLongPressFAB={onLongPressFAB}
          onPlantPress={onPlantPress}
          nowMs={nowMs}
          testID={testID ?? 'garden-home-list'}
        />
      );
    case 'camera':
      return (
        <PlantCareCameraView
          mode={cameraMode}
          onModeChange={setCameraMode}
          onCapture={handleCapture}
          onCancel={dismissToList}
          testID={testID ? `${testID}-camera` : 'garden-home-camera'}
        />
      );
    case 'result':
      return (
        <CameraResultScreen
          apiClient={apiClient}
          photoUri={view.photoUri}
          mode={view.captureMode}
          onSave={handleResultSave}
          onSavePhotoOnly={handleResultSavePhotoOnly}
          onReportError={handleResultReportError}
          onRetake={handleResultRetake}
          onPickFromList={handlePickFromList}
          onClose={dismissToList}
          compressPhotoImpl={compressPhotoImpl}
          testID={testID ? `${testID}-result` : 'garden-home-result'}
        />
      );
    default: {
      const _exhaustive: never = view;
      void _exhaustive;
      return null;
    }
  }
}
