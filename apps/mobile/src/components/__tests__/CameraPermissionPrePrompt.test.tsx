import { darkTheme, lightTheme } from '@plantcare/theme';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Linking } from 'react-native';

// PermissionResponse is structurally re-exported from expo-camera, but the
// exact symbol lives in expo-modules-core which is a transitive dep. Declare
// the shape locally to avoid coupling to an internal package path.
type PermissionResponse = {
  status: 'granted' | 'denied' | 'undetermined';
  granted: boolean;
  canAskAgain: boolean;
  expires: 'never' | number;
};

// Mock expo-camera's permission hook so each test pins the permission snapshot
// + request behavior explicitly. We also stub Linking.openSettings — the real
// implementation tries to dispatch to a native module that doesn't exist under
// jest-expo's node test environment.
jest.mock('expo-camera', () => ({
  useCameraPermissions: jest.fn(),
}));

jest.spyOn(Linking, 'openSettings').mockImplementation(() => Promise.resolve());

// Mock useTheme so the dark-mode test can flip the theme deterministically
// without depending on RN's useColorScheme behavior under Jest.
jest.mock('../../hooks/useTheme', () => ({
  useTheme: jest.fn(),
}));

import { useCameraPermissions } from 'expo-camera';

import { CameraPermissionPrePrompt } from '../CameraPermissionPrePrompt';
import { useTheme } from '../../hooks/useTheme';

const mockedUseCameraPermissions = useCameraPermissions as jest.MockedFunction<typeof useCameraPermissions>;
const mockedUseTheme = useTheme as jest.MockedFunction<typeof useTheme>;
const mockedOpenSettings = Linking.openSettings as jest.MockedFunction<typeof Linking.openSettings>;

type RequestPermission = () => Promise<PermissionResponse>;
type GetPermission = () => Promise<PermissionResponse>;

const noopGet: GetPermission = () => Promise.resolve(makeResponse({ status: 'undetermined' }));

function makeResponse(overrides: {
  status: 'granted' | 'denied' | 'undetermined';
  granted?: boolean;
  canAskAgain?: boolean;
}): PermissionResponse {
  const granted = overrides.granted ?? overrides.status === 'granted';
  // canAskAgain defaults: granted/undetermined → true; denied → true unless
  // explicitly overridden (the iOS "Don't Allow" path sets it to false).
  const canAskAgain = overrides.canAskAgain ?? overrides.status !== 'denied' ? true : false;
  return {
    // PermissionStatus is a string-valued enum; the literal value matches.
    status: overrides.status as PermissionResponse['status'],
    granted,
    canAskAgain: overrides.canAskAgain ?? (overrides.status === 'denied' ? false : true),
    expires: 'never',
  };
}

function setPermissionHook(
  permission: PermissionResponse | null,
  request: RequestPermission,
): void {
  // Hook return shape: [permission, requestPermission, getPermission]. Cast
  // through unknown because expo-modules-core types `status` as a real enum
  // member while we keep tests free of the runtime enum import.
  mockedUseCameraPermissions.mockReturnValue([permission, request, noopGet] as unknown as ReturnType<typeof useCameraPermissions>);
}

beforeEach(() => {
  mockedUseCameraPermissions.mockReset();
  mockedUseTheme.mockReturnValue(lightTheme);
  mockedOpenSettings.mockClear();
});

describe('CameraPermissionPrePrompt — initial render', () => {
  it('renders the cream pre-prompt in idle state with headline + body + CTAs', () => {
    setPermissionHook(makeResponse({ status: 'undetermined' }), jest.fn());
    render(<CameraPermissionPrePrompt onGranted={jest.fn()} onCancel={jest.fn()} testID="pre-prompt" />);

    expect(screen.getByText('PlantCare wants your camera')).toBeOnTheScreen();
    expect(
      screen.getByText(
        /To identify and diagnose your plants from photos\. We never upload anything you don.t ask us to\./,
      ),
    ).toBeOnTheScreen();
    expect(screen.getByLabelText('Allow camera access')).toBeOnTheScreen();
    expect(screen.getByLabelText('Not now')).toBeOnTheScreen();
    expect(screen.getByTestId('pre-prompt')).toBeOnTheScreen();
  });

  it('does not flash the OS dialog before the user taps the CTA', () => {
    const requestPermission = jest.fn();
    setPermissionHook(makeResponse({ status: 'undetermined' }), requestPermission);
    render(<CameraPermissionPrePrompt onGranted={jest.fn()} onCancel={jest.fn()} />);

    expect(requestPermission).not.toHaveBeenCalled();
  });
});

describe('CameraPermissionPrePrompt — already-granted on mount', () => {
  it('fires onGranted and renders nothing when permission is already granted', async () => {
    const onGranted = jest.fn();
    setPermissionHook(makeResponse({ status: 'granted' }), jest.fn());
    render(<CameraPermissionPrePrompt onGranted={onGranted} onCancel={jest.fn()} testID="pre-prompt" />);

    await waitFor(() => expect(onGranted).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('PlantCare wants your camera')).toBeNull();
    expect(screen.queryByTestId('pre-prompt')).toBeNull();
  });

  it('does not flash the cream pre-prompt when the hook returns null then resolves to granted', async () => {
    // Models expo-camera's actual behavior: useCameraPermissions returns null
    // on the first render, then a real PermissionResponse on a later render.
    // First render must NOT show the cream pre-prompt for an already-granted
    // user (codex P2 from E5-003 adversarial review).
    const onGranted = jest.fn();
    setPermissionHook(null, jest.fn());
    const { rerender } = render(
      <CameraPermissionPrePrompt onGranted={onGranted} onCancel={jest.fn()} testID="pre-prompt" />,
    );

    expect(screen.queryByText('PlantCare wants your camera')).toBeNull();
    expect(screen.queryByTestId('pre-prompt')).toBeNull();

    setPermissionHook(makeResponse({ status: 'granted' }), jest.fn());
    rerender(<CameraPermissionPrePrompt onGranted={onGranted} onCancel={jest.fn()} testID="pre-prompt" />);

    await waitFor(() => expect(onGranted).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('PlantCare wants your camera')).toBeNull();
  });

  it('shows the cream pre-prompt once the hook resolves to undetermined', async () => {
    setPermissionHook(null, jest.fn());
    const { rerender } = render(
      <CameraPermissionPrePrompt onGranted={jest.fn()} onCancel={jest.fn()} />,
    );

    expect(screen.queryByText('PlantCare wants your camera')).toBeNull();

    setPermissionHook(makeResponse({ status: 'undetermined' }), jest.fn());
    rerender(<CameraPermissionPrePrompt onGranted={jest.fn()} onCancel={jest.fn()} />);

    await screen.findByText('PlantCare wants your camera');
  });
});

describe('CameraPermissionPrePrompt — already permanently denied on mount', () => {
  it('renders the denied state with Open Settings CTA', async () => {
    setPermissionHook(
      makeResponse({ status: 'denied', canAskAgain: false }),
      jest.fn(),
    );
    render(<CameraPermissionPrePrompt onGranted={jest.fn()} onCancel={jest.fn()} />);

    await screen.findByText('Camera blocked');
    expect(screen.getByLabelText(/Open the Settings app to enable camera access/)).toBeOnTheScreen();
    // Cream pre-prompt must not be on screen simultaneously.
    expect(screen.queryByText('PlantCare wants your camera')).toBeNull();
  });
});

describe('CameraPermissionPrePrompt — request flow', () => {
  it('calls requestPermission exactly once when CTA is tapped', async () => {
    const requestPermission = jest.fn().mockResolvedValue(
      makeResponse({ status: 'granted' }),
    );
    setPermissionHook(makeResponse({ status: 'undetermined' }), requestPermission);
    render(<CameraPermissionPrePrompt onGranted={jest.fn()} onCancel={jest.fn()} />);

    fireEvent.press(screen.getByLabelText('Allow camera access'));
    await waitFor(() => expect(requestPermission).toHaveBeenCalledTimes(1));
  });

  it('transitions to granted and fires onGranted when request resolves granted=true', async () => {
    const onGranted = jest.fn();
    const requestPermission = jest.fn().mockResolvedValue(
      makeResponse({ status: 'granted' }),
    );
    setPermissionHook(makeResponse({ status: 'undetermined' }), requestPermission);
    render(<CameraPermissionPrePrompt onGranted={onGranted} onCancel={jest.fn()} />);

    fireEvent.press(screen.getByLabelText('Allow camera access'));
    await waitFor(() => expect(onGranted).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('PlantCare wants your camera')).toBeNull();
  });

  it('returns to idle when user dismisses dialog (granted=false, canAskAgain=true)', async () => {
    const onGranted = jest.fn();
    const requestPermission = jest.fn().mockResolvedValue(
      makeResponse({ status: 'undetermined', granted: false, canAskAgain: true }),
    );
    setPermissionHook(makeResponse({ status: 'undetermined' }), requestPermission);
    render(<CameraPermissionPrePrompt onGranted={onGranted} onCancel={jest.fn()} />);

    fireEvent.press(screen.getByLabelText('Allow camera access'));
    await waitFor(() => expect(requestPermission).toHaveBeenCalled());
    // Pre-prompt is still visible — user can try again.
    await screen.findByText('PlantCare wants your camera');
    expect(onGranted).not.toHaveBeenCalled();
  });

  it('jumps to denied state when request returns granted=false, canAskAgain=false', async () => {
    const requestPermission = jest.fn().mockResolvedValue(
      makeResponse({ status: 'denied', canAskAgain: false }),
    );
    setPermissionHook(makeResponse({ status: 'undetermined' }), requestPermission);
    render(<CameraPermissionPrePrompt onGranted={jest.fn()} onCancel={jest.fn()} />);

    fireEvent.press(screen.getByLabelText('Allow camera access'));
    await screen.findByText('Camera blocked');
    expect(screen.queryByText('PlantCare wants your camera')).toBeNull();
  });

  it('shows a spinner and disables the CTA while the request is in flight', async () => {
    let resolveRequest!: (response: PermissionResponse) => void;
    const requestPermission = jest.fn().mockImplementation(
      () =>
        new Promise<PermissionResponse>((resolve) => {
          resolveRequest = resolve;
        }),
    );
    setPermissionHook(makeResponse({ status: 'undetermined' }), requestPermission);
    render(<CameraPermissionPrePrompt onGranted={jest.fn()} onCancel={jest.fn()} />);

    fireEvent.press(screen.getByLabelText('Allow camera access'));

    await waitFor(() => {
      const cta = screen.getByLabelText('Allow camera access');
      expect(cta.props.accessibilityState).toEqual(expect.objectContaining({ disabled: true, busy: true }));
    });
    expect(screen.getByTestId('camera-pre-prompt-spinner')).toBeOnTheScreen();

    // Resolve so the test exits cleanly.
    await act(async () => {
      resolveRequest(makeResponse({ status: 'granted' }));
    });
  });

  it('falls back to idle if requestPermission rejects', async () => {
    const onGranted = jest.fn();
    const requestPermission = jest.fn().mockRejectedValue(new Error('os hiccup'));
    setPermissionHook(makeResponse({ status: 'undetermined' }), requestPermission);
    render(<CameraPermissionPrePrompt onGranted={onGranted} onCancel={jest.fn()} />);

    fireEvent.press(screen.getByLabelText('Allow camera access'));
    await waitFor(() => expect(requestPermission).toHaveBeenCalled());
    // Stays on the cream pre-prompt; user can retry.
    await screen.findByText('PlantCare wants your camera');
    expect(onGranted).not.toHaveBeenCalled();
  });
});

describe('CameraPermissionPrePrompt — denied recovery', () => {
  it('opens the Settings app when Open Settings is tapped', async () => {
    setPermissionHook(
      makeResponse({ status: 'denied', canAskAgain: false }),
      jest.fn(),
    );
    render(<CameraPermissionPrePrompt onGranted={jest.fn()} onCancel={jest.fn()} />);

    await screen.findByText('Camera blocked');
    fireEvent.press(screen.getByLabelText(/Open the Settings app to enable camera access/));

    expect(mockedOpenSettings).toHaveBeenCalledTimes(1);
  });
});

describe('CameraPermissionPrePrompt — cancel', () => {
  it('fires onCancel and never triggers the OS dialog', () => {
    const requestPermission = jest.fn();
    const onCancel = jest.fn();
    setPermissionHook(makeResponse({ status: 'undetermined' }), requestPermission);
    render(<CameraPermissionPrePrompt onGranted={jest.fn()} onCancel={onCancel} />);

    fireEvent.press(screen.getByLabelText('Not now'));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(requestPermission).not.toHaveBeenCalled();
  });
});

describe('CameraPermissionPrePrompt — theming', () => {
  it('uses Midnight Conservatory tokens when the theme is dark', () => {
    mockedUseTheme.mockReturnValue(darkTheme);
    setPermissionHook(makeResponse({ status: 'undetermined' }), jest.fn());
    render(<CameraPermissionPrePrompt onGranted={jest.fn()} onCancel={jest.fn()} testID="pre-prompt" />);

    const card = screen.getByTestId('pre-prompt');
    // Verify the dark surface/stroke tokens flow through to the rendered styles.
    const style = Array.isArray(card.props.style) ? Object.assign({}, ...card.props.style) : card.props.style;
    expect(style.backgroundColor).toBe(darkTheme.colors.surface);
    expect(style.borderColor).toBe(darkTheme.colors.stroke);
  });
});

describe('CameraPermissionPrePrompt — accessibility', () => {
  it('marks the headline as a header and CTAs as buttons with accessible labels', () => {
    setPermissionHook(makeResponse({ status: 'undetermined' }), jest.fn());
    render(<CameraPermissionPrePrompt onGranted={jest.fn()} onCancel={jest.fn()} />);

    const headline = screen.getByRole('header');
    expect(headline).toHaveTextContent('PlantCare wants your camera');

    const allow = screen.getByLabelText('Allow camera access');
    const cancel = screen.getByLabelText('Not now');
    expect(allow.props.accessibilityRole).toBe('button');
    expect(cancel.props.accessibilityRole).toBe('button');
  });

  it('marks the Open Settings CTA with a Settings-app-specific accessibilityLabel', async () => {
    setPermissionHook(
      makeResponse({ status: 'denied', canAskAgain: false }),
      jest.fn(),
    );
    render(<CameraPermissionPrePrompt onGranted={jest.fn()} onCancel={jest.fn()} />);

    await screen.findByText('Camera blocked');
    const openSettings = screen.getByLabelText('Open the Settings app to enable camera access');
    expect(openSettings.props.accessibilityRole).toBe('button');
  });
});
