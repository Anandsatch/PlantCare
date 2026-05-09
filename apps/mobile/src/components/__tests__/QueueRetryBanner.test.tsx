/**
 * Tests for QueueRetryBanner (E7-006).
 */
import { describe, expect, it, jest } from '@jest/globals';
import { darkTheme, lightTheme } from '@plantcare/theme';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { Animated } from 'react-native';

// Mock react-native's useColorScheme so useTheme() resolves deterministically.
jest.mock('react-native/Libraries/Utilities/useColorScheme', () => ({
  __esModule: true,
  default: jest.fn(() => 'light'),
}));

const mockReduceMotionState = { reduceMotion: false };
jest.mock('react-native/Libraries/Components/AccessibilityInfo/AccessibilityInfo', () => ({
  __esModule: true,
  default: {
    isReduceMotionEnabled: jest.fn(() => Promise.resolve(mockReduceMotionState.reduceMotion)),
    addEventListener: jest.fn(() => ({ remove: jest.fn() })),
  },
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const useColorSchemeMock = require('react-native/Libraries/Utilities/useColorScheme')
  .default as jest.MockedFunction<() => 'light' | 'dark' | null | undefined>;

import { QueueRetryBanner, QUEUE_RETRY_BANNER_COPY } from '../QueueRetryBanner';

beforeEach(() => {
  mockReduceMotionState.reduceMotion = false;
  useColorSchemeMock.mockReturnValue('light');
});

describe('QueueRetryBanner', () => {
  it('renders nothing when failedCount is 0', () => {
    const onRetry = jest.fn();
    const { toJSON } = render(<QueueRetryBanner failedCount={0} onRetry={onRetry} />);
    expect(toJSON()).toBeNull();
  });

  it('renders nothing when failedCount is negative (defensive)', () => {
    const onRetry = jest.fn();
    const { toJSON } = render(<QueueRetryBanner failedCount={-3} onRetry={onRetry} />);
    expect(toJSON()).toBeNull();
  });

  it('renders the banner when failedCount > 0', () => {
    const onRetry = jest.fn();
    render(<QueueRetryBanner failedCount={3} onRetry={onRetry} />);
    expect(screen.getByTestId('queue-retry-banner')).toBeTruthy();
  });

  it('shows the count in the banner message (plural)', () => {
    const onRetry = jest.fn();
    render(<QueueRetryBanner failedCount={3} onRetry={onRetry} />);
    expect(screen.queryByText('3 saved offline. Tap to retry.')).toBeTruthy();
  });

  it('uses singular copy when failedCount is 1', () => {
    const onRetry = jest.fn();
    render(<QueueRetryBanner failedCount={1} onRetry={onRetry} />);
    expect(screen.queryByText('1 saved offline. Tap to retry.')).toBeTruthy();
  });

  it('exposes the message + label builders for greppability', () => {
    expect(QUEUE_RETRY_BANNER_COPY.buildMessage(1)).toBe('1 saved offline. Tap to retry.');
    expect(QUEUE_RETRY_BANNER_COPY.buildMessage(5)).toBe('5 saved offline. Tap to retry.');
    expect(QUEUE_RETRY_BANNER_COPY.buildRetryLabel(1)).toBe('Retry 1 saved request');
    expect(QUEUE_RETRY_BANNER_COPY.buildRetryLabel(7)).toBe('Retry 7 saved requests');
  });

  it('tapping Retry calls onRetry exactly once', () => {
    const onRetry = jest.fn();
    render(<QueueRetryBanner failedCount={2} onRetry={onRetry} />);
    const ctaPressable = screen.getByLabelText('Retry 2 saved requests');
    fireEvent.press(ctaPressable);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('CTA accessibility label is count-aware (singular)', () => {
    const onRetry = jest.fn();
    render(<QueueRetryBanner failedCount={1} onRetry={onRetry} />);
    expect(screen.queryByLabelText('Retry 1 saved request')).toBeTruthy();
  });

  it('CTA label flips to "Retrying" while retrying=true', () => {
    const onRetry = jest.fn();
    render(<QueueRetryBanner failedCount={2} onRetry={onRetry} retrying />);
    expect(screen.queryByLabelText('Retrying')).toBeTruthy();
  });

  it('tapping Retry while retrying=true does NOT call onRetry (disabled at UI layer)', () => {
    const onRetry = jest.fn();
    render(<QueueRetryBanner failedCount={3} onRetry={onRetry} retrying />);
    const ctaPressable = screen.getByLabelText('Retrying');
    fireEvent.press(ctaPressable);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('CTA carries accessibilityState.disabled=true while retrying (codex P3)', () => {
    const onRetry = jest.fn();
    render(<QueueRetryBanner failedCount={3} onRetry={onRetry} retrying />);
    const ctaPressable = screen.getByLabelText('Retrying');
    // RN's Pressable surface normalizes accessibilityState into a full
    // shape (busy/checked/expanded/selected/disabled) — assert disabled
    // is true, ignore the other normalized fields.
    expect(ctaPressable.props.accessibilityState?.disabled).toBe(true);
  });

  it('CTA is enabled (disabled flag is falsy) while not retrying', () => {
    const onRetry = jest.fn();
    render(<QueueRetryBanner failedCount={3} onRetry={onRetry} />);
    const ctaPressable = screen.getByLabelText('Retry 3 saved requests');
    // Pressable always emits an accessibilityState shape; disabled must
    // be falsy (false/undefined) when the CTA is enabled.
    expect(ctaPressable.props.accessibilityState?.disabled).toBeFalsy();
  });

  it('inner ToastBanner has accessibilityRole=status (non-disruptive)', () => {
    const onRetry = jest.fn();
    render(<QueueRetryBanner failedCount={3} onRetry={onRetry} />);
    const toastView = screen.getByTestId('queue-retry-banner-toast');
    expect(toastView.props.accessibilityRole).toBe('status');
  });

  it('does not render any Animated.View at the banner top level (no entry animation)', () => {
    const onRetry = jest.fn();
    const tree = render(<QueueRetryBanner failedCount={3} onRetry={onRetry} />).toJSON();
    void Animated;
    function findAnimated(node: unknown): boolean {
      if (!node || typeof node !== 'object') return false;
      const n = node as { type?: string | { displayName?: string }; children?: unknown[] };
      if (typeof n.type === 'object' && n.type !== null) {
        const dn = (n.type as { displayName?: string }).displayName;
        if (dn && dn.startsWith('Animated')) return true;
      }
      if (Array.isArray(n.children)) {
        return n.children.some(findAnimated);
      }
      return false;
    }
    expect(findAnimated(tree)).toBe(false);
  });

  it('reduce-motion enabled: still renders (the banner has no animation to disable)', () => {
    mockReduceMotionState.reduceMotion = true;
    const onRetry = jest.fn();
    render(<QueueRetryBanner failedCount={3} onRetry={onRetry} />);
    expect(screen.getByTestId('queue-retry-banner')).toBeTruthy();
    expect(screen.queryByText('3 saved offline. Tap to retry.')).toBeTruthy();
  });

  it('dark theme: still renders banner shell with the toast role', () => {
    useColorSchemeMock.mockReturnValue('dark');
    const onRetry = jest.fn();
    render(<QueueRetryBanner failedCount={2} onRetry={onRetry} />);
    expect(screen.getByTestId('queue-retry-banner')).toBeTruthy();
    const toastView = screen.getByTestId('queue-retry-banner-toast');
    expect(toastView.props.accessibilityRole).toBe('status');
    void darkTheme;
    void lightTheme;
  });

  it('strict-mode-style double mount: renders the same banner without duplicating side effects', () => {
    const onRetry = jest.fn();
    const { unmount } = render(<QueueRetryBanner failedCount={2} onRetry={onRetry} />);
    expect(screen.getByTestId('queue-retry-banner')).toBeTruthy();
    unmount();

    render(<QueueRetryBanner failedCount={2} onRetry={onRetry} />);
    expect(screen.getByTestId('queue-retry-banner')).toBeTruthy();
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('accepts a custom testID for the wrapper', () => {
    const onRetry = jest.fn();
    render(<QueueRetryBanner failedCount={1} onRetry={onRetry} testID="custom-id" />);
    expect(screen.getByTestId('custom-id')).toBeTruthy();
    expect(screen.queryByTestId('queue-retry-banner')).toBeNull();
  });
});
