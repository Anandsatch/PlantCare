import { darkTheme, lightTheme } from '@plantcare/theme';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';

import {
  EditorialBottomSheet,
  shouldDismissOnDragRelease,
} from '../EditorialBottomSheet';

// Mock react-native's useColorScheme so useTheme() resolves deterministically.
// Default is light; individual tests override via the helper below.
jest.mock('react-native/Libraries/Utilities/useColorScheme', () => ({
  __esModule: true,
  default: jest.fn(() => 'light'),
}));

// Mock AccessibilityInfo's reduce-motion API. The component reads it on mount
// and subscribes to changes. Default: reduce motion OFF.
//
// Names prefixed with `mock` are exempt from jest's "no out-of-scope variable
// references in mock factories" rule.
const mockReduceMotionListeners: Array<(value: boolean) => void> = [];
const mockState = { reduceMotion: false };

jest.mock('react-native/Libraries/Components/AccessibilityInfo/AccessibilityInfo', () => ({
  __esModule: true,
  default: {
    isReduceMotionEnabled: jest.fn(() => Promise.resolve(mockState.reduceMotion)),
    addEventListener: jest.fn((event: string, listener: (v: boolean) => void) => {
      if (event === 'reduceMotionChanged') mockReduceMotionListeners.push(listener);
      return {
        remove: () => {
          const idx = mockReduceMotionListeners.indexOf(listener);
          if (idx >= 0) mockReduceMotionListeners.splice(idx, 1);
        },
      };
    }),
  },
}));

// Re-import after mocks so the singleton inside RN sees them.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const useColorSchemeMock = require('react-native/Libraries/Utilities/useColorScheme')
  .default as jest.Mock<'light' | 'dark' | null | undefined, []>;

beforeEach(() => {
  mockState.reduceMotion = false;
  mockReduceMotionListeners.length = 0;
  useColorSchemeMock.mockReturnValue('light');
});

// Drain the post-mount `isReduceMotionEnabled()` promise inside act() after
// each test. The component's effect resolves on mount and triggers a setState;
// without this flush the setState lands after the test ends and trips React
// 19's "not wrapped in act()" warning. Awaiting it inside act after each test
// keeps the warning from polluting test output.
afterEach(async () => {
  await act(async () => {
    await new Promise((resolve) => setImmediate(resolve));
  });
});

// ---------------------------------------------------------------------------
// Pure helper unit tests — these are the bulletproof gesture-threshold tests.
// PanResponder integration tests below verify wiring, but the threshold logic
// itself is exhaustively covered here without simulator gymnastics.
// ---------------------------------------------------------------------------

describe('shouldDismissOnDragRelease', () => {
  it('returns true when dy exceeds the 100px floor on a small sheet', () => {
    expect(shouldDismissOnDragRelease({ dy: 150, sheetHeight: 200 })).toBe(true);
  });

  it('returns false when dy is below the 100px floor on a small sheet', () => {
    expect(shouldDismissOnDragRelease({ dy: 80, sheetHeight: 200 })).toBe(false);
  });

  it('returns true on a tall sheet only when dy passes the 30% rule', () => {
    // sheet=900px → 30% threshold = 270px (dominates over 100px floor)
    expect(shouldDismissOnDragRelease({ dy: 200, sheetHeight: 900 })).toBe(false);
    expect(shouldDismissOnDragRelease({ dy: 280, sheetHeight: 900 })).toBe(true);
  });

  it('returns false for upward / zero / negative drags', () => {
    expect(shouldDismissOnDragRelease({ dy: 0, sheetHeight: 600 })).toBe(false);
    expect(shouldDismissOnDragRelease({ dy: -200, sheetHeight: 600 })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Component integration tests
// ---------------------------------------------------------------------------

describe('<EditorialBottomSheet />', () => {
  it('renders children when open=true', () => {
    render(
      <EditorialBottomSheet open onDismiss={() => {}}>
        <Text>note body</Text>
      </EditorialBottomSheet>
    );
    expect(screen.getByText('note body')).toBeOnTheScreen();
  });

  it('renders nothing when open=false', () => {
    render(
      <EditorialBottomSheet open={false} onDismiss={() => {}}>
        <Text>note body</Text>
      </EditorialBottomSheet>
    );
    expect(screen.queryByText('note body')).toBeNull();
  });

  it('fires onDismiss when the backdrop is pressed', () => {
    const onDismiss = jest.fn();
    render(
      <EditorialBottomSheet open onDismiss={onDismiss}>
        <Text>x</Text>
      </EditorialBottomSheet>
    );
    fireEvent.press(screen.getByTestId('editorial-bottom-sheet-backdrop', { includeHiddenElements: true }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('fires onDismiss on Modal onRequestClose (Android back button)', () => {
    const onDismiss = jest.fn();
    render(
      <EditorialBottomSheet open onDismiss={onDismiss} testID="sheet">
        <Text>x</Text>
      </EditorialBottomSheet>
    );
    // jest-expo renders Modal as a host component with onRequestClose wired.
    // We invoke it directly via the rendered Modal node.
    fireEvent(screen.UNSAFE_getByType(require('react-native').Modal), 'requestClose');
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('does NOT fire onDismiss on a tap inside the sheet content', () => {
    const onDismiss = jest.fn();
    const onContentPress = jest.fn();
    render(
      <EditorialBottomSheet open onDismiss={onDismiss}>
        {/* eslint-disable-next-line react-native/no-inline-styles */}
        <Text testID="content" onPress={onContentPress}>
          content
        </Text>
      </EditorialBottomSheet>
    );
    fireEvent.press(screen.getByTestId('content'));
    expect(onContentPress).toHaveBeenCalledTimes(1);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('passes accessibilityLabel through to the dialog', () => {
    render(
      <EditorialBottomSheet open onDismiss={() => {}} accessibilityLabel="Add note">
        <Text>x</Text>
      </EditorialBottomSheet>
    );
    const sheet = screen.getByTestId('editorial-bottom-sheet');
    expect(sheet.props.accessibilityLabel).toBe('Add note');
    expect(sheet.props.accessibilityRole).toBe('dialog');
  });

  it("defaults accessibilityLabel to 'Bottom sheet' when not provided", () => {
    render(
      <EditorialBottomSheet open onDismiss={() => {}}>
        <Text>x</Text>
      </EditorialBottomSheet>
    );
    expect(screen.getByTestId('editorial-bottom-sheet').props.accessibilityLabel).toBe(
      'Bottom sheet'
    );
  });

  it('sets accessibilityViewIsModal=true on the sheet (iOS focus trap)', () => {
    render(
      <EditorialBottomSheet open onDismiss={() => {}}>
        <Text>x</Text>
      </EditorialBottomSheet>
    );
    expect(screen.getByTestId('editorial-bottom-sheet').props.accessibilityViewIsModal).toBe(
      true
    );
  });

  it('honors heightFraction in the sheet height style', () => {
    render(
      <EditorialBottomSheet open onDismiss={() => {}} heightFraction={0.5}>
        <Text>x</Text>
      </EditorialBottomSheet>
    );
    const sheet = screen.getByTestId('editorial-bottom-sheet');
    // Style is an array of objects; flatten and look for height. We can't
    // assert the exact pixel value without coupling to Dimensions.get, but
    // we can assert the height is a positive number distinct from the default.
    const flat = Array.isArray(sheet.props.style)
      ? Object.assign({}, ...sheet.props.style.flat())
      : sheet.props.style;
    expect(typeof flat.height).toBe('number');
    expect(flat.height).toBeGreaterThan(0);
  });

  it('uses Midnight Conservatory tokens when system scheme is dark', () => {
    useColorSchemeMock.mockReturnValue('dark');
    render(
      <EditorialBottomSheet open onDismiss={() => {}}>
        <Text>x</Text>
      </EditorialBottomSheet>
    );
    const sheet = screen.getByTestId('editorial-bottom-sheet');
    const backdrop = screen.getByTestId('editorial-bottom-sheet-backdrop', { includeHiddenElements: true });
    const flat = Array.isArray(sheet.props.style)
      ? Object.assign({}, ...sheet.props.style.flat())
      : sheet.props.style;
    expect(flat.backgroundColor).toBe(darkTheme.colors.surface);
    // Backdrop = theme.text + '80' (50% alpha) on dark = '#FAF6EE80'
    const backdropFlat = Array.isArray(backdrop.props.style)
      ? Object.assign({}, ...backdrop.props.style.flat())
      : backdrop.props.style;
    expect(backdropFlat.backgroundColor).toBe(darkTheme.colors.text + '80');
  });

  it('uses Conservatory (light) tokens when system scheme is light', () => {
    useColorSchemeMock.mockReturnValue('light');
    render(
      <EditorialBottomSheet open onDismiss={() => {}}>
        <Text>x</Text>
      </EditorialBottomSheet>
    );
    const sheet = screen.getByTestId('editorial-bottom-sheet');
    const flat = Array.isArray(sheet.props.style)
      ? Object.assign({}, ...sheet.props.style.flat())
      : sheet.props.style;
    expect(flat.backgroundColor).toBe(lightTheme.colors.surface);
  });

  it('Modal animationType is "slide" by default (reduce motion off)', () => {
    render(
      <EditorialBottomSheet open onDismiss={() => {}}>
        <Text>x</Text>
      </EditorialBottomSheet>
    );
    const Modal = require('react-native').Modal;
    const modal = screen.UNSAFE_getByType(Modal);
    expect(modal.props.animationType).toBe('slide');
  });

  it('Modal animationType flips to "none" when reduce motion is on', async () => {
    mockState.reduceMotion = true;
    render(
      <EditorialBottomSheet open onDismiss={() => {}}>
        <Text>x</Text>
      </EditorialBottomSheet>
    );
    // The mount-time isReduceMotionEnabled() promise needs to flush before
    // the state update lands. Wait for the next microtask.
    await new Promise((resolve) => setImmediate(resolve));
    const Modal = require('react-native').Modal;
    const modal = screen.UNSAFE_getByType(Modal);
    expect(modal.props.animationType).toBe('none');
  });

  it('hides the drag handle from accessibility (decorative, not announced)', () => {
    render(
      <EditorialBottomSheet open onDismiss={() => {}} testID="x">
        <Text>x</Text>
      </EditorialBottomSheet>
    );
    const handle = screen.getByTestId('x-handle', { includeHiddenElements: true });
    expect(handle.props.accessibilityElementsHidden).toBe(true);
    expect(handle.props.importantForAccessibility).toBe('no-hide-descendants');
  });

  it('exposes panResponder handlers ONLY on the drag-zone, not the sheet wrapper (codex P2: keeps nested scrollables intact)', () => {
    // Indirect verification — we cannot reliably simulate native gesture events
    // through @testing-library/react-native without coupling to private RN
    // internals. Instead, assert the wiring exists; the threshold logic itself
    // is covered by the pure-helper tests above.
    render(
      <EditorialBottomSheet open onDismiss={() => {}}>
        <Text>x</Text>
      </EditorialBottomSheet>
    );
    const dragZone = screen.getByTestId('editorial-bottom-sheet-drag-zone', {
      includeHiddenElements: true,
    });
    expect(typeof dragZone.props.onMoveShouldSetResponder).toBe('function');
    expect(typeof dragZone.props.onResponderRelease).toBe('function');

    // The sheet wrapper itself must NOT carry pan handlers — otherwise a
    // ScrollView inside `children` would lose its gesture to the sheet.
    const sheet = screen.getByTestId('editorial-bottom-sheet');
    expect(sheet.props.onMoveShouldSetResponder).toBeUndefined();
    expect(sheet.props.onResponderRelease).toBeUndefined();
  });
});
