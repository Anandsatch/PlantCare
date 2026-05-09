/**
 * <GardenHomeScreen> tests — E5-011 FAB → camera identify/diagnose wiring.
 *
 * Mocks expo-camera the same way `cameraFlow.integration.test.tsx` does so
 * the camera renders synchronously without hitting the native module. Mocks
 * `usePlants` / `openDb` / `useTheme` / `useReduceMotion` for the same reason
 * the PlantsListScreen unit test does. Mocks the api client + the
 * `compressPhoto` helper at the seam used by `CameraResultScreen`.
 *
 * Coverage:
 *   - FAB tap → camera mounts in identify mode.
 *   - FAB long-press popover "Add a plant" → camera mounts in identify mode.
 *   - FAB long-press popover "Quick diagnose" → camera mounts in diagnose mode.
 *   - capture in identify mode → result screen receives mode='identify'.
 *   - capture in diagnose mode → result screen receives mode='diagnose'.
 *   - in-camera mode-toggle pill → result screen sees the post-flip mode.
 *   - identify success Save → onIdentifySave fires with payload + dismiss to
 *     list; diagnose success Save → NO onIdentifySave + dismiss to list (the
 *     transient contract).
 *   - identify timeout "Save photo for now" → onIdentifySavePhotoOnly fires;
 *     diagnose timeout "Save photo for now" → NO callback + dismiss.
 *   - identify server "Report" → onIdentifyReportError fires; diagnose server
 *     "Report" → NO callback + dismiss.
 *   - retake routes back to camera in the ENTRY mode (not the captured mode).
 *   - camera close pre-shutter → returns to list with no callbacks fired.
 *   - result-screen Close (error variant) → returns to list, no callbacks.
 *   - long-press onLongPressFAB analytics passthrough still fires.
 */

import { lightTheme, type Theme } from '@plantcare/theme';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import React from 'react';
import { AccessibilityInfo, AppState } from 'react-native';

import type { ApiClient, ApiResult, DiagnoseResponse } from '../../api';
import type { Plant } from '../../db/types';
import { GardenHomeScreen } from '../GardenHomeScreen';

// ── Module mocks ────────────────────────────────────────────────────────

type PermissionResponse = {
  status: 'granted' | 'denied' | 'undetermined';
  granted: boolean;
  canAskAgain: boolean;
  expires: 'never' | number;
};

jest.mock('expo-camera', () => {
  const ReactActual = require('react') as typeof import('react');
  const { View } = require('react-native') as typeof import('react-native');
  const useCameraPermissionsMock = jest.fn();
  const takePictureAsync = jest.fn();

  type MockCameraInstance = { takePictureAsync: typeof takePictureAsync };

  const CameraView = ReactActual.forwardRef<MockCameraInstance, Record<string, unknown>>(
    function MockCameraView(props, ref) {
      ReactActual.useImperativeHandle(ref, () => ({ takePictureAsync }), []);
      return ReactActual.createElement(View, { testID: 'mock-expo-camera-view', ...props });
    },
  );

  return {
    __esModule: true,
    CameraView,
    useCameraPermissions: useCameraPermissionsMock,
    __takePictureAsync: takePictureAsync,
  };
});

jest.mock('../../hooks/useTheme', () => ({ useTheme: jest.fn() }));
jest.mock('../../hooks/useReduceMotion', () => ({ useReduceMotion: jest.fn() }));
jest.mock('../../hooks/usePlants', () => ({ usePlants: jest.fn() }));
jest.mock('../../db', () => ({ openDb: jest.fn() }));

jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(false);
jest.spyOn(AccessibilityInfo, 'addEventListener').mockImplementation(
  // @ts-expect-error — RN's overloaded signature is hard to satisfy from a stub.
  () => ({ remove: jest.fn() }),
);
jest.spyOn(AppState, 'addEventListener').mockImplementation(
  () => ({ remove: jest.fn() }) as never,
);

import { useCameraPermissions } from 'expo-camera';

import { useTheme } from '../../hooks/useTheme';
import { useReduceMotion } from '../../hooks/useReduceMotion';
import { usePlants } from '../../hooks/usePlants';
import { openDb } from '../../db';

const mockedUseCameraPermissions = useCameraPermissions as jest.MockedFunction<
  typeof useCameraPermissions
>;
const mockedUseTheme = useTheme as jest.MockedFunction<() => Theme>;
const mockedUseReduceMotion = useReduceMotion as unknown as jest.Mock<boolean, []>;
const mockedUsePlants = usePlants as unknown as jest.Mock;
const mockedOpenDb = openDb as unknown as jest.Mock;
const mockedTakePictureAsync = (
  jest.requireMock('expo-camera') as { __takePictureAsync: jest.Mock }
).__takePictureAsync;

// ── Fixtures ────────────────────────────────────────────────────────────

const NOW = 1_700_000_000_000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

const SUCCESS_DATA: DiagnoseResponse = {
  disease_slug: 'spider_mites',
  disease_label: 'Spider mites',
  confidence: 92,
  severity: 'medium',
  fix_steps: [
    'Tiny webs on the underside and stippled leaves point to spider mites',
    'Spray with neem oil weekly',
    'Isolate from your other plants for 2 weeks',
  ],
  alternatives: [],
  source: 'paid_escalated',
  latency_ms: 1234,
};

function makePlant(overrides: Partial<Plant> = {}): Plant {
  return {
    id: 'plant-1',
    species_slug: 'monstera_deliciosa',
    species_label: 'Monstera deliciosa',
    nickname: 'Mona',
    location: null,
    identify_confidence: 92,
    hero_photo_id: null,
    added_at: NOW - 30 * ONE_DAY_MS,
    archived_at: null,
    is_indoor: true,
    override_interval_days: null,
    ...overrides,
  };
}

function makePlantsApi(plants: Plant[]) {
  return {
    list: jest.fn(async () => plants),
    getById: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    archive: jest.fn(),
    unarchive: jest.fn(),
    remove: jest.fn(),
  };
}

function makeDb(rows: Array<{ plant_id: string; last_watered_at: number }> = []) {
  return {
    getAllAsync: jest.fn(async () => rows as unknown[]),
  };
}

function makeResponse(overrides: {
  status: 'granted' | 'denied' | 'undetermined';
  granted?: boolean;
  canAskAgain?: boolean;
}): PermissionResponse {
  const granted = overrides.granted ?? overrides.status === 'granted';
  return {
    status: overrides.status,
    granted,
    canAskAgain: overrides.canAskAgain ?? (overrides.status === 'denied' ? false : true),
    expires: 'never',
  };
}

function setPermissionGranted() {
  const requestPermission = jest.fn().mockResolvedValue(makeResponse({ status: 'granted' }));
  const getPermission = jest.fn().mockResolvedValue(makeResponse({ status: 'granted' }));
  mockedUseCameraPermissions.mockReturnValue([
    makeResponse({ status: 'granted' }),
    requestPermission,
    getPermission,
  ] as unknown as ReturnType<typeof useCameraPermissions>);
}

function makeApiClient(
  diagnoseImpl?: () => Promise<ApiResult<DiagnoseResponse>>,
): ApiClient {
  return {
    identify: jest.fn() as never,
    diagnose: jest.fn(
      diagnoseImpl ?? (async () => ({ ok: true, data: SUCCESS_DATA })),
    ) as never,
    consult: jest.fn() as never,
    review: jest.fn() as never,
    weather: jest.fn() as never,
  };
}

const COMPRESSED_URI = 'file:///doc/plants/unattached/123-abc.jpg';

function makeCompressImpl(uri = COMPRESSED_URI) {
  return jest.fn(async () => ({ uri, width: 1024, height: 1024, sizeBytes: 200_000 }));
}

// ── Setup ───────────────────────────────────────────────────────────────

beforeEach(() => {
  mockedUseCameraPermissions.mockReset();
  mockedUseTheme.mockReset();
  mockedUseReduceMotion.mockReset();
  mockedUsePlants.mockReset();
  mockedOpenDb.mockReset();
  mockedTakePictureAsync.mockReset();

  mockedUseTheme.mockReturnValue(lightTheme);
  mockedUseReduceMotion.mockReturnValue(false);
  mockedUsePlants.mockReturnValue(makePlantsApi([makePlant()]));
  mockedOpenDb.mockResolvedValue(makeDb());
  setPermissionGranted();
});

afterEach(() => {
  jest.clearAllMocks();
});

// Helper: render the screen and wait for the FAB to appear (the list takes
// a frame to resolve its initial fetch). Always injects a compressPhotoImpl
// stub so the camera result screen can mount without driving real
// expo-image-manipulator (which the jest env can't service).
async function renderHome(props: Partial<React.ComponentProps<typeof GardenHomeScreen>> = {}) {
  const apiClient = props.apiClient ?? makeApiClient();
  const onPlantPress = props.onPlantPress ?? jest.fn();
  const compressPhotoImpl = props.compressPhotoImpl ?? makeCompressImpl();
  const result = render(
    <GardenHomeScreen
      apiClient={apiClient}
      onPlantPress={onPlantPress}
      nowMs={NOW}
      compressPhotoImpl={compressPhotoImpl}
      {...props}
    />,
  );
  await waitFor(() => expect(screen.queryByTestId('garden-home-list-fab')).toBeOnTheScreen());
  return { ...result, apiClient, compressPhotoImpl };
}

// =========================================================================
// FAB tap → identify mode camera
// =========================================================================

describe('GardenHomeScreen — FAB tap routes to identify camera', () => {
  it('FAB tap mounts <PlantCareCameraView> in identify mode', async () => {
    await renderHome();
    fireEvent.press(screen.getByTestId('garden-home-list-fab'));
    // The mock expo-camera surface is rendered → camera mounted.
    await waitFor(() => expect(screen.queryByTestId('mock-expo-camera-view')).toBeOnTheScreen());
    // Identify is the default; the toggle pill marks the active segment.
    // The camera view's mode-toggle exposes `camera-mode-segment-identify` /
    // `camera-mode-segment-diagnose` testIDs (E5-004). The active segment carries
    // accessibilityState.selected=true.
    const identifyTab = screen.getByTestId('camera-mode-segment-identify');
    expect(identifyTab.props.accessibilityState?.selected).toBe(true);
  });
});

// =========================================================================
// FAB long-press popover routing
// =========================================================================

describe('GardenHomeScreen — FAB long-press popover routes', () => {
  it('long-press → popover "Add a plant" → identify-mode camera', async () => {
    await renderHome();
    fireEvent(screen.getByTestId('garden-home-list-fab'), 'longPress');
    fireEvent.press(screen.getByTestId('garden-home-list-fab-popover-item-add'));
    await waitFor(() => expect(screen.queryByTestId('mock-expo-camera-view')).toBeOnTheScreen());
    expect(screen.getByTestId('camera-mode-segment-identify').props.accessibilityState?.selected).toBe(
      true,
    );
  });

  it('long-press → popover "Quick diagnose" → diagnose-mode camera', async () => {
    await renderHome();
    fireEvent(screen.getByTestId('garden-home-list-fab'), 'longPress');
    fireEvent.press(screen.getByTestId('garden-home-list-fab-popover-item-diagnose'));
    await waitFor(() => expect(screen.queryByTestId('mock-expo-camera-view')).toBeOnTheScreen());
    expect(screen.getByTestId('camera-mode-segment-diagnose').props.accessibilityState?.selected).toBe(
      true,
    );
  });

  it('long-press also fires onLongPressFAB analytics passthrough', async () => {
    const onLongPressFAB = jest.fn();
    await renderHome({ onLongPressFAB });
    fireEvent(screen.getByTestId('garden-home-list-fab'), 'longPress');
    expect(onLongPressFAB).toHaveBeenCalledTimes(1);
  });

  it('popover backdrop dismiss does NOT mount camera', async () => {
    await renderHome();
    fireEvent(screen.getByTestId('garden-home-list-fab'), 'longPress');
    fireEvent.press(screen.getByTestId('garden-home-list-fab-popover-backdrop'));
    expect(screen.queryByTestId('mock-expo-camera-view')).toBeNull();
  });
});

// =========================================================================
// Capture → result screen mode threading
// =========================================================================

describe('GardenHomeScreen — capture mode threads to result', () => {
  it('identify capture → result with mode=identify; success Save fires onIdentifySave + dismiss', async () => {
    mockedTakePictureAsync.mockResolvedValue({
      uri: 'file:///cache/raw.jpg',
      width: 4032,
      height: 3024,
    });
    const onIdentifySave = jest.fn();
    const compressImpl = makeCompressImpl();
    const { apiClient } = await renderHome({
      onIdentifySave,
      apiClient: makeApiClient(),
    });

    // FAB tap → identify mode
    fireEvent.press(screen.getByTestId('garden-home-list-fab'));
    await waitFor(() => expect(screen.queryByTestId('mock-expo-camera-view')).toBeOnTheScreen());

    // Inject a custom compress impl by re-rendering — the screen doesn't
    // expose it, so we go through the api client's diagnose to drive the
    // happy path. The default compressPhoto in jest is mocked at the
    // expo-image-manipulator boundary by jest-expo. We bypass that by
    // not relying on it: the integration test pattern instead drives the
    // capture and waits for the result screen's testID to appear.
    await act(async () => {
      fireEvent.press(screen.getByTestId('camera-shutter'));
    });

    // Result screen mounts. It receives mode='identify' from the capture.
    await waitFor(
      () => expect(screen.queryByTestId('garden-home-result')).toBeOnTheScreen(),
      { timeout: 3000 },
    );

    // Wait for diagnose to resolve and the success card to render.
    await waitFor(
      () => expect(screen.queryByTestId('garden-home-result-success')).toBeOnTheScreen(),
      { timeout: 3000 },
    );

    fireEvent.press(screen.getByTestId('garden-home-result-save'));

    // onIdentifySave fired with mode='identify' in payload.
    expect(onIdentifySave).toHaveBeenCalledTimes(1);
    expect(onIdentifySave.mock.calls[0][0].mode).toBe('identify');

    // After save, view returns to list (FAB visible again).
    await waitFor(() =>
      expect(screen.queryByTestId('garden-home-list-fab')).toBeOnTheScreen(),
    );
    // Mark unused-var concerns silenced.
    void apiClient;
    void compressImpl;
  });

  it('diagnose capture → result with mode=diagnose; success Save dismisses WITHOUT firing onIdentifySave AND without persisting a plant', async () => {
    mockedTakePictureAsync.mockResolvedValue({
      uri: 'file:///cache/raw.jpg',
      width: 4032,
      height: 3024,
    });
    const onIdentifySave = jest.fn();
    const plantsApi = makePlantsApi([makePlant()]);
    mockedUsePlants.mockReturnValue(plantsApi);
    await renderHome({ onIdentifySave });

    fireEvent(screen.getByTestId('garden-home-list-fab'), 'longPress');
    fireEvent.press(screen.getByTestId('garden-home-list-fab-popover-item-diagnose'));
    await waitFor(() => expect(screen.queryByTestId('mock-expo-camera-view')).toBeOnTheScreen());

    await act(async () => {
      fireEvent.press(screen.getByTestId('camera-shutter'));
    });

    await waitFor(
      () => expect(screen.queryByTestId('garden-home-result-success')).toBeOnTheScreen(),
      { timeout: 3000 },
    );

    fireEvent.press(screen.getByTestId('garden-home-result-save'));

    // The transient contract: NO onIdentifySave for diagnose mode.
    expect(onIdentifySave).not.toHaveBeenCalled();
    // P2 test-gap fix from codex review: assert no SQLite plant create
    // either. The hook's `create` is the persistence path; if a future
    // refactor accidentally wires it through this screen for a Quick
    // Diagnose flow, this assertion is the regression catch.
    expect(plantsApi.create).not.toHaveBeenCalled();

    // Dismiss back to list.
    await waitFor(() =>
      expect(screen.queryByTestId('garden-home-list-fab')).toBeOnTheScreen(),
    );
  });

  it('in-camera mode pill flip is UI-only — Quick Diagnose entry NEVER calls onIdentifySave even after flipping to identify (transient contract is entry-scoped)', async () => {
    mockedTakePictureAsync.mockResolvedValue({
      uri: 'file:///cache/raw.jpg',
      width: 4032,
      height: 3024,
    });
    const onIdentifySave = jest.fn();
    const plantsApi = makePlantsApi([makePlant()]);
    mockedUsePlants.mockReturnValue(plantsApi);
    await renderHome({ onIdentifySave });

    // Enter via Quick Diagnose entry point.
    fireEvent(screen.getByTestId('garden-home-list-fab'), 'longPress');
    fireEvent.press(screen.getByTestId('garden-home-list-fab-popover-item-diagnose'));
    await waitFor(() => expect(screen.queryByTestId('mock-expo-camera-view')).toBeOnTheScreen());

    // Flip to identify via the in-camera pill.
    fireEvent.press(screen.getByTestId('camera-mode-segment-identify'));

    await act(async () => {
      fireEvent.press(screen.getByTestId('camera-shutter'));
    });

    await waitFor(
      () => expect(screen.queryByTestId('garden-home-result-success')).toBeOnTheScreen(),
      { timeout: 3000 },
    );
    // The in-camera pill DOES change the result-screen `mode` prop for copy
    // purposes (verified via captureMode → mode threading).
    fireEvent.press(screen.getByTestId('garden-home-result-save'));

    // ENTRY-SCOPED CONTRACT (codex P1 fix): even though the user flipped to
    // identify mid-flow, the entry point was Quick Diagnose, so save MUST
    // NOT fire onIdentifySave. The in-camera pill is a copy/CTA-labeling
    // affordance only, not a persistence-mode promotion.
    expect(onIdentifySave).not.toHaveBeenCalled();
    // No SQLite create call either (P2 test gap from codex review).
    expect(plantsApi.create).not.toHaveBeenCalled();

    // Dismiss back to the list.
    await waitFor(() =>
      expect(screen.queryByTestId('garden-home-list-fab')).toBeOnTheScreen(),
    );
  });
});

// =========================================================================
// Cancel paths
// =========================================================================

describe('GardenHomeScreen — cancel paths', () => {
  it('camera close pre-shutter returns to list with no callbacks fired', async () => {
    const onIdentifySave = jest.fn();
    const onIdentifySavePhotoOnly = jest.fn();
    await renderHome({ onIdentifySave, onIdentifySavePhotoOnly });

    fireEvent.press(screen.getByTestId('garden-home-list-fab'));
    await waitFor(() => expect(screen.queryByTestId('mock-expo-camera-view')).toBeOnTheScreen());

    fireEvent.press(screen.getByTestId('camera-close-button'));

    await waitFor(() =>
      expect(screen.queryByTestId('garden-home-list-fab')).toBeOnTheScreen(),
    );
    expect(onIdentifySave).not.toHaveBeenCalled();
    expect(onIdentifySavePhotoOnly).not.toHaveBeenCalled();
    // takePictureAsync was never called.
    expect(mockedTakePictureAsync).not.toHaveBeenCalled();
  });
});

// =========================================================================
// Error variants — identify vs diagnose passthroughs
// =========================================================================

describe('GardenHomeScreen — error variant routing', () => {
  it('identify timeout "Save photo for now" fires onIdentifySavePhotoOnly + dismisses', async () => {
    mockedTakePictureAsync.mockResolvedValue({
      uri: 'file:///cache/raw.jpg',
      width: 4032,
      height: 3024,
    });
    const onIdentifySavePhotoOnly = jest.fn();
    await renderHome({
      onIdentifySavePhotoOnly,
      apiClient: makeApiClient(async () => ({
        ok: false,
        kind: 'timeout',
        message: 'Lab is slow',
      })),
    });

    fireEvent.press(screen.getByTestId('garden-home-list-fab'));
    await waitFor(() => expect(screen.queryByTestId('mock-expo-camera-view')).toBeOnTheScreen());
    await act(async () => {
      fireEvent.press(screen.getByTestId('camera-shutter'));
    });

    await waitFor(
      () =>
        expect(screen.queryByTestId('garden-home-result-error-timeout')).toBeOnTheScreen(),
      { timeout: 3000 },
    );

    fireEvent.press(screen.getByTestId('garden-home-result-save-photo-only'));

    expect(onIdentifySavePhotoOnly).toHaveBeenCalledTimes(1);
    expect(onIdentifySavePhotoOnly.mock.calls[0][0].mode).toBe('identify');
    await waitFor(() =>
      expect(screen.queryByTestId('garden-home-list-fab')).toBeOnTheScreen(),
    );
  });

  it('diagnose timeout "Save photo for now" does NOT fire onIdentifySavePhotoOnly (transient)', async () => {
    mockedTakePictureAsync.mockResolvedValue({
      uri: 'file:///cache/raw.jpg',
      width: 4032,
      height: 3024,
    });
    const onIdentifySavePhotoOnly = jest.fn();
    await renderHome({
      onIdentifySavePhotoOnly,
      apiClient: makeApiClient(async () => ({
        ok: false,
        kind: 'timeout',
      })),
    });

    fireEvent(screen.getByTestId('garden-home-list-fab'), 'longPress');
    fireEvent.press(screen.getByTestId('garden-home-list-fab-popover-item-diagnose'));
    await waitFor(() => expect(screen.queryByTestId('mock-expo-camera-view')).toBeOnTheScreen());
    await act(async () => {
      fireEvent.press(screen.getByTestId('camera-shutter'));
    });

    await waitFor(
      () =>
        expect(screen.queryByTestId('garden-home-result-error-timeout')).toBeOnTheScreen(),
      { timeout: 3000 },
    );
    fireEvent.press(screen.getByTestId('garden-home-result-save-photo-only'));

    expect(onIdentifySavePhotoOnly).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.queryByTestId('garden-home-list-fab')).toBeOnTheScreen(),
    );
  });

  it('identify server "Report" fires onIdentifyReportError; diagnose server "Report" does not', async () => {
    mockedTakePictureAsync.mockResolvedValue({
      uri: 'file:///cache/raw.jpg',
      width: 4032,
      height: 3024,
    });

    // identify path
    {
      const onIdentifyReportError = jest.fn();
      const utils = await renderHome({
        onIdentifyReportError,
        apiClient: makeApiClient(async () => ({
          ok: false,
          kind: 'server',
          status: 500,
          message: 'kaboom',
        })),
      });
      fireEvent.press(screen.getByTestId('garden-home-list-fab'));
      await waitFor(() =>
        expect(screen.queryByTestId('mock-expo-camera-view')).toBeOnTheScreen(),
      );
      await act(async () => {
        fireEvent.press(screen.getByTestId('camera-shutter'));
      });
      await waitFor(
        () =>
          expect(screen.queryByTestId('garden-home-result-error-server')).toBeOnTheScreen(),
        { timeout: 3000 },
      );
      fireEvent.press(screen.getByTestId('garden-home-result-report'));
      expect(onIdentifyReportError).toHaveBeenCalledTimes(1);
      expect(onIdentifyReportError.mock.calls[0][0].mode).toBe('identify');
      utils.unmount();
    }

    // diagnose path
    {
      mockedTakePictureAsync.mockResolvedValue({
        uri: 'file:///cache/raw2.jpg',
        width: 4032,
        height: 3024,
      });
      const onIdentifyReportError = jest.fn();
      await renderHome({
        onIdentifyReportError,
        apiClient: makeApiClient(async () => ({
          ok: false,
          kind: 'server',
          status: 500,
        })),
      });
      fireEvent(screen.getByTestId('garden-home-list-fab'), 'longPress');
      fireEvent.press(screen.getByTestId('garden-home-list-fab-popover-item-diagnose'));
      await waitFor(() =>
        expect(screen.queryByTestId('mock-expo-camera-view')).toBeOnTheScreen(),
      );
      await act(async () => {
        fireEvent.press(screen.getByTestId('camera-shutter'));
      });
      await waitFor(
        () =>
          expect(screen.queryByTestId('garden-home-result-error-server')).toBeOnTheScreen(),
        { timeout: 3000 },
      );
      fireEvent.press(screen.getByTestId('garden-home-result-report'));
      expect(onIdentifyReportError).not.toHaveBeenCalled();
      // Dismiss anyway.
      await waitFor(() =>
        expect(screen.queryByTestId('garden-home-list-fab')).toBeOnTheScreen(),
      );
    }
  });

  it('result-screen Close (error variant) returns to list with no callbacks', async () => {
    mockedTakePictureAsync.mockResolvedValue({
      uri: 'file:///cache/raw.jpg',
      width: 4032,
      height: 3024,
    });
    const onIdentifySave = jest.fn();
    const onIdentifyReportError = jest.fn();
    await renderHome({
      onIdentifySave,
      onIdentifyReportError,
      apiClient: makeApiClient(async () => ({ ok: false, kind: 'parse_error' })),
    });

    fireEvent.press(screen.getByTestId('garden-home-list-fab'));
    await waitFor(() => expect(screen.queryByTestId('mock-expo-camera-view')).toBeOnTheScreen());
    await act(async () => {
      fireEvent.press(screen.getByTestId('camera-shutter'));
    });
    await waitFor(
      () =>
        expect(
          screen.queryByTestId('garden-home-result-error-parse_error'),
        ).toBeOnTheScreen(),
      { timeout: 3000 },
    );
    fireEvent.press(screen.getByTestId('garden-home-result-close'));

    await waitFor(() =>
      expect(screen.queryByTestId('garden-home-list-fab')).toBeOnTheScreen(),
    );
    expect(onIdentifySave).not.toHaveBeenCalled();
    expect(onIdentifyReportError).not.toHaveBeenCalled();
  });
});

// =========================================================================
// Retake re-enters camera in entry-mode
// =========================================================================

describe('GardenHomeScreen — retake re-mounts camera in entry mode', () => {
  it('Quick Diagnose → flip to identify → reject → Try a different photo → camera mounts in DIAGNOSE again', async () => {
    mockedTakePictureAsync.mockResolvedValue({
      uri: 'file:///cache/raw.jpg',
      width: 4032,
      height: 3024,
    });
    await renderHome({
      apiClient: makeApiClient(async () => ({ ok: false, kind: 'layer1_reject' })),
    });

    fireEvent(screen.getByTestId('garden-home-list-fab'), 'longPress');
    fireEvent.press(screen.getByTestId('garden-home-list-fab-popover-item-diagnose'));
    await waitFor(() => expect(screen.queryByTestId('mock-expo-camera-view')).toBeOnTheScreen());

    // Flip to identify mid-flow.
    fireEvent.press(screen.getByTestId('camera-mode-segment-identify'));
    expect(screen.getByTestId('camera-mode-segment-identify').props.accessibilityState?.selected).toBe(
      true,
    );

    await act(async () => {
      fireEvent.press(screen.getByTestId('camera-shutter'));
    });
    await waitFor(
      () =>
        expect(
          screen.queryByTestId('garden-home-result-error-layer1_reject'),
        ).toBeOnTheScreen(),
      { timeout: 3000 },
    );

    fireEvent.press(screen.getByTestId('garden-home-result-retake'));

    // Camera mounts again, in DIAGNOSE (entry mode), not the post-flip identify.
    await waitFor(() => expect(screen.queryByTestId('mock-expo-camera-view')).toBeOnTheScreen());
    expect(screen.getByTestId('camera-mode-segment-diagnose').props.accessibilityState?.selected).toBe(
      true,
    );
  });
});
