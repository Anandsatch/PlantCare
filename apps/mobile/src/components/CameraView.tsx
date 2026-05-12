import { fonts } from '@plantcare/theme';
import {
  CameraView as ExpoCameraView,
  useCameraPermissions,
} from 'expo-camera';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  AccessibilityInfo,
  Animated,
  AppState,
  BackHandler,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { useTheme } from '../hooks/useTheme';

import { CameraPermissionPrePrompt } from './CameraPermissionPrePrompt';

// E5-004 — `<CameraView>` wrapper that fronts `expo-camera` with permission
// gating, a top mode-toggle pill (identify/diagnose), and a bottom shutter
// button. The master plan locks the contract:
//   `<CameraView mode='identify' | 'diagnose' onCapture />` — `expo-camera`
//   wrapper, mode toggle pill, shutter (master plan §"Component vocabulary").
// The mode prop discriminates downstream behavior: identify routes the photo
// to `/api/identify` (E5-008 → E5-010 add-plant flow); diagnose routes to
// `/api/diagnose` (E5-008 result screen). The mode toggle lives here rather
// than on the result screen because users need to flip between Quick diagnose
// and Identify before pressing the shutter.
//
// Naming note (file vs export): `expo-camera` exports a class component named
// `CameraView` from its modern API (verified in
// node_modules/expo-camera/build/index.d.ts: `export { default as CameraView }
// from './CameraView'`). To avoid the import collision while keeping the file
// name symmetric with the master-plan spec, this file imports the upstream
// component aliased to `ExpoCameraView` and exports our wrapper as
// `PlantCareCameraView`. Consumers should `import { PlantCareCameraView }
// from '../components'`.
//
// Permission gating: composes `<CameraPermissionPrePrompt>` from E5-003. While
// `useCameraPermissions()` returns `null` (first render), this wrapper renders
// a single blank surface frame so we don't flash the cream pre-prompt for an
// already-granted user. Once the snapshot resolves to undetermined, the
// pre-prompt takes over and fires `onGranted` which transitions us into the
// camera UI. Denied (canAskAgain=false) is handled by the pre-prompt's own
// denied state — we never re-render the camera after a permanent denial.
//
// Shutter debounce: a tap captures a photo via `takePictureAsync`. Multiple
// taps in flight would either queue picture jobs (Android) or throw "preview
// paused" mid-capture (iOS). An `inFlightRef` short-circuits subsequent taps
// until the first resolves or rejects.
//
// Reduce-motion: the shutter does a small press-feedback scale animation that
// becomes a no-op when AccessibilityInfo reports reduce-motion enabled. The
// hook is inlined here because E2-004 hasn't merged in this stacked base; the
// implementation matches the pattern from `CameraPermissionPrePrompt` (effect
// + listener cleanup).
//
// Camera facing: defaults to 'back' (rear camera) per the master plan — plant
// photos are taken with the rear camera. No UI to flip in V1.

export type CameraMode = 'identify' | 'diagnose';

export type CameraCaptureResult = {
  /** Local file URI of the captured image (e.g. `file:///.../cache/.../photo.jpg`). */
  uri: string;
  /** Pixel width of the captured image after expo-camera processing. */
  width: number;
  /** Pixel height of the captured image after expo-camera processing. */
  height: number;
};

export type PlantCareCameraViewProps = {
  /** Active capture mode. Drives the post-capture endpoint at the parent screen. */
  mode: CameraMode;
  /** Fires when the user taps a different mode segment. Parent owns the state. */
  onModeChange?: (mode: CameraMode) => void;
  /** Fires once the captured photo has resolved. Compression + upload happen in E5-005 / parent screen. */
  onCapture: (result: CameraCaptureResult) => void;
  /** Fires when the user dismisses the camera (close button, denied permission cancel). */
  onCancel: () => void;
  /** Optional testID forwarded to the root View for E2E selectors. */
  testID?: string;
};

export function PlantCareCameraView({
  mode,
  onModeChange,
  onCapture,
  onCancel,
  testID,
}: PlantCareCameraViewProps): React.ReactElement | null {
  const theme = useTheme();
  const [permission, , getPermission] = useCameraPermissions();
  // Mirror permission status into local state so the camera UI mounts only
  // after the pre-prompt fires onGranted. Otherwise the pre-prompt and the
  // camera UI race for the same render frame.
  const [permissionGranted, setPermissionGranted] = useState<boolean>(
    () => permission?.granted === true,
  );

  // Sync to the upstream snapshot: if the user grants permission outside this
  // component (e.g. system settings change while the screen is open) the
  // CameraView reflects it immediately. We only flip true → never back to
  // false, because the pre-prompt's denied state owns the revocation path.
  useEffect(() => {
    if (permission?.granted === true && !permissionGranted) {
      setPermissionGranted(true);
    }
  }, [permission, permissionGranted]);

  // Codex P2 (E5-004 adversarial review): re-query permission status when the
  // app returns to the foreground. Without this, a user who left the app to
  // grant camera access in Settings sees a stale `permission?.granted=false`
  // snapshot from `useCameraPermissions()` and stays stranded on the denied
  // pre-prompt. Calling `getPermission()` (the get-only fn from the hook
  // tuple) refreshes the snapshot and triggers a re-render with the new
  // value. We never call this on `requestPermission` to avoid burning the
  // canAskAgain budget.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') {
        // Fire-and-forget; the hook re-renders us with the fresh snapshot.
        void getPermission?.().catch(() => {
          // OS hiccup; the next focus event will retry.
        });
      }
    });
    return () => sub.remove();
  }, [getPermission]);

  // Codex P2 (E5-004 adversarial review): on Android, the hardware back
  // button / system back gesture should map to `onCancel` so a parent that
  // depends on the cancel callback for cleanup or analytics doesn't get
  // bypassed. iOS has no equivalent (no system back at the OS level), so this
  // listener is Android-only. We register only when permission is granted —
  // before that, the pre-prompt owns its own dismissal flow via "Not now".
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    if (!permissionGranted) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onCancel();
      return true; // tells RN we handled the back press
    });
    return () => sub.remove();
  }, [permissionGranted, onCancel]);

  // Reduce-motion observer (inlined; E2-004 will replace this with a hook).
  const [reduceMotion, setReduceMotion] = useState<boolean>(false);
  useEffect(() => {
    let cancelled = false;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((enabled) => {
        if (!cancelled) setReduceMotion(enabled);
      })
      .catch(() => {
        // Defaults to false; not worth surfacing.
      });
    const sub = AccessibilityInfo.addEventListener(
      'reduceMotionChanged',
      (enabled) => setReduceMotion(enabled),
    );
    return () => {
      cancelled = true;
      sub.remove();
    };
  }, []);

  const cameraRef = useRef<ExpoCameraView>(null);
  // Guard against double-tap → double `takePictureAsync`. Refs (not state) so
  // the synchronous tap handler observes the current value without waiting on
  // a re-render.
  const inFlightRef = useRef<boolean>(false);

  // Press-feedback scale for the shutter. Animated.Value lives outside the
  // render path so each press doesn't allocate a new node.
  const shutterScale = useRef(new Animated.Value(1)).current;

  const handleShutterPressIn = useCallback(() => {
    if (reduceMotion) return;
    Animated.spring(shutterScale, {
      toValue: 0.92,
      useNativeDriver: true,
      speed: 30,
      bounciness: 0,
    }).start();
  }, [reduceMotion, shutterScale]);

  const handleShutterPressOut = useCallback(() => {
    if (reduceMotion) return;
    Animated.spring(shutterScale, {
      toValue: 1,
      useNativeDriver: true,
      speed: 30,
      bounciness: 6,
    }).start();
  }, [reduceMotion, shutterScale]);

  const handleShutterPress = useCallback(async () => {
    // Camera ref hasn't attached yet (super-fast tap on first mount) → bail
    // silently. The user's next tap, after the ref attaches, captures the
    // photo. Logged at warn so we notice if it shows up in production.
    const camera = cameraRef.current;
    if (camera == null) {
      console.warn('[CameraView] shutter tapped before ref attached');
      return;
    }
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      const picture = await camera.takePictureAsync({
        quality: 0.85,
        skipProcessing: false,
      });
      // takePictureAsync's callback overload can resolve to undefined on the
      // pictureRef path; we never request that path so this branch should be
      // unreachable, but the type union forces a guard.
      if (picture != null && typeof picture.uri === 'string') {
        onCapture({
          uri: picture.uri,
          width: picture.width,
          height: picture.height,
        });
      }
    } catch (err) {
      // Swallow but log — the parent screen has no recovery path beyond "try
      // again" and we don't want a thrown rejection to bubble through the
      // press handler. Master plan reliability bar: log so dogfooders see it.
      console.warn('[CameraView] takePictureAsync failed', err);
    } finally {
      inFlightRef.current = false;
    }
  }, [onCapture]);

  const handleGranted = useCallback(() => {
    setPermissionGranted(true);
  }, []);

  const segments = useMemo(
    () =>
      [
        { key: 'identify' as const, label: 'IDENTIFY' },
        { key: 'diagnose' as const, label: 'DIAGNOSE' },
      ],
    [],
  );

  // 'resolving' window: render a single blank surface frame instead of the
  // pre-prompt so already-granted users don't briefly see the cream card on
  // mount. This mirrors the codex P2 fix from E5-003.
  if (permission == null) {
    return (
      <View
        testID={testID}
        style={[styles.root, { backgroundColor: theme.colors.bg }]}
      />
    );
  }

  if (!permissionGranted) {
    return (
      <View
        testID={testID}
        style={[styles.permissionRoot, { backgroundColor: theme.colors.bg }]}
      >
        <CameraPermissionPrePrompt
          onGranted={handleGranted}
          onCancel={onCancel}
        />
      </View>
    );
  }

  return (
    <View testID={testID} style={[styles.root, { backgroundColor: '#000' }]}>
      <ExpoCameraView
        ref={cameraRef}
        style={StyleSheet.absoluteFill}
        facing="back"
      />

      {/* Top-left close button. Effective hit area 44×44 via hitSlop. */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Close camera"
        hitSlop={12}
        onPress={onCancel}
        style={[
          styles.closeButton,
          { backgroundColor: theme.colors.surface, borderColor: theme.colors.stroke },
        ]}
        testID="camera-close-button"
      >
        {/* E11-003: allowFontScaling={false} — the "×" is a chrome glyph in
            a 36×36 circular button. Scaling it with Dynamic Type at 310%
            would overflow the button's fixed-size frame (the borderRadius
            depends on the fixed dimensions). a11yLabel on the parent
            Pressable carries the semantics for screen readers. */}
        <Text allowFontScaling={false} style={[styles.closeGlyph, { color: theme.colors.text }]}>
          ×
        </Text>
      </Pressable>

      {/* Mode toggle pill (centered). Two segments — active gets a tinted
          accent, inactive sits on the surface fill. */}
      <View
        accessibilityRole="tablist"
        style={[
          styles.toggle,
          { backgroundColor: theme.colors.surface, borderColor: theme.colors.stroke },
        ]}
        testID="camera-mode-toggle"
      >
        {segments.map((segment) => {
          const active = segment.key === mode;
          return (
            <Pressable
              key={segment.key}
              accessibilityRole="button"
              accessibilityLabel={`${segment.label} mode`}
              accessibilityState={{ selected: active }}
              hitSlop={12}
              onPress={() => onModeChange?.(segment.key)}
              style={[
                styles.toggleSegment,
                active && {
                  backgroundColor: theme.colors.text,
                },
              ]}
              testID={`camera-mode-segment-${segment.key}`}
            >
              <Text
                style={[
                  styles.toggleLabel,
                  {
                    color: active ? theme.colors.surface : theme.colors.text,
                  },
                ]}
              >
                {segment.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {/* Bottom-center shutter. Outer ring + inner solid in `surface` so the
          shutter is legible against any preview content. */}
      <View pointerEvents="box-none" style={styles.shutterDock}>
        <Animated.View style={{ transform: [{ scale: shutterScale }] }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Capture photo"
            hitSlop={12}
            onPress={handleShutterPress}
            onPressIn={handleShutterPressIn}
            onPressOut={handleShutterPressOut}
            style={[
              styles.shutterOuter,
              { borderColor: theme.colors.surface },
            ]}
            testID="camera-shutter"
          >
            <View
              style={[
                styles.shutterInner,
                { backgroundColor: theme.colors.surface },
              ]}
            />
          </Pressable>
        </Animated.View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    position: 'relative',
  },
  permissionRoot: {
    flex: 1,
    paddingHorizontal: 24,
    justifyContent: 'center',
  },
  closeButton: {
    position: 'absolute',
    top: 16,
    left: 16,
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeGlyph: {
    fontFamily: fonts.body.medium,
    fontSize: 22,
    lineHeight: 24,
    // Optical centering: the multiplication sign sits slightly above the
    // baseline; nudge it down so the glyph reads centered in the circle.
    marginTop: -2,
  },
  toggle: {
    position: 'absolute',
    bottom: 132,
    alignSelf: 'center',
    flexDirection: 'row',
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 4,
    gap: 4,
  },
  toggleSegment: {
    paddingHorizontal: 18,
    paddingVertical: 8,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 96,
    minHeight: 36,
  },
  toggleLabel: {
    fontFamily: fonts.body.semibold,
    fontSize: 12,
    letterSpacing: 1.2,
  },
  shutterDock: {
    position: 'absolute',
    bottom: 32,
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  shutterOuter: {
    width: 80,
    height: 80,
    borderRadius: 40,
    borderWidth: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  shutterInner: {
    width: 64,
    height: 64,
    borderRadius: 32,
  },
});
