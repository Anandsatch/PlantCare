import { darkTheme, lightTheme } from '@plantcare/theme';
import { act, fireEvent, render, screen } from '@testing-library/react-native';

import {
  EditPlantDetailsSheet,
  HELPER_COPY,
  MAX_INTERVAL_DAYS,
  MIN_INTERVAL_DAYS,
  parseIntervalInput,
  VALIDATION_COPY,
} from '../EditPlantDetailsSheet';

// Mock useColorScheme so useTheme() resolves deterministically.
jest.mock('react-native/Libraries/Utilities/useColorScheme', () => ({
  __esModule: true,
  default: jest.fn(() => 'light'),
}));

// Mock AccessibilityInfo so EditorialBottomSheet's reduce-motion mount effect
// resolves cleanly. Names prefixed with `mock` are exempt from jest's
// "no out-of-scope variable references in mock factories" rule.
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
});

// Drain the post-mount `isReduceMotionEnabled()` promise inside act() after
// each test. Mirrors the EditorialBottomSheet test suite — without this flush,
// the trailing setState lands after the test ends and trips React 19's
// "not wrapped in act()" warning.
afterEach(async () => {
  await act(async () => {
    await new Promise((resolve) => setImmediate(resolve));
  });
});

// ---------------------------------------------------------------------------
// Pure helper unit tests — exhaustive validation coverage without a render.
// ---------------------------------------------------------------------------

describe('parseIntervalInput', () => {
  it('treats blank as valid + null (use the default)', () => {
    expect(parseIntervalInput('')).toEqual({ valid: true, value: null });
    expect(parseIntervalInput('   ')).toEqual({ valid: true, value: null });
  });

  it('accepts integers in [1, 365]', () => {
    expect(parseIntervalInput('1')).toEqual({ valid: true, value: MIN_INTERVAL_DAYS });
    expect(parseIntervalInput('14')).toEqual({ valid: true, value: 14 });
    expect(parseIntervalInput('365')).toEqual({ valid: true, value: MAX_INTERVAL_DAYS });
  });

  it('trims whitespace before parsing', () => {
    expect(parseIntervalInput('  7  ')).toEqual({ valid: true, value: 7 });
  });

  it('rejects values out of [1, 365]', () => {
    expect(parseIntervalInput('0')).toEqual({ valid: false });
    expect(parseIntervalInput('366')).toEqual({ valid: false });
    expect(parseIntervalInput('999')).toEqual({ valid: false });
  });

  it('rejects decimals (".", "1.5", "365.0", "365.99")', () => {
    expect(parseIntervalInput('1.5')).toEqual({ valid: false });
    expect(parseIntervalInput('365.0')).toEqual({ valid: false });
    expect(parseIntervalInput('365.99')).toEqual({ valid: false });
    expect(parseIntervalInput('.')).toEqual({ valid: false });
    expect(parseIntervalInput('.5')).toEqual({ valid: false });
  });

  it('rejects negatives', () => {
    expect(parseIntervalInput('-7')).toEqual({ valid: false });
    expect(parseIntervalInput('-0')).toEqual({ valid: false });
  });

  it('rejects emoji + non-digit junk', () => {
    expect(parseIntervalInput('🌱')).toEqual({ valid: false });
    expect(parseIntervalInput('seven')).toEqual({ valid: false });
    expect(parseIntervalInput('1e2')).toEqual({ valid: false });
    expect(parseIntervalInput('7d')).toEqual({ valid: false });
  });

  it('accepts leading-zero strings as their numeric value (e.g. "07" → 7)', () => {
    // The input box sanitizes paste so "07" rarely lands here, but the
    // parser is permissive: "07" is digits-only and parses to 7.
    expect(parseIntervalInput('07')).toEqual({ valid: true, value: 7 });
  });
});

// ---------------------------------------------------------------------------
// Component integration tests
// ---------------------------------------------------------------------------

function renderSheet(overrides: Partial<{
  open: boolean;
  initialIsIndoor: boolean;
  initialOverrideIntervalDays: number | null;
  onSave: (patch: { is_indoor: boolean; override_interval_days: number | null }) => void;
  onCancel: () => void;
}> = {}) {
  const onSave = overrides.onSave ?? jest.fn();
  const onCancel = overrides.onCancel ?? jest.fn();
  // Note: the post-mount `isReduceMotionEnabled()` promise (from both the
  // EditorialBottomSheet inline effect AND the useReduceMotion hook) is
  // flushed by the suite-wide `afterEach` below. That keeps the React 19
  // "not wrapped in act()" warning out of test output without coupling
  // every test to a manual flush.
  const utils = render(
    <EditPlantDetailsSheet
      open={overrides.open ?? true}
      initialIsIndoor={overrides.initialIsIndoor ?? false}
      initialOverrideIntervalDays={
        overrides.initialOverrideIntervalDays === undefined
          ? null
          : overrides.initialOverrideIntervalDays
      }
      onSave={onSave}
      onCancel={onCancel}
    />,
  );
  return { ...utils, onSave, onCancel };
}

describe('<EditPlantDetailsSheet />', () => {
  it('renders nothing when open=false', () => {
    renderSheet({ open: false });
    expect(screen.queryByTestId('edit-details-title')).toBeNull();
  });

  it('renders the indoor switch reflecting initialIsIndoor=true', () => {
    renderSheet({ initialIsIndoor: true });
    const sw = screen.getByTestId('edit-details-indoor-switch');
    expect(sw.props.value).toBe(true);
  });

  it('renders the indoor switch reflecting initialIsIndoor=false', () => {
    renderSheet({ initialIsIndoor: false });
    const sw = screen.getByTestId('edit-details-indoor-switch');
    expect(sw.props.value).toBe(false);
  });

  it('renders the interval input with initialOverrideIntervalDays=14', () => {
    renderSheet({ initialOverrideIntervalDays: 14 });
    const input = screen.getByTestId('edit-details-interval-input');
    expect(input.props.value).toBe('14');
  });

  it('renders empty interval input when override is null', () => {
    renderSheet({ initialOverrideIntervalDays: null });
    const input = screen.getByTestId('edit-details-interval-input');
    expect(input.props.value).toBe('');
  });

  it('flips the switch on toggle and emits the new value on Save', () => {
    const { onSave } = renderSheet({ initialIsIndoor: false });
    fireEvent(screen.getByTestId('edit-details-indoor-switch'), 'valueChange', true);
    fireEvent.press(screen.getByTestId('edit-details-save'));
    expect(onSave).toHaveBeenCalledWith({
      is_indoor: true,
      override_interval_days: null,
    });
  });

  it('+ button increments within range', () => {
    renderSheet({ initialOverrideIntervalDays: 7 });
    fireEvent.press(screen.getByTestId('edit-details-interval-inc'));
    expect(screen.getByTestId('edit-details-interval-input').props.value).toBe('8');
  });

  it('− button decrements within range', () => {
    renderSheet({ initialOverrideIntervalDays: 7 });
    fireEvent.press(screen.getByTestId('edit-details-interval-dec'));
    expect(screen.getByTestId('edit-details-interval-input').props.value).toBe('6');
  });

  it('clamps + at the upper bound (365)', () => {
    renderSheet({ initialOverrideIntervalDays: MAX_INTERVAL_DAYS });
    const inc = screen.getByTestId('edit-details-interval-inc');
    expect(inc.props.accessibilityState).toMatchObject({ disabled: true });
    fireEvent.press(inc);
    expect(screen.getByTestId('edit-details-interval-input').props.value).toBe(
      String(MAX_INTERVAL_DAYS),
    );
  });

  it('clamps − at the lower bound (1)', () => {
    renderSheet({ initialOverrideIntervalDays: MIN_INTERVAL_DAYS });
    const dec = screen.getByTestId('edit-details-interval-dec');
    expect(dec.props.accessibilityState).toMatchObject({ disabled: true });
    fireEvent.press(dec);
    expect(screen.getByTestId('edit-details-interval-input').props.value).toBe(
      String(MIN_INTERVAL_DAYS),
    );
  });

  it('+ from blank seeds the value at MIN (1) so the user can build from the keyboard', () => {
    renderSheet({ initialOverrideIntervalDays: null });
    fireEvent.press(screen.getByTestId('edit-details-interval-inc'));
    expect(screen.getByTestId('edit-details-interval-input').props.value).toBe(
      String(MIN_INTERVAL_DAYS),
    );
  });

  it('− from blank stays blank (default is the floor)', () => {
    renderSheet({ initialOverrideIntervalDays: null });
    fireEvent.press(screen.getByTestId('edit-details-interval-dec'));
    expect(screen.getByTestId('edit-details-interval-input').props.value).toBe('');
  });

  it('blank input is valid → onSave gets null override', () => {
    const { onSave } = renderSheet({ initialOverrideIntervalDays: 7 });
    fireEvent.changeText(screen.getByTestId('edit-details-interval-input'), '');
    fireEvent.press(screen.getByTestId('edit-details-save'));
    expect(onSave).toHaveBeenCalledWith({
      is_indoor: false,
      override_interval_days: null,
    });
  });

  it('preserves raw paste of "1.5" (no silent sanitize) and shows validation copy (codex P2)', () => {
    // Codex catch: silently rewriting "1.5" → "15" on input would turn a user's
    // mistake into a different valid number. Component now keeps the raw text
    // and shows validation; Save is disabled.
    const { onSave } = renderSheet({ initialOverrideIntervalDays: null });
    const input = screen.getByTestId('edit-details-interval-input');
    fireEvent.changeText(input, '1.5');
    expect(input.props.value).toBe('1.5');
    expect(screen.getByTestId('edit-details-validation')).toBeOnTheScreen();
    fireEvent.press(screen.getByTestId('edit-details-save'));
    expect(onSave).not.toHaveBeenCalled();
  });

  it('preserves raw paste of "365.99" and rejects it (codex P2)', () => {
    const { onSave } = renderSheet({ initialOverrideIntervalDays: null });
    const input = screen.getByTestId('edit-details-interval-input');
    fireEvent.changeText(input, '365.99');
    expect(input.props.value).toBe('365.99');
    expect(screen.getByTestId('edit-details-validation')).toBeOnTheScreen();
    fireEvent.press(screen.getByTestId('edit-details-save'));
    expect(onSave).not.toHaveBeenCalled();
  });

  it('preserves raw paste with emoji ("7🌱") and rejects it', () => {
    renderSheet({ initialOverrideIntervalDays: null });
    const input = screen.getByTestId('edit-details-interval-input');
    fireEvent.changeText(input, '7🌱');
    expect(input.props.value).toBe('7🌱');
    expect(screen.getByTestId('edit-details-validation')).toBeOnTheScreen();
  });

  it('rejects scientific notation ("1e2")', () => {
    renderSheet({ initialOverrideIntervalDays: null });
    fireEvent.changeText(screen.getByTestId('edit-details-interval-input'), '1e2');
    expect(screen.getByTestId('edit-details-validation')).toBeOnTheScreen();
  });

  it('caps raw input length to prevent unbounded state from a pathological paste', () => {
    renderSheet({ initialOverrideIntervalDays: null });
    const input = screen.getByTestId('edit-details-interval-input');
    fireEvent.changeText(input, '1234567890123456789');
    // Cap is 8 chars; the truncated value is digits-only but still > 365 so
    // it surfaces validation rather than masquerading as a sanitized "valid".
    expect(input.props.value.length).toBeLessThanOrEqual(8);
    expect(screen.getByTestId('edit-details-validation')).toBeOnTheScreen();
  });

  it('shows validation copy in the tan accent for out-of-range numeric overflow (>365)', () => {
    renderSheet({ initialOverrideIntervalDays: null });
    const input = screen.getByTestId('edit-details-interval-input');
    fireEvent.changeText(input, '999');
    const validation = screen.getByTestId('edit-details-validation');
    expect(validation.props.children).toBe(VALIDATION_COPY);
    const flat = Array.isArray(validation.props.style)
      ? Object.assign({}, ...validation.props.style.flat())
      : validation.props.style;
    expect(flat.color).toBe(lightTheme.colors.tan);
  });

  it('shows validation copy when value is "0" (below min)', () => {
    renderSheet({ initialOverrideIntervalDays: null });
    fireEvent.changeText(screen.getByTestId('edit-details-interval-input'), '0');
    expect(screen.getByTestId('edit-details-validation')).toBeOnTheScreen();
  });

  it('disables Save while validation is failing', () => {
    const { onSave } = renderSheet({ initialOverrideIntervalDays: null });
    fireEvent.changeText(screen.getByTestId('edit-details-interval-input'), '999');
    const save = screen.getByTestId('edit-details-save');
    expect(save.props.accessibilityState).toMatchObject({ disabled: true });
    fireEvent.press(save);
    expect(onSave).not.toHaveBeenCalled();
  });

  it('Save fires onSave with the right payload (is_indoor + override)', () => {
    const { onSave } = renderSheet({
      initialIsIndoor: true,
      initialOverrideIntervalDays: 14,
    });
    fireEvent.press(screen.getByTestId('edit-details-save'));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith({
      is_indoor: true,
      override_interval_days: 14,
    });
  });

  it('Cancel fires onCancel', () => {
    const { onCancel } = renderSheet();
    fireEvent.press(screen.getByTestId('edit-details-cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('Sheet swipe-down (backdrop press) fires onCancel', () => {
    const { onCancel } = renderSheet();
    fireEvent.press(
      screen.getByTestId('edit-plant-details-sheet-backdrop', { includeHiddenElements: true }),
    );
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('inherits the EditorialBottomSheet focus-trap (accessibilityViewIsModal=true)', () => {
    renderSheet();
    const sheet = screen.getByTestId('edit-plant-details-sheet-sheet');
    expect(sheet.props.accessibilityViewIsModal).toBe(true);
    expect(sheet.props.accessibilityRole).toBe('dialog');
    expect(sheet.props.accessibilityLabel).toBe('Edit plant details');
  });

  it('switch announces role + label for screen readers', () => {
    renderSheet({ initialIsIndoor: true });
    const sw = screen.getByTestId('edit-details-indoor-switch');
    expect(sw.props.accessibilityRole).toBe('switch');
    expect(sw.props.accessibilityLabel).toBe('Indoors');
    expect(sw.props.accessibilityState).toMatchObject({ checked: true });
  });

  it('stepper input announces accessibilityRole=spinbutton + value', () => {
    renderSheet({ initialOverrideIntervalDays: 7 });
    const input = screen.getByTestId('edit-details-interval-input');
    expect(input.props.accessibilityRole).toBe('spinbutton');
    expect(input.props.accessibilityLabel).toBe('Custom watering interval in days');
    expect(input.props.accessibilityValue).toMatchObject({
      text: '7 days',
      now: 7,
      min: MIN_INTERVAL_DAYS,
      max: MAX_INTERVAL_DAYS,
    });
  });

  it('stepper announces "Default species interval" when blank', () => {
    renderSheet({ initialOverrideIntervalDays: null });
    const input = screen.getByTestId('edit-details-interval-input');
    expect(input.props.accessibilityValue).toEqual({ text: 'Default species interval' });
  });

  it('renders the helper copy explaining blank = default', () => {
    renderSheet({ initialOverrideIntervalDays: null });
    expect(screen.getByText(HELPER_COPY)).toBeOnTheScreen();
  });

  it('reduce-motion ON: sheet animationType flips to "none" (inherited from EditorialBottomSheet)', async () => {
    mockState.reduceMotion = true;
    renderSheet();
    await new Promise((resolve) => setImmediate(resolve));
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Modal = require('react-native').Modal;
    const modal = screen.UNSAFE_getByType(Modal);
    expect(modal.props.animationType).toBe('none');
  });

  it('uses Midnight Conservatory tokens when scheme=dark (sheet surface)', () => {
    useColorSchemeMock.mockReturnValue('dark');
    renderSheet();
    const sheet = screen.getByTestId('edit-plant-details-sheet-sheet');
    const flat = Array.isArray(sheet.props.style)
      ? Object.assign({}, ...sheet.props.style.flat())
      : sheet.props.style;
    expect(flat.backgroundColor).toBe(darkTheme.colors.surface);
  });

  it('uses Midnight tan accent for validation copy in dark mode', () => {
    useColorSchemeMock.mockReturnValue('dark');
    renderSheet({ initialOverrideIntervalDays: null });
    fireEvent.changeText(screen.getByTestId('edit-details-interval-input'), '999');
    const validation = screen.getByTestId('edit-details-validation');
    const flat = Array.isArray(validation.props.style)
      ? Object.assign({}, ...validation.props.style.flat())
      : validation.props.style;
    expect(flat.color).toBe(darkTheme.colors.tan);
  });
});
