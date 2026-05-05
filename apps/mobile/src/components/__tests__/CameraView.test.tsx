import { darkTheme, lightTheme } from '@plantcare/theme';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import React from 'react';
import { AccessibilityInfo, AppState, BackHandler, Platform } from 'react-native';

// Local PermissionResponse shape — see CameraPermissionPrePrompt.test.tsx
// for the rationale (avoid coupling to an internal expo-modules-core path).
type PermissionResponse = {
  status: 'granted' | 'denied' | 'undetermined';
  granted: boolean;
  canAskAgain: boolean;
  expires: 'never' | number;
};

// We mock both the camera permission hook AND the CameraView class component
// from expo-camera so the wrapper can be exercised under jest-expo's node env
// without spinning up the native module. The mock CameraView forwards refs so
// the imperative `takePictureAsync` call can be observed via a per-test stub.
jest.mock('expo-camera', () => {
  const ReactActual = require('react') as typeof import('react');
  const { View } = require('react-native') as typeof import('react-native');
  const useCameraPermissionsMock = jest.fn();
  const takePictureAsync = jest.fn();

  type MockCameraInstance = {
    takePictureAsync: typeof takePictureAsync;
  };

  const CameraView = ReactActual.forwardRef<MockCameraInstance, Record<string, unknown>>(
    function MockCameraView(props, ref) {
      ReactActual.useImperativeHandle(
        ref,
        () => ({ takePictureAsync }),
        [],
      );
      return ReactActual.createElement(View, {
        testID: 'mock-expo-camera-view',
        ...props,
      });
    },
  );

  return {
    __esModule: true,
    CameraView,
    useCameraPermissions: useCameraPermissionsMock,
    __takePictureAsync: takePictureAsync,
  };
});

// Mock useTheme so dark-mode test flips deterministically.
jest.mock('../../hooks/useTheme', () => ({
  useTheme: jest.fn(),
}));

// AccessibilityInfo.addEventListener returns a subscription with .remove() on
// modern RN. Stub the methods we actually use. AppState + BackHandler need the
// same {remove: () => void} subscription contract so cleanup runs cleanly under
// jest-expo's node env (where the real native modules aren't wired up).
jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(false);
jest.spyOn(AccessibilityInfo, 'addEventListener').mockImplementation(
  // @ts-expect-error — RN's overloaded signature is hard to satisfy from a stub.
  () => ({ remove: jest.fn() }),
);
jest.spyOn(AppState, 'addEventListener').mockImplementation(
  () => ({ remove: jest.fn() }),
);
jest.spyOn(BackHandler, 'addEventListener').mockImplementation(
  () => ({ remove: jest.fn() }),
);

import { useCameraPermissions } from 'expo-camera';

import { PlantCareCameraView } from '../CameraView';
import { useTheme } from '../../hooks/useTheme';

const mockedUseCameraPermissions = useCameraPermissions as jest.MockedFunction<typeof useCameraPermissions>;
const mockedUseTheme = useTheme as jest.MockedFunction<typeof useTheme>;
// Pull the takePictureAsync handle that the mock module exports for assertions.
const mockedTakePictureAsync = (jest.requireMock('expo-camera') as { __takePictureAsync: jest.Mock }).__takePictureAsync;

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

function setPermissionHook(permission: PermissionResponse | null, request?: jest.Mock): void {
  const requestPermission = request ?? jest.fn().mockResolvedValue(makeResponse({ status: 'undetermined' }));
  const getPermission = jest.fn().mockResolvedValue(makeResponse({ status: 'undetermined' }));
  mockedUseCameraPermissions.mockReturnValue([
    permission,
    requestPermission,
    getPermission,
  ] as unknown as ReturnType<typeof useCameraPermissions>);
}

beforeEach(() => {
  mockedUseCameraPermissions.mockReset();
  mockedUseTheme.mockReturnValue(lightTheme);
  mockedTakePictureAsync.mockReset();
});

describe('PlantCareCameraView — permission gating', () => {
  it('renders a blank surface while the permission hook is still resolving (null snapshot)', () => {
    // Permission snapshot is null on first render; we render a single blank
    // frame instead of the cream pre-prompt to avoid flashing it for an
    // already-granted user.
    setPermissionHook(null);
    render(
      <PlantCareCameraView
        mode="identify"
        onCapture={jest.fn()}
        onCancel={jest.fn()}
        testID="camera-view"
      />,
    );

    expect(screen.getByTestId('camera-view')).toBeOnTheScreen();
    expect(screen.queryByText('PlantCare wants your camera')).toBeNull();
    expect(screen.queryByTestId('camera-shutter')).toBeNull();
  });

  it('renders the pre-prompt when permission is undetermined', () => {
    setPermissionHook(makeResponse({ status: 'undetermined' }));
    render(
      <PlantCareCameraView
        mode="identify"
        onCapture={jest.fn()}
        onCancel={jest.fn()}
      />,
    );

    expect(screen.getByText('PlantCare wants your camera')).toBeOnTheScreen();
    expect(screen.queryByTestId('camera-shutter')).toBeNull();
  });

  it('renders the denied state from the pre-prompt when permission is permanently denied', async () => {
    setPermissionHook(makeResponse({ status: 'denied', canAskAgain: false }));
    render(
      <PlantCareCameraView
        mode="identify"
        onCapture={jest.fn()}
        onCancel={jest.fn()}
      />,
    );

    await screen.findByText('Camera blocked');
    expect(screen.queryByTestId('camera-shutter')).toBeNull();
  });

  it('renders the camera UI when permission is already granted on mount', async () => {
    setPermissionHook(makeResponse({ status: 'granted' }));
    render(
      <PlantCareCameraView
        mode="identify"
        onCapture={jest.fn()}
        onCancel={jest.fn()}
      />,
    );

    await waitFor(() => expect(screen.getByTestId('camera-shutter')).toBeOnTheScreen());
    expect(screen.getByTestId('camera-mode-toggle')).toBeOnTheScreen();
    expect(screen.getByTestId('camera-close-button')).toBeOnTheScreen();
    expect(screen.getByTestId('mock-expo-camera-view')).toBeOnTheScreen();
  });

  it('transitions from undetermined to granted (post-prompt) and renders the camera UI', async () => {
    // Render with undetermined → user grants → re-render with granted snapshot.
    // The pre-prompt fires onGranted internally which flips local state.
    let resolveRequest!: (response: PermissionResponse) => void;
    const requestPermission = jest.fn().mockImplementation(
      () =>
        new Promise<PermissionResponse>((resolve) => {
          resolveRequest = resolve;
        }),
    );
    setPermissionHook(makeResponse({ status: 'undetermined' }), requestPermission);
    render(
      <PlantCareCameraView
        mode="identify"
        onCapture={jest.fn()}
        onCancel={jest.fn()}
      />,
    );

    fireEvent.press(screen.getByLabelText('Allow camera access'));
    await act(async () => {
      resolveRequest(makeResponse({ status: 'granted' }));
    });

    await waitFor(() => expect(screen.getByTestId('camera-shutter')).toBeOnTheScreen());
  });
});

describe('PlantCareCameraView — mode toggle', () => {
  beforeEach(() => {
    setPermissionHook(makeResponse({ status: 'granted' }));
  });

  it('marks the identify segment as selected when mode=identify', async () => {
    render(
      <PlantCareCameraView
        mode="identify"
        onModeChange={jest.fn()}
        onCapture={jest.fn()}
        onCancel={jest.fn()}
      />,
    );

    const identify = await screen.findByTestId('camera-mode-segment-identify');
    const diagnose = screen.getByTestId('camera-mode-segment-diagnose');
    expect(identify.props.accessibilityState).toEqual(
      expect.objectContaining({ selected: true }),
    );
    expect(diagnose.props.accessibilityState).toEqual(
      expect.objectContaining({ selected: false }),
    );
  });

  it('fires onModeChange("diagnose") when the diagnose segment is tapped', async () => {
    const onModeChange = jest.fn();
    render(
      <PlantCareCameraView
        mode="identify"
        onModeChange={onModeChange}
        onCapture={jest.fn()}
        onCancel={jest.fn()}
      />,
    );

    const diagnose = await screen.findByTestId('camera-mode-segment-diagnose');
    fireEvent.press(diagnose);
    expect(onModeChange).toHaveBeenCalledWith('diagnose');
    expect(onModeChange).toHaveBeenCalledTimes(1);
  });

  it('declares hitSlop on each toggle segment so the 44×44 target is met', async () => {
    render(
      <PlantCareCameraView
        mode="identify"
        onCapture={jest.fn()}
        onCancel={jest.fn()}
      />,
    );

    const identify = await screen.findByTestId('camera-mode-segment-identify');
    const diagnose = screen.getByTestId('camera-mode-segment-diagnose');
    // hitSlop=12 + 36px minHeight = 60px effective height; 96px minWidth + 24
    // hitSlop = 120px effective width — comfortably above 44.
    expect(identify.props.hitSlop).toBeDefined();
    expect(diagnose.props.hitSlop).toBeDefined();
  });
});

describe('PlantCareCameraView — shutter', () => {
  beforeEach(() => {
    setPermissionHook(makeResponse({ status: 'granted' }));
  });

  it('calls takePictureAsync exactly once when the shutter is tapped', async () => {
    mockedTakePictureAsync.mockResolvedValue({ uri: 'file:///cache/x.jpg', width: 100, height: 100 });
    render(
      <PlantCareCameraView
        mode="identify"
        onCapture={jest.fn()}
        onCancel={jest.fn()}
      />,
    );

    const shutter = await screen.findByTestId('camera-shutter');
    fireEvent.press(shutter);
    await waitFor(() => expect(mockedTakePictureAsync).toHaveBeenCalledTimes(1));
    expect(mockedTakePictureAsync).toHaveBeenCalledWith(
      expect.objectContaining({ quality: 0.85, skipProcessing: false }),
    );
  });

  it('calls onCapture with uri/width/height when takePictureAsync resolves', async () => {
    mockedTakePictureAsync.mockResolvedValue({
      uri: 'file:///cache/photo.jpg',
      width: 1024,
      height: 1536,
    });
    const onCapture = jest.fn();
    render(
      <PlantCareCameraView
        mode="identify"
        onCapture={onCapture}
        onCancel={jest.fn()}
      />,
    );

    const shutter = await screen.findByTestId('camera-shutter');
    fireEvent.press(shutter);
    await waitFor(() => expect(onCapture).toHaveBeenCalledTimes(1));
    expect(onCapture).toHaveBeenCalledWith({
      uri: 'file:///cache/photo.jpg',
      width: 1024,
      height: 1536,
    });
  });

  it('swallows takePictureAsync rejections (logs warn) and does not call onCapture', async () => {
    const consoleWarn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockedTakePictureAsync.mockRejectedValue(new Error('camera unavailable'));
    const onCapture = jest.fn();
    render(
      <PlantCareCameraView
        mode="identify"
        onCapture={onCapture}
        onCancel={jest.fn()}
      />,
    );

    const shutter = await screen.findByTestId('camera-shutter');
    fireEvent.press(shutter);
    await waitFor(() => expect(mockedTakePictureAsync).toHaveBeenCalled());
    expect(onCapture).not.toHaveBeenCalled();
    expect(consoleWarn).toHaveBeenCalledWith(
      '[CameraView] takePictureAsync failed',
      expect.any(Error),
    );
    consoleWarn.mockRestore();
  });

  it('debounces double taps — only one takePictureAsync in flight at a time', async () => {
    let resolveTake!: (result: { uri: string; width: number; height: number }) => void;
    mockedTakePictureAsync.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveTake = resolve;
        }),
    );
    const onCapture = jest.fn();
    render(
      <PlantCareCameraView
        mode="identify"
        onCapture={onCapture}
        onCancel={jest.fn()}
      />,
    );

    const shutter = await screen.findByTestId('camera-shutter');
    fireEvent.press(shutter);
    fireEvent.press(shutter);
    fireEvent.press(shutter);

    await waitFor(() => expect(mockedTakePictureAsync).toHaveBeenCalledTimes(1));

    await act(async () => {
      resolveTake({ uri: 'file:///cache/x.jpg', width: 100, height: 100 });
    });
    expect(onCapture).toHaveBeenCalledTimes(1);
  });
});

describe('PlantCareCameraView — close button', () => {
  it('fires onCancel when the close button is tapped (granted state)', async () => {
    setPermissionHook(makeResponse({ status: 'granted' }));
    const onCancel = jest.fn();
    render(
      <PlantCareCameraView
        mode="identify"
        onCapture={jest.fn()}
        onCancel={onCancel}
      />,
    );

    const closeButton = await screen.findByTestId('camera-close-button');
    fireEvent.press(closeButton);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe('PlantCareCameraView — accessibility', () => {
  beforeEach(() => {
    setPermissionHook(makeResponse({ status: 'granted' }));
  });

  it('marks the shutter as a button with the "Capture photo" label', async () => {
    render(
      <PlantCareCameraView
        mode="identify"
        onCapture={jest.fn()}
        onCancel={jest.fn()}
      />,
    );

    const shutter = await screen.findByLabelText('Capture photo');
    expect(shutter.props.accessibilityRole).toBe('button');
  });

  it('marks the close button as a button with a "Close camera" label', async () => {
    render(
      <PlantCareCameraView
        mode="identify"
        onCapture={jest.fn()}
        onCancel={jest.fn()}
      />,
    );

    const close = await screen.findByLabelText('Close camera');
    expect(close.props.accessibilityRole).toBe('button');
  });

  it('marks each toggle segment as a button with a mode-specific label', async () => {
    render(
      <PlantCareCameraView
        mode="identify"
        onCapture={jest.fn()}
        onCancel={jest.fn()}
      />,
    );

    const identify = await screen.findByLabelText('IDENTIFY mode');
    const diagnose = screen.getByLabelText('DIAGNOSE mode');
    expect(identify.props.accessibilityRole).toBe('button');
    expect(diagnose.props.accessibilityRole).toBe('button');
  });
});

describe('PlantCareCameraView — permission resume + Android back', () => {
  it('re-queries permission status when AppState transitions to "active"', async () => {
    // Codex P2: stale `useCameraPermissions()` snapshot after the user grants
    // permission in Settings. Verify that we call the hook's get-fn on
    // foreground so the snapshot refreshes.
    const requestPermission = jest.fn();
    const getPermission = jest.fn().mockResolvedValue(makeResponse({ status: 'granted' }));
    mockedUseCameraPermissions.mockReturnValue([
      makeResponse({ status: 'denied', canAskAgain: true }),
      requestPermission,
      getPermission,
    ] as unknown as ReturnType<typeof useCameraPermissions>);

    let appStateHandler: ((next: string) => void) | undefined;
    // Override the global addEventListener stub with a capturing one for this
    // test only. We re-install the no-op stub at the end of the test (rather
    // than mockRestore) so subsequent tests get a subscription with .remove()
    // instead of jest's "real" behavior under jest-expo's node env, which
    // returns undefined and crashes the cleanup.
    const captureMock = (AppState.addEventListener as jest.Mock).mockImplementation(
      (_event: string, handler: (next: string) => void) => {
        appStateHandler = handler;
        return { remove: jest.fn() };
      },
    );

    render(
      <PlantCareCameraView
        mode="identify"
        onCapture={jest.fn()}
        onCancel={jest.fn()}
      />,
    );

    expect(appStateHandler).toBeDefined();
    await act(async () => {
      appStateHandler?.('active');
    });
    expect(getPermission).toHaveBeenCalled();
    // Restore the no-op stub so other tests' cleanups have a subscription.
    captureMock.mockImplementation(() => ({ remove: jest.fn() }));
  });

  it('routes Android hardware back to onCancel when permission is granted', async () => {
    setPermissionHook(makeResponse({ status: 'granted' }));
    const originalOS = Platform.OS;
    Object.defineProperty(Platform, 'OS', { value: 'android', writable: true });

    let backHandler: (() => boolean) | undefined;
    const captureMock = (BackHandler.addEventListener as jest.Mock).mockImplementation(
      (_event: string, handler: () => boolean) => {
        backHandler = handler;
        return { remove: jest.fn() };
      },
    );
    const onCancel = jest.fn();
    render(
      <PlantCareCameraView
        mode="identify"
        onCapture={jest.fn()}
        onCancel={onCancel}
      />,
    );

    await screen.findByTestId('camera-shutter');
    expect(backHandler).toBeDefined();
    const handled = backHandler?.();
    expect(handled).toBe(true);
    expect(onCancel).toHaveBeenCalledTimes(1);

    Object.defineProperty(Platform, 'OS', { value: originalOS, writable: true });
    captureMock.mockImplementation(() => ({ remove: jest.fn() }));
  });
});

describe('PlantCareCameraView — theming', () => {
  it('uses dark Midnight Conservatory tokens when the theme is dark', async () => {
    mockedUseTheme.mockReturnValue(darkTheme);
    setPermissionHook(makeResponse({ status: 'granted' }));
    render(
      <PlantCareCameraView
        mode="diagnose"
        onCapture={jest.fn()}
        onCancel={jest.fn()}
      />,
    );

    const toggle = await screen.findByTestId('camera-mode-toggle');
    const style = Array.isArray(toggle.props.style)
      ? Object.assign({}, ...toggle.props.style)
      : toggle.props.style;
    expect(style.backgroundColor).toBe(darkTheme.colors.surface);
    expect(style.borderColor).toBe(darkTheme.colors.stroke);
  });
});
