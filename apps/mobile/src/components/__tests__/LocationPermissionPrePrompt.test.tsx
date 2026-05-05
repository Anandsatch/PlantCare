import { darkTheme, lightTheme } from '@plantcare/theme';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { AccessibilityInfo, AppState, BackHandler, Linking, Platform } from 'react-native';

// Local shape for expo-location's permission response — kept inline so the
// test file doesn't couple to expo-modules-core's internal layout. The
// actual runtime types use a string enum; we cast through unknown at the
// call sites to avoid importing the enum here (parity with the camera
// pre-prompt test file).
type LocalPermissionResponse = {
  status: 'granted' | 'denied' | 'undetermined';
  granted: boolean;
  canAskAgain: boolean;
  expires: 'never' | number;
};
// Alias to the real type for places where the SDK signature is enforced.
type LocationPermissionResponse = Awaited<
  ReturnType<typeof import('expo-location').getForegroundPermissionsAsync>
>;

type LocationObject = {
  coords: {
    latitude: number;
    longitude: number;
    altitude: number | null;
    accuracy: number | null;
    altitudeAccuracy: number | null;
    heading: number | null;
    speed: number | null;
  };
  timestamp: number;
};

// Mock expo-location. We mirror the camera pre-prompt's mocking strategy: a
// single jest.fn per surface area, settable per-test.
jest.mock('expo-location', () => ({
  getForegroundPermissionsAsync: jest.fn(),
  requestForegroundPermissionsAsync: jest.fn(),
  getCurrentPositionAsync: jest.fn(),
}));

jest.spyOn(Linking, 'openSettings').mockImplementation(() => Promise.resolve());

// Mock useTheme so the dark-mode test flips deterministically.
jest.mock('../../hooks/useTheme', () => ({
  useTheme: jest.fn(),
}));

// AppState/BackHandler/AccessibilityInfo: stub the .addEventListener signatures
// to return a {remove} subscription so cleanup runs cleanly under jest-expo's
// node env (no native module wired up).
let appStateChangeHandler: ((next: 'active' | 'background' | 'inactive') => void) | null = null;
jest.spyOn(AppState, 'addEventListener').mockImplementation((event, handler) => {
  if (event === 'change') {
    appStateChangeHandler = handler as typeof appStateChangeHandler;
  }
  return { remove: jest.fn() };
});

let backHandlerHandler: (() => boolean) | null = null;
jest.spyOn(BackHandler, 'addEventListener').mockImplementation((event, handler) => {
  if (event === 'hardwareBackPress') {
    backHandlerHandler = handler as typeof backHandlerHandler;
  }
  // BackHandler.addEventListener returns a subscription with .remove() on
  // modern RN 0.83. The runtime types lag.
  return { remove: jest.fn() } as unknown as ReturnType<typeof BackHandler.addEventListener>;
});

jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(false);
jest.spyOn(AccessibilityInfo, 'addEventListener').mockImplementation(
  // @ts-expect-error — RN's overloaded signature is hard to satisfy from a stub.
  () => ({ remove: jest.fn() }),
);

import * as Location from 'expo-location';

import { LocationPermissionPrePrompt } from '../LocationPermissionPrePrompt';
import { useTheme } from '../../hooks/useTheme';

const mockedGetForeground = Location.getForegroundPermissionsAsync as jest.MockedFunction<
  typeof Location.getForegroundPermissionsAsync
>;
const mockedRequestForeground = Location.requestForegroundPermissionsAsync as jest.MockedFunction<
  typeof Location.requestForegroundPermissionsAsync
>;
const mockedGetCurrentPosition = Location.getCurrentPositionAsync as jest.MockedFunction<
  typeof Location.getCurrentPositionAsync
>;
const mockedUseTheme = useTheme as jest.MockedFunction<typeof useTheme>;
const mockedOpenSettings = Linking.openSettings as jest.MockedFunction<typeof Linking.openSettings>;

// PermissionStatus is a real string-valued enum in expo-modules-core. We cast
// through `unknown` so the tests can keep the friendly literal-string union
// without importing the runtime enum (mirrors the camera pre-prompt tests).
function makePermission(overrides: {
  status: 'granted' | 'denied' | 'undetermined';
  granted?: boolean;
  canAskAgain?: boolean;
}): LocationPermissionResponse {
  const granted = overrides.granted ?? overrides.status === 'granted';
  return {
    status: overrides.status,
    granted,
    canAskAgain: overrides.canAskAgain ?? (overrides.status === 'denied' ? false : true),
    expires: 'never',
  } as unknown as LocationPermissionResponse;
}

function makePosition(latitude: number, longitude: number): LocationObject {
  return {
    coords: {
      latitude,
      longitude,
      altitude: null,
      accuracy: 5,
      altitudeAccuracy: null,
      heading: null,
      speed: null,
    },
    timestamp: Date.now(),
  };
}

beforeEach(() => {
  mockedGetForeground.mockReset();
  mockedRequestForeground.mockReset();
  mockedGetCurrentPosition.mockReset();
  mockedUseTheme.mockReturnValue(lightTheme);
  mockedOpenSettings.mockClear();
  appStateChangeHandler = null;
  backHandlerHandler = null;
  // Default platform to iOS so back-handler tests opt-in to android.
  Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
});

describe('LocationPermissionPrePrompt — initial render (resolving → undetermined)', () => {
  it('renders a blank surface frame while the initial snapshot is in flight', () => {
    let resolveSnapshot!: (response: LocalPermissionResponse) => void;
    mockedGetForeground.mockImplementation(
      () =>
        new Promise<LocalPermissionResponse>((resolve) => {
          resolveSnapshot = resolve;
        }) as unknown as ReturnType<typeof Location.getForegroundPermissionsAsync>,
    );
    render(
      <LocationPermissionPrePrompt
        onGranted={jest.fn()}
        onZipSubmit={jest.fn()}
        onCancel={jest.fn()}
        testID="loc-pre-prompt"
      />,
    );

    // Cream pre-prompt must not be on screen during the resolving window.
    expect(screen.queryByText('PlantCare wants your location')).toBeNull();
    expect(screen.getByTestId('loc-pre-prompt')).toBeOnTheScreen();

    // Drain the pending promise so the test exits cleanly.
    void resolveSnapshot(makePermission({ status: 'undetermined' }));
  });

  it('renders the cream pre-prompt with the WHY copy + both CTAs once snapshot resolves to undetermined', async () => {
    mockedGetForeground.mockResolvedValue(makePermission({ status: 'undetermined' }));
    render(
      <LocationPermissionPrePrompt
        onGranted={jest.fn()}
        onZipSubmit={jest.fn()}
        onCancel={jest.fn()}
        testID="loc-pre-prompt"
      />,
    );

    await screen.findByText('PlantCare wants your location');
    expect(
      screen.getByText(
        /To check the forecast for your watering decisions\. Used only on this device\./,
      ),
    ).toBeOnTheScreen();
    expect(screen.getByLabelText('Use my location')).toBeOnTheScreen();
    expect(screen.getByLabelText('Enter ZIP instead')).toBeOnTheScreen();
  });
});

describe('LocationPermissionPrePrompt — already-granted on mount (no cream flash)', () => {
  it('does not flash the cream pre-prompt when permission is already granted', async () => {
    const onGranted = jest.fn();
    mockedGetForeground.mockResolvedValue(makePermission({ status: 'granted' }));
    mockedGetCurrentPosition.mockResolvedValue(makePosition(37.7749, -122.4194));

    render(
      <LocationPermissionPrePrompt
        onGranted={onGranted}
        onZipSubmit={jest.fn()}
        onCancel={jest.fn()}
        testID="loc-pre-prompt"
      />,
    );

    await waitFor(() =>
      expect(onGranted).toHaveBeenCalledWith({ latitude: 37.7749, longitude: -122.4194 }),
    );
    expect(screen.queryByText('PlantCare wants your location')).toBeNull();
  });

  it('fires onGranted exactly once even on multiple AppState transitions', async () => {
    const onGranted = jest.fn();
    mockedGetForeground.mockResolvedValue(makePermission({ status: 'granted' }));
    mockedGetCurrentPosition.mockResolvedValue(makePosition(40.7128, -74.006));

    render(
      <LocationPermissionPrePrompt
        onGranted={onGranted}
        onZipSubmit={jest.fn()}
        onCancel={jest.fn()}
      />,
    );

    await waitFor(() => expect(onGranted).toHaveBeenCalledTimes(1));

    // Simulate the app going background and back.
    await act(async () => {
      appStateChangeHandler?.('background');
      appStateChangeHandler?.('active');
    });
    await waitFor(() => expect(onGranted).toHaveBeenCalledTimes(1));
  });
});

describe('LocationPermissionPrePrompt — already permanently denied on mount', () => {
  it('renders the denied state with Open Settings + Enter ZIP CTAs', async () => {
    mockedGetForeground.mockResolvedValue(
      makePermission({ status: 'denied', canAskAgain: false }),
    );

    render(
      <LocationPermissionPrePrompt
        onGranted={jest.fn()}
        onZipSubmit={jest.fn()}
        onCancel={jest.fn()}
      />,
    );

    await screen.findByText('Location blocked');
    expect(
      screen.getByLabelText('Open the Settings app to enable location access'),
    ).toBeOnTheScreen();
    expect(screen.getByLabelText('Enter ZIP instead')).toBeOnTheScreen();
    // Cream pre-prompt must not be visible.
    expect(screen.queryByText('PlantCare wants your location')).toBeNull();
  });

  it('opens the Settings app when Open Settings is tapped', async () => {
    mockedGetForeground.mockResolvedValue(
      makePermission({ status: 'denied', canAskAgain: false }),
    );

    render(
      <LocationPermissionPrePrompt
        onGranted={jest.fn()}
        onZipSubmit={jest.fn()}
        onCancel={jest.fn()}
      />,
    );

    await screen.findByText('Location blocked');
    fireEvent.press(
      screen.getByLabelText('Open the Settings app to enable location access'),
    );
    expect(mockedOpenSettings).toHaveBeenCalledTimes(1);
  });
});

describe('LocationPermissionPrePrompt — request flow', () => {
  it('calls requestForegroundPermissionsAsync once when the CTA is tapped', async () => {
    mockedGetForeground.mockResolvedValue(makePermission({ status: 'undetermined' }));
    mockedRequestForeground.mockResolvedValue(makePermission({ status: 'granted' }));
    mockedGetCurrentPosition.mockResolvedValue(makePosition(1, 2));

    render(
      <LocationPermissionPrePrompt
        onGranted={jest.fn()}
        onZipSubmit={jest.fn()}
        onCancel={jest.fn()}
      />,
    );

    await screen.findByLabelText('Use my location');
    fireEvent.press(screen.getByLabelText('Use my location'));
    await waitFor(() => expect(mockedRequestForeground).toHaveBeenCalledTimes(1));
  });

  it('fires onGranted with coords when request resolves granted=true', async () => {
    const onGranted = jest.fn();
    mockedGetForeground.mockResolvedValue(makePermission({ status: 'undetermined' }));
    mockedRequestForeground.mockResolvedValue(makePermission({ status: 'granted' }));
    mockedGetCurrentPosition.mockResolvedValue(makePosition(51.5074, -0.1278));

    render(
      <LocationPermissionPrePrompt
        onGranted={onGranted}
        onZipSubmit={jest.fn()}
        onCancel={jest.fn()}
      />,
    );

    fireEvent.press(await screen.findByLabelText('Use my location'));
    await waitFor(() =>
      expect(onGranted).toHaveBeenCalledWith({ latitude: 51.5074, longitude: -0.1278 }),
    );
  });

  it('returns to undetermined when the OS dialog is dismissed (canAskAgain=true)', async () => {
    mockedGetForeground.mockResolvedValue(makePermission({ status: 'undetermined' }));
    mockedRequestForeground.mockResolvedValue(
      makePermission({ status: 'undetermined', granted: false, canAskAgain: true }),
    );

    render(
      <LocationPermissionPrePrompt
        onGranted={jest.fn()}
        onZipSubmit={jest.fn()}
        onCancel={jest.fn()}
      />,
    );

    fireEvent.press(await screen.findByLabelText('Use my location'));
    // After the request resolves, the cream pre-prompt is back.
    await waitFor(() =>
      expect(screen.queryByText('PlantCare wants your location')).toBeOnTheScreen(),
    );
  });

  it('jumps to denied when request returns granted=false, canAskAgain=false', async () => {
    mockedGetForeground.mockResolvedValue(makePermission({ status: 'undetermined' }));
    mockedRequestForeground.mockResolvedValue(
      makePermission({ status: 'denied', canAskAgain: false }),
    );

    render(
      <LocationPermissionPrePrompt
        onGranted={jest.fn()}
        onZipSubmit={jest.fn()}
        onCancel={jest.fn()}
      />,
    );

    fireEvent.press(await screen.findByLabelText('Use my location'));
    await screen.findByText('Location blocked');
  });

  it('shows a spinner and disables the CTA while the request is in flight', async () => {
    let resolveRequest!: (response: LocalPermissionResponse) => void;
    mockedGetForeground.mockResolvedValue(makePermission({ status: 'undetermined' }));
    mockedRequestForeground.mockImplementation(
      () =>
        new Promise<LocalPermissionResponse>((resolve) => {
          resolveRequest = resolve;
        }) as unknown as ReturnType<typeof Location.requestForegroundPermissionsAsync>,
    );

    render(
      <LocationPermissionPrePrompt
        onGranted={jest.fn()}
        onZipSubmit={jest.fn()}
        onCancel={jest.fn()}
      />,
    );

    fireEvent.press(await screen.findByLabelText('Use my location'));

    await waitFor(() => {
      const cta = screen.getByLabelText('Use my location');
      expect(cta.props.accessibilityState).toEqual(
        expect.objectContaining({ disabled: true, busy: true }),
      );
    });
    expect(screen.getByTestId('location-pre-prompt-spinner')).toBeOnTheScreen();

    // Drain the in-flight promise so React's act buffer flushes cleanly.
    await act(async () => {
      resolveRequest(makePermission({ status: 'undetermined', canAskAgain: true }));
    });
  });

  it('falls back to undetermined if requestForegroundPermissionsAsync rejects', async () => {
    const onGranted = jest.fn();
    mockedGetForeground.mockResolvedValue(makePermission({ status: 'undetermined' }));
    mockedRequestForeground.mockRejectedValue(new Error('os hiccup'));

    render(
      <LocationPermissionPrePrompt
        onGranted={onGranted}
        onZipSubmit={jest.fn()}
        onCancel={jest.fn()}
      />,
    );

    fireEvent.press(await screen.findByLabelText('Use my location'));
    await screen.findByText('PlantCare wants your location');
    expect(onGranted).not.toHaveBeenCalled();
  });

  it('flips to ZIP fallback if getCurrentPositionAsync rejects post-grant', async () => {
    const onGranted = jest.fn();
    mockedGetForeground.mockResolvedValue(makePermission({ status: 'undetermined' }));
    mockedRequestForeground.mockResolvedValue(makePermission({ status: 'granted' }));
    mockedGetCurrentPosition.mockRejectedValue(new Error('GPS off'));

    render(
      <LocationPermissionPrePrompt
        onGranted={onGranted}
        onZipSubmit={jest.fn()}
        onCancel={jest.fn()}
      />,
    );

    fireEvent.press(await screen.findByLabelText('Use my location'));
    await screen.findByText('Enter your ZIP');
    expect(onGranted).not.toHaveBeenCalled();
  });
});

describe('LocationPermissionPrePrompt — ZIP fallback', () => {
  it('navigates to ZIP fallback when "Enter ZIP instead" is tapped from the cream pre-prompt', async () => {
    mockedGetForeground.mockResolvedValue(makePermission({ status: 'undetermined' }));
    render(
      <LocationPermissionPrePrompt
        onGranted={jest.fn()}
        onZipSubmit={jest.fn()}
        onCancel={jest.fn()}
      />,
    );

    fireEvent.press(await screen.findByLabelText('Enter ZIP instead'));
    await screen.findByText('Enter your ZIP');
    expect(screen.getByTestId('location-zip-input')).toBeOnTheScreen();
  });

  it('strips a leading "+1 " US country-code prefix before clamping (codex P2 paste case)', async () => {
    mockedGetForeground.mockResolvedValue(makePermission({ status: 'undetermined' }));
    render(
      <LocationPermissionPrePrompt
        onGranted={jest.fn()}
        onZipSubmit={jest.fn()}
        onCancel={jest.fn()}
      />,
    );

    fireEvent.press(await screen.findByLabelText('Enter ZIP instead'));
    const input = screen.getByTestId('location-zip-input');
    // Without the country-code strip, "+1 94110" → all digits "194110" →
    // clamp → "19411" (wrong). With the strip, we get the intended "94110".
    fireEvent.changeText(input, '+1 94110');
    expect(input.props.value).toBe('94110');
  });

  it('strips non-digits and clamps to 5 digits when the user pastes "12345-6789"', async () => {
    mockedGetForeground.mockResolvedValue(makePermission({ status: 'undetermined' }));
    render(
      <LocationPermissionPrePrompt
        onGranted={jest.fn()}
        onZipSubmit={jest.fn()}
        onCancel={jest.fn()}
      />,
    );

    fireEvent.press(await screen.findByLabelText('Enter ZIP instead'));
    const input = screen.getByTestId('location-zip-input');
    fireEvent.changeText(input, '12345-6789');
    expect(input.props.value).toBe('12345');
  });

  it('preserves leading-zero ZIPs (06511 → 06511)', async () => {
    mockedGetForeground.mockResolvedValue(makePermission({ status: 'undetermined' }));
    const onZipSubmit = jest.fn();
    render(
      <LocationPermissionPrePrompt
        onGranted={jest.fn()}
        onZipSubmit={onZipSubmit}
        onCancel={jest.fn()}
      />,
    );

    fireEvent.press(await screen.findByLabelText('Enter ZIP instead'));
    const input = screen.getByTestId('location-zip-input');
    fireEvent.changeText(input, '06511');
    expect(input.props.value).toBe('06511');

    fireEvent.press(screen.getByLabelText('Submit ZIP'));
    expect(onZipSubmit).toHaveBeenCalledWith('06511');
  });

  it('disables the Submit ZIP CTA until exactly 5 digits are entered', async () => {
    mockedGetForeground.mockResolvedValue(makePermission({ status: 'undetermined' }));
    const onZipSubmit = jest.fn();
    render(
      <LocationPermissionPrePrompt
        onGranted={jest.fn()}
        onZipSubmit={onZipSubmit}
        onCancel={jest.fn()}
      />,
    );

    fireEvent.press(await screen.findByLabelText('Enter ZIP instead'));
    const input = screen.getByTestId('location-zip-input');
    fireEvent.changeText(input, '123');
    const submit = screen.getByLabelText('Submit ZIP');
    expect(submit.props.accessibilityState).toEqual(expect.objectContaining({ disabled: true }));
    fireEvent.press(submit);
    expect(onZipSubmit).not.toHaveBeenCalled();

    fireEvent.changeText(input, '12345');
    const submitNow = screen.getByLabelText('Submit ZIP');
    expect(submitNow.props.accessibilityState).toEqual(expect.objectContaining({ disabled: false }));
  });

  it('emits onZipSubmit with the digit-only payload', async () => {
    mockedGetForeground.mockResolvedValue(makePermission({ status: 'undetermined' }));
    const onZipSubmit = jest.fn();
    render(
      <LocationPermissionPrePrompt
        onGranted={jest.fn()}
        onZipSubmit={onZipSubmit}
        onCancel={jest.fn()}
      />,
    );

    fireEvent.press(await screen.findByLabelText('Enter ZIP instead'));
    const input = screen.getByTestId('location-zip-input');
    fireEvent.changeText(input, '94110');
    fireEvent.press(screen.getByLabelText('Submit ZIP'));
    expect(onZipSubmit).toHaveBeenCalledWith('94110');
    expect(onZipSubmit).toHaveBeenCalledTimes(1);
  });

  it('exposes "Enter ZIP instead" from the denied state too', async () => {
    mockedGetForeground.mockResolvedValue(
      makePermission({ status: 'denied', canAskAgain: false }),
    );
    render(
      <LocationPermissionPrePrompt
        onGranted={jest.fn()}
        onZipSubmit={jest.fn()}
        onCancel={jest.fn()}
      />,
    );

    await screen.findByText('Location blocked');
    fireEvent.press(screen.getByLabelText('Enter ZIP instead'));
    await screen.findByText('Enter your ZIP');
  });
});

describe('LocationPermissionPrePrompt — codex fixes (P1, P2, P3)', () => {
  it('exposes a "Not now" CTA on the denied state so users can exit without ZIP (codex P2)', async () => {
    mockedGetForeground.mockResolvedValue(
      makePermission({ status: 'denied', canAskAgain: false }),
    );
    const onCancel = jest.fn();
    render(
      <LocationPermissionPrePrompt
        onGranted={jest.fn()}
        onZipSubmit={jest.fn()}
        onCancel={onCancel}
      />,
    );
    await screen.findByText('Location blocked');
    fireEvent.press(screen.getByLabelText('Not now'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('renders an accessibilityRole=header on every visible state for focus handoff (codex P3)', async () => {
    // The component runs an effect that calls AccessibilityInfo.setAccessibilityFocus
    // on the heading container after every state transition. Under jest-expo's
    // node test environment, findNodeHandle returns null for test-rendered Views,
    // so we can't observe the call directly — instead we verify the structural
    // contract: every visible state renders exactly one accessibilityRole=header
    // so the focus handoff has a target to land on.
    mockedGetForeground.mockResolvedValue(makePermission({ status: 'undetermined' }));
    render(
      <LocationPermissionPrePrompt
        onGranted={jest.fn()}
        onZipSubmit={jest.fn()}
        onCancel={jest.fn()}
      />,
    );

    // Undetermined state → header.
    await screen.findByRole('header');
    expect(screen.getByRole('header')).toHaveTextContent('PlantCare wants your location');

    // Transition to ZIP fallback → header.
    fireEvent.press(screen.getByLabelText('Enter ZIP instead'));
    await screen.findByText('Enter your ZIP');
    expect(screen.getByRole('header')).toHaveTextContent('Enter your ZIP');
  });

  it('does not double-fire onGranted when AppState resume races mount-path resolve (codex P1 single-flight)', async () => {
    const onGranted = jest.fn();
    // Both the mount path and a concurrent resume see granted=true.
    mockedGetForeground.mockResolvedValue(makePermission({ status: 'granted' }));
    mockedGetCurrentPosition.mockResolvedValue(makePosition(0, 0));

    render(
      <LocationPermissionPrePrompt
        onGranted={onGranted}
        onZipSubmit={jest.fn()}
        onCancel={jest.fn()}
      />,
    );

    // Fire the AppState handler several times concurrently while the mount
    // path's promise chain may or may not have settled. The single-flight
    // guard must hold the line at exactly 1.
    await act(async () => {
      appStateChangeHandler?.('active');
      appStateChangeHandler?.('active');
      appStateChangeHandler?.('active');
    });
    await waitFor(() => expect(onGranted).toHaveBeenCalledTimes(1));
  });
});

describe('LocationPermissionPrePrompt — AppState resume', () => {
  it('re-queries permission on transition to active without firing requestForegroundPermissionsAsync', async () => {
    // Initial: denied permanently. After Settings change, get* returns granted.
    mockedGetForeground.mockResolvedValueOnce(
      makePermission({ status: 'denied', canAskAgain: false }),
    );
    mockedGetForeground.mockResolvedValueOnce(makePermission({ status: 'granted' }));
    mockedGetCurrentPosition.mockResolvedValue(makePosition(10, 20));

    const onGranted = jest.fn();
    render(
      <LocationPermissionPrePrompt
        onGranted={onGranted}
        onZipSubmit={jest.fn()}
        onCancel={jest.fn()}
      />,
    );

    await screen.findByText('Location blocked');

    // Simulate user grants in Settings then returns to the app.
    await act(async () => {
      appStateChangeHandler?.('active');
    });

    await waitFor(() =>
      expect(onGranted).toHaveBeenCalledWith({ latitude: 10, longitude: 20 }),
    );
    // The resume path must not call requestForegroundPermissionsAsync (would
    // burn the canAskAgain budget on a non-user-initiated event).
    expect(mockedRequestForeground).not.toHaveBeenCalled();
  });
});

describe('LocationPermissionPrePrompt — Android hardware back', () => {
  it('routes hardwareBackPress to onCancel and signals it was handled', async () => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
    mockedGetForeground.mockResolvedValue(makePermission({ status: 'undetermined' }));

    const onCancel = jest.fn();
    render(
      <LocationPermissionPrePrompt
        onGranted={jest.fn()}
        onZipSubmit={jest.fn()}
        onCancel={onCancel}
      />,
    );

    await screen.findByText('PlantCare wants your location');
    expect(backHandlerHandler).not.toBeNull();
    const handled = backHandlerHandler?.();
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(handled).toBe(true);
  });
});

describe('LocationPermissionPrePrompt — reduce-motion gate', () => {
  it('subscribes to reduceMotionChanged so future animations can read the value', async () => {
    mockedGetForeground.mockResolvedValue(makePermission({ status: 'undetermined' }));
    render(
      <LocationPermissionPrePrompt
        onGranted={jest.fn()}
        onZipSubmit={jest.fn()}
        onCancel={jest.fn()}
      />,
    );

    await screen.findByText('PlantCare wants your location');
    expect(AccessibilityInfo.addEventListener).toHaveBeenCalledWith(
      'reduceMotionChanged',
      expect.any(Function),
    );
    expect(AccessibilityInfo.isReduceMotionEnabled).toHaveBeenCalled();
  });
});

describe('LocationPermissionPrePrompt — theming', () => {
  it('uses Midnight Conservatory tokens when the theme is dark', async () => {
    mockedUseTheme.mockReturnValue(darkTheme);
    mockedGetForeground.mockResolvedValue(makePermission({ status: 'undetermined' }));

    render(
      <LocationPermissionPrePrompt
        onGranted={jest.fn()}
        onZipSubmit={jest.fn()}
        onCancel={jest.fn()}
        testID="loc-pre-prompt"
      />,
    );

    await screen.findByText('PlantCare wants your location');
    const card = screen.getByTestId('loc-pre-prompt');
    const style = Array.isArray(card.props.style)
      ? Object.assign({}, ...card.props.style)
      : card.props.style;
    expect(style.backgroundColor).toBe(darkTheme.colors.surface);
    expect(style.borderColor).toBe(darkTheme.colors.stroke);
  });
});

describe('LocationPermissionPrePrompt — accessibility', () => {
  it('marks the headline as a header and CTAs as buttons with accessible labels', async () => {
    mockedGetForeground.mockResolvedValue(makePermission({ status: 'undetermined' }));
    render(
      <LocationPermissionPrePrompt
        onGranted={jest.fn()}
        onZipSubmit={jest.fn()}
        onCancel={jest.fn()}
      />,
    );

    await screen.findByText('PlantCare wants your location');
    const headline = screen.getByRole('header');
    expect(headline).toHaveTextContent('PlantCare wants your location');

    const useLocation = screen.getByLabelText('Use my location');
    const zip = screen.getByLabelText('Enter ZIP instead');
    expect(useLocation.props.accessibilityRole).toBe('button');
    expect(zip.props.accessibilityRole).toBe('button');
  });

  it('marks the ZIP input with a 5-digit hint', async () => {
    mockedGetForeground.mockResolvedValue(makePermission({ status: 'undetermined' }));
    render(
      <LocationPermissionPrePrompt
        onGranted={jest.fn()}
        onZipSubmit={jest.fn()}
        onCancel={jest.fn()}
      />,
    );

    fireEvent.press(await screen.findByLabelText('Enter ZIP instead'));
    const input = screen.getByLabelText('ZIP code');
    expect(input.props.accessibilityHint).toBe('Enter a 5-digit US ZIP code');
  });
});
