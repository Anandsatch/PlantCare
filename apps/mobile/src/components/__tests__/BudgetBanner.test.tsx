/**
 * BudgetBanner tests — E11-006.
 *
 * Coverage targets:
 *   - Default (used < 40) → returns null (no banner mounted at all)
 *   - Approaching (40 <= used < 50) → "Approaching daily limit — N/50 used today."
 *   - Hard limit (used >= 50) → "Daily LLM limit reached. Resets at midnight UTC."
 *   - Boundary: used = 39 → null; used = 40 → approaching; used = 49 → approaching;
 *     used = 50 → reached; used = 51 → reached (>= not ===).
 *   - Dark theme tokens swap (token swap inherited from ToastBanner; verified
 *     by snapshotting the rendered text in both modes — no theme.warn / no
 *     custom token used).
 *   - Reduce-motion compliance — the warn variant has no entry animation,
 *     so reduce-motion is structurally honored. Test both reduce-motion=true
 *     and reduce-motion=false render the same content + accessibility
 *     surface.
 *   - A11y — accessibilityRole='alert' (inherited from ToastBanner type='warn'
 *     mapping per E2-012 / E10-001).
 *   - Persistent — autoDismissMs={0} → no timer fires; the banner stays.
 *   - resolveBudgetBannerCopy is exported and pure.
 */
import { darkTheme, lightTheme } from '@plantcare/theme';
import { act, render, screen } from '@testing-library/react-native';

import { BudgetBanner, resolveBudgetBannerCopy } from '../BudgetBanner';
import { LLM_BUDGET_HARD_THRESHOLD, LLM_BUDGET_LOW_THRESHOLD, LLM_DAILY_LIMIT } from '../../lib/constants';

// ─── Mocks ──────────────────────────────────────────────────────────────

jest.mock('react-native/Libraries/Utilities/useColorScheme', () => ({
  __esModule: true,
  default: jest.fn(() => 'light'),
}));

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

// eslint-disable-next-line @typescript-eslint/no-require-imports
const useColorSchemeMock = require('react-native/Libraries/Utilities/useColorScheme')
  .default as jest.Mock<'light' | 'dark' | null | undefined, []>;

beforeEach(() => {
  mockState.reduceMotion = false;
  mockReduceMotionListeners.length = 0;
  useColorSchemeMock.mockReturnValue('light');
  jest.useFakeTimers();
});

afterEach(async () => {
  // Drain pending timers + async effects before restoring.
  await act(async () => {
    jest.runOnlyPendingTimers();
    await Promise.resolve();
  });
  jest.useRealTimers();
});

// ─── Pure-helper tests ──────────────────────────────────────────────────

describe('resolveBudgetBannerCopy (pure)', () => {
  it('returns null below the low threshold', () => {
    expect(resolveBudgetBannerCopy(0)).toBeNull();
    expect(resolveBudgetBannerCopy(LLM_BUDGET_LOW_THRESHOLD - 1)).toBeNull();
  });

  it('returns approaching copy at the low threshold (boundary lock)', () => {
    expect(resolveBudgetBannerCopy(LLM_BUDGET_LOW_THRESHOLD)).toBe(
      `Approaching daily limit — ${LLM_BUDGET_LOW_THRESHOLD}/${LLM_DAILY_LIMIT} used today.`,
    );
  });

  it('returns approaching copy through the high boundary minus one', () => {
    expect(resolveBudgetBannerCopy(LLM_BUDGET_HARD_THRESHOLD - 1)).toBe(
      `Approaching daily limit — ${LLM_BUDGET_HARD_THRESHOLD - 1}/${LLM_DAILY_LIMIT} used today.`,
    );
  });

  it('returns reached copy at the hard threshold', () => {
    expect(resolveBudgetBannerCopy(LLM_BUDGET_HARD_THRESHOLD)).toBe(
      'Daily LLM limit reached. Resets at midnight UTC.',
    );
  });

  it('returns reached copy ABOVE the hard threshold (>= not ===)', () => {
    // Codex risk #2 lock: a 51st row landing in the table must still
    // render the reached state. `===` would silently re-enable.
    expect(resolveBudgetBannerCopy(LLM_BUDGET_HARD_THRESHOLD + 1)).toBe(
      'Daily LLM limit reached. Resets at midnight UTC.',
    );
    expect(resolveBudgetBannerCopy(99)).toBe(
      'Daily LLM limit reached. Resets at midnight UTC.',
    );
  });
});

// ─── Render tests ───────────────────────────────────────────────────────

describe('BudgetBanner — render', () => {
  it('renders nothing when used < 40', () => {
    const { queryByTestId, toJSON } = render(<BudgetBanner used={39} />);
    expect(queryByTestId('budget-banner')).toBeNull();
    expect(toJSON()).toBeNull();
  });

  it('renders approaching copy at used = 40 (boundary)', () => {
    render(<BudgetBanner used={40} />);
    expect(
      screen.getByText('Approaching daily limit — 40/50 used today.'),
    ).toBeTruthy();
  });

  it('renders approaching copy at used = 49', () => {
    render(<BudgetBanner used={49} />);
    expect(
      screen.getByText('Approaching daily limit — 49/50 used today.'),
    ).toBeTruthy();
  });

  it('renders reached copy at used = 50', () => {
    render(<BudgetBanner used={50} />);
    expect(
      screen.getByText('Daily LLM limit reached. Resets at midnight UTC.'),
    ).toBeTruthy();
  });

  it('renders reached copy at used = 51 (>= not ===)', () => {
    render(<BudgetBanner used={51} />);
    expect(
      screen.getByText('Daily LLM limit reached. Resets at midnight UTC.'),
    ).toBeTruthy();
  });

  it('respects custom limit override (forward-compat)', () => {
    render(<BudgetBanner used={42} limit={100} />);
    expect(
      screen.getByText('Approaching daily limit — 42/100 used today.'),
    ).toBeTruthy();
  });

  it('uses provided testID; defaults to "budget-banner"', () => {
    const { rerender } = render(<BudgetBanner used={45} />);
    expect(screen.getByTestId('budget-banner')).toBeTruthy();
    rerender(<BudgetBanner used={45} testID="x-banner" />);
    expect(screen.getByTestId('x-banner')).toBeTruthy();
  });
});

// ─── Persistence (autoDismissMs=0) ─────────────────────────────────────

describe('BudgetBanner — persistent (no auto-dismiss)', () => {
  it('does not unmount itself after the default warn auto-dismiss interval', () => {
    render(<BudgetBanner used={45} />);
    expect(screen.getByText(/Approaching daily limit/)).toBeTruthy();
    // The default warn auto-dismiss is 4000ms; advance well past.
    act(() => {
      jest.advanceTimersByTime(10_000);
    });
    expect(screen.getByText(/Approaching daily limit/)).toBeTruthy();
  });
});

// ─── A11y ──────────────────────────────────────────────────────────────

describe('BudgetBanner — a11y', () => {
  it('exposes accessibilityRole=alert (warn semantic from ToastBanner)', () => {
    render(<BudgetBanner used={50} />);
    // ToastBanner type='warn' resolves accessibilityRole='alert'.
    // Same query pattern as ToastBanner.test.tsx — props inspection
    // because RNTL's getByRole doesn't reliably match the bridged
    // 'alert' role across RN platforms.
    expect(screen.getByTestId('budget-banner').props.accessibilityRole).toBe(
      'alert',
    );
  });

  it('exposes accessibilityRole=alert in approaching state too', () => {
    render(<BudgetBanner used={42} />);
    expect(screen.getByTestId('budget-banner').props.accessibilityRole).toBe(
      'alert',
    );
  });
});

// ─── Reduce-motion ─────────────────────────────────────────────────────

describe('BudgetBanner — reduce-motion', () => {
  it('renders identical content with reduce-motion enabled', () => {
    mockState.reduceMotion = true;
    render(<BudgetBanner used={50} />);
    // The warn variant initializes pulseOpacity at end-state and
    // skips Animated.timing — see ToastBanner header. The banner
    // still mounts immediately and content is unchanged. There is
    // no entry animation to gate.
    expect(
      screen.getByText('Daily LLM limit reached. Resets at midnight UTC.'),
    ).toBeTruthy();
    expect(screen.getByTestId('budget-banner').props.accessibilityRole).toBe(
      'alert',
    );
  });
});

// ─── Dark theme ────────────────────────────────────────────────────────

describe('BudgetBanner — dark theme', () => {
  it('renders content unchanged in dark mode (token swap is in primitive)', () => {
    useColorSchemeMock.mockReturnValue('dark');
    render(<BudgetBanner used={42} />);
    // Tan accent is theme-invariant per DESIGN.md (Wave 1 E10-001
    // codex catch); the deep-ink text token is locked at #2A2A2A.
    // We don't snapshot styles here (the primitive's tests cover
    // that); we verify the banner still mounts + speaks the same
    // content + role.
    expect(
      screen.getByText('Approaching daily limit — 42/50 used today.'),
    ).toBeTruthy();
    expect(screen.getByTestId('budget-banner').props.accessibilityRole).toBe(
      'alert',
    );
  });

  it('does not crash on darkTheme / lightTheme token shape (compile-time guard)', () => {
    // Lock that we never reach for theme.warn — the token doesn't
    // exist. Asserting absence at test time guards against a future
    // edit that introduces it without verifying DESIGN.md.
    expect((lightTheme.colors as Record<string, unknown>).warn).toBeUndefined();
    expect((darkTheme.colors as Record<string, unknown>).warn).toBeUndefined();
  });
});
