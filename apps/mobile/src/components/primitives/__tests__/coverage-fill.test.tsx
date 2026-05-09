// Coverage-fill suite — tests carved out specifically for the small branch +
// pressed-state remainders that the per-primitive integration suites left
// uncovered (ToastBanner Android live-region, EditorialButton pressed style,
// FAB pressed style). Each test asserts behavior the integration suites don't
// repeat — there are no near-duplicates here.
//
// We mock the bundled Platform module per-test so the Android branches in
// ToastBanner are exercised deterministically (jest-expo's default is iOS).

import { darkTheme, lightTheme } from '@plantcare/theme';
import { act, render, screen } from '@testing-library/react-native';
import { Platform } from 'react-native';

jest.mock('../../../hooks/useTheme', () => ({
  useTheme: jest.fn(),
}));

import { useTheme } from '../../../hooks/useTheme';
import { EditorialButton, FAB, ToastBanner } from '../index';

const mockedUseTheme = useTheme as jest.MockedFunction<typeof useTheme>;

beforeEach(() => {
  mockedUseTheme.mockReturnValue(lightTheme);
});

afterEach(() => {
  mockedUseTheme.mockReset();
  // Restore Platform.OS in case a test mutated it. Platform is a frozen
  // module in some RN builds, so we use defineProperty.
  Object.defineProperty(Platform, 'OS', { value: 'ios', configurable: true });
});

describe('ToastBanner — Android live-region branches', () => {
  it("sets accessibilityLiveRegion='assertive' for warn on Android", () => {
    Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
    render(<ToastBanner type="warn" message="boom" testID="toast" />);
    const root = screen.getByTestId('toast');
    expect(root.props.accessibilityLiveRegion).toBe('assertive');
    expect(root.props.accessibilityRole).toBe('alert');
  });

  it("sets accessibilityLiveRegion='polite' for info on Android", () => {
    Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
    render(<ToastBanner type="info" message="hi" testID="toast" />);
    const root = screen.getByTestId('toast');
    expect(root.props.accessibilityLiveRegion).toBe('polite');
    expect(root.props.accessibilityRole).toBe('status');
  });

  it("sets accessibilityLiveRegion='polite' for pending on Android (matches non-disruptive contract)", () => {
    Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
    render(
      <ToastBanner type="pending" message="syncing 2 items" testID="toast" />,
    );
    const root = screen.getByTestId('toast');
    expect(root.props.accessibilityLiveRegion).toBe('polite');
  });

  it('omits accessibilityLiveRegion on iOS regardless of type', () => {
    Object.defineProperty(Platform, 'OS', { value: 'ios', configurable: true });
    render(<ToastBanner type="warn" message="boom" testID="toast" />);
    const root = screen.getByTestId('toast');
    expect(root.props.accessibilityLiveRegion).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// EditorialButton + FAB — pressed-state styling. Pressable's `style` callback
// receives `{pressed}`; both primitives return a different style object when
// pressed=true. We invoke the callback directly so the pressed branch
// executes without requiring a long-press simulator.
// ---------------------------------------------------------------------------

function flatStyle(s: unknown): Record<string, unknown> {
  if (!s) return {};
  if (Array.isArray(s)) {
    return s.reduce<Record<string, unknown>>(
      (acc, el) => ({ ...acc, ...(flatStyle(el) ?? {}) }),
      {},
    );
  }
  return s as Record<string, unknown>;
}

// Pressable's `style` is preserved on the rendered host node when it is a
// function — RTL's `screen.root.props.style` reflects the source-level prop
// at the host instance level. The default `getByTestId` returns a public
// instance handle that exposes `props`; we walk the rendered tree via the
// react-test-renderer's `root` to find the function-form style.
//
// We DO NOT use `screen.UNSAFE_getAllByType(Pressable)` here because Pressable
// is a function component that the test renderer collapses to its host View
// in many RN versions; the safer query is the JSON tree.
function getStyleFn(testID: string): (s: { pressed: boolean }) => unknown {
  // Walk all instances and find the testID. Their `props.style` is
  // either the original callback (Pressable's function form) or the
  // already-evaluated array (host View). We want the callback.
  const node = screen.getByTestId(testID);
  // React Native Testing Library returns a ReactTestInstance whose
  // `props.style` is the prop AS PASSED to the host element. For Pressable,
  // RN's internal implementation wraps the style callback into a function-
  // form prop on the underlying host View — but only the evaluated value
  // bubbles up at the host level. We dig into `node.parent` if needed:
  let cursor: typeof node | null = node;
  while (cursor) {
    const s = cursor.props?.style;
    if (typeof s === 'function') return s;
    cursor = cursor.parent;
  }
  throw new Error(
    `no function-form style found on the testID="${testID}" subtree`,
  );
}

describe('EditorialButton — pressed state branch', () => {
  it('applies the dim opacity when pressed=true and not inert', () => {
    render(
      <EditorialButton
        variant="filled"
        label="Mark watered"
        onPress={() => {}}
        testID="btn"
      />,
    );
    const styleFn = getStyleFn('btn');
    const pressed = flatStyle(styleFn({ pressed: true }));
    const idle = flatStyle(styleFn({ pressed: false }));
    expect(pressed.opacity).toBe(0.7);
    // idle does not carry the pressed opacity (the inert branch may set 0.4
    // separately, but here disabled/loading are both false, so opacity should
    // be undefined or 1).
    expect(idle.opacity === undefined || idle.opacity === 1).toBe(true);
  });

  it('does NOT apply pressed opacity when the button is loading (inert)', () => {
    render(
      <EditorialButton
        variant="filled"
        label="Mark watered"
        onPress={() => {}}
        loading
        testID="btn"
      />,
    );
    const styleFn = getStyleFn('btn');
    // pressed=true while loading still resolves to the inert style (0.4),
    // not the pressed style (0.7).
    const flat = flatStyle(styleFn({ pressed: true }));
    expect(flat.opacity).toBe(0.4);
  });

  it('exposes the loading ActivityIndicator with a derived testID when testID is provided', () => {
    render(
      <EditorialButton
        variant="filled"
        label="Mark watered"
        onPress={() => {}}
        loading
        testID="btn"
      />,
    );
    expect(screen.getByTestId('btn-loading')).toBeOnTheScreen();
  });

  it('renders the inert-by-disabled branch without firing onPress', () => {
    const onPress = jest.fn();
    render(
      <EditorialButton
        variant="outline"
        label="Add note"
        onPress={onPress}
        disabled
        testID="btn"
      />,
    );
    const btn = screen.getByTestId('btn');
    expect(btn.props.accessibilityState).toEqual({ disabled: true, busy: false });
    // Pressable with disabled=true short-circuits onPress at the RN layer.
    // Our handler should never fire.
    btn.props.onPress?.();
    expect(onPress).not.toHaveBeenCalled();
  });

  it('flips fill/label to Midnight tokens in dark mode (sage on forest)', () => {
    mockedUseTheme.mockReturnValue(darkTheme);
    render(
      <EditorialButton
        variant="filled"
        label="Mark watered"
        onPress={() => {}}
        testID="btn"
      />,
    );
    const styleFn = getStyleFn('btn');
    const flat = flatStyle(styleFn({ pressed: false }));
    // Filled in dark = text token (cream — see darkColors.text in
    // packages/theme/src/colors.ts; "sage" maps to `darkColors.primary`,
    // not `text`). The contract for the filled variant is bg=text,
    // label=surface — both must invert with the theme.
    expect(flat.backgroundColor).toBe(darkTheme.colors.text);

    // Foreground/label color: read off the rendered Text inside the button.
    // In the loading=false branch the button renders a single Text child;
    // we read its color directly so a regression in the dark text token
    // (or in the filled-variant fg derivation) trips this test.
    const labelText = screen.getByText('Mark watered');
    const labelStyle = flatStyle(labelText.props.style);
    expect(labelStyle.color).toBe(darkTheme.colors.surface);
  });
});

describe('FAB — pressed state branch', () => {
  it('applies the 0.85 pressed opacity when pressed=true and enabled', () => {
    render(<FAB onPress={() => {}} testID="fab" />);
    const styleFn = getStyleFn('fab');
    const pressed = flatStyle(styleFn({ pressed: true }));
    const idle = flatStyle(styleFn({ pressed: false }));
    expect(pressed.opacity).toBe(0.85);
    expect(idle.opacity).toBeUndefined();
  });

  it('skips the pressed opacity when disabled', () => {
    render(<FAB onPress={() => {}} disabled testID="fab" />);
    const styleFn = getStyleFn('fab');
    const flat = flatStyle(styleFn({ pressed: true }));
    expect(flat.opacity).toBeUndefined();
  });

  it('renders the default "+" glyph when no icon is provided', () => {
    render(<FAB onPress={() => {}} testID="fab" />);
    expect(screen.getByTestId('fab-default-icon')).toBeOnTheScreen();
  });

  it('routes accessibility actions only when onLongPress is wired', () => {
    const onPress = jest.fn();
    const onLongPress = jest.fn();
    render(
      <FAB
        onPress={onPress}
        onLongPress={onLongPress}
        testID="fab"
      />,
    );
    const fab = screen.getByTestId('fab');
    expect(fab.props.accessibilityActions).toEqual([
      { name: 'longpress', label: 'Quick diagnose' },
    ]);
    expect(typeof fab.props.onAccessibilityAction).toBe('function');
    fab.props.onAccessibilityAction({ nativeEvent: { actionName: 'longpress' } });
    expect(onLongPress).toHaveBeenCalledTimes(1);
  });

  it('ignores unknown accessibility action names (defensive switch fall-through)', () => {
    const onLongPress = jest.fn();
    render(<FAB onPress={() => {}} onLongPress={onLongPress} testID="fab" />);
    const fab = screen.getByTestId('fab');
    fab.props.onAccessibilityAction({
      nativeEvent: { actionName: 'magnify' },
    });
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('does NOT expose accessibilityActions when disabled (no rotor path to a rejected callback)', () => {
    render(
      <FAB
        onPress={() => {}}
        onLongPress={() => {}}
        disabled
        testID="fab"
      />,
    );
    const fab = screen.getByTestId('fab');
    expect(fab.props.accessibilityActions).toBeUndefined();
    expect(fab.props.onAccessibilityAction).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// HeroPhoto onError branch — the integration suite covers the success path
// and the prop type contract; the error branch (which removes the Image and
// keeps the cream skeleton visible) needs a direct invocation of the Image's
// onError callback to flip the internal `errored` state.
// ---------------------------------------------------------------------------

import { HeroPhoto } from '../HeroPhoto';

describe('HeroPhoto — onError silent fallback', () => {
  it('hides the Image and keeps the cream skeleton on error (no broken-image icon)', () => {
    const onError = jest.fn();
    render(
      <HeroPhoto
        source={{ uri: 'file:///bad' }}
        accessibilityLabel="Photo of Mona"
        onError={onError}
        testID="hero"
      />,
    );
    const hero = screen.getByTestId('hero');
    // The Image is the first child while not errored.
    const image = hero.children[0] as unknown as { props: { onError: () => void } };
    expect(image).toBeTruthy();
    // Pre-error: the wrapper has exactly one child (the Image).
    expect(hero.children.length).toBe(1);

    act(() => {
      image.props.onError();
    });
    expect(onError).toHaveBeenCalledTimes(1);

    // Post-error: the Image is unmounted (the wrapper now has zero children),
    // and the wrapping View still carries the cream skeleton background +
    // the screen-reader announcement. The skeleton color is the surface
    // token from the active theme; in light mode that's #FAF6EE.
    const heroAfter = screen.getByTestId('hero');
    expect(heroAfter.children.length).toBe(0);
    expect(heroAfter.props.accessibilityLabel).toBe('Photo of Mona');
    const containerStyle = flatStyle(heroAfter.props.style);
    expect(containerStyle.backgroundColor).toBe(lightTheme.colors.surface);
  });

  it('fires onLoad pass-through when the image resolves', () => {
    const onLoad = jest.fn();
    render(
      <HeroPhoto
        source={{ uri: 'file:///ok' }}
        accessibilityLabel="Photo of Mona"
        onLoad={onLoad}
        testID="hero"
      />,
    );
    const hero = screen.getByTestId('hero');
    const image = hero.children[0] as unknown as { props: { onLoad: () => void } };
    image.props.onLoad();
    expect(onLoad).toHaveBeenCalledTimes(1);
  });

  it('resolves rounded=false to radius 0 (sharp corners path)', () => {
    render(
      <HeroPhoto
        source={{ uri: 'file:///ok' }}
        accessibilityLabel="Photo of Mona"
        rounded={false}
        testID="hero"
      />,
    );
    const hero = screen.getByTestId('hero');
    const flat = flatStyle(hero.props.style);
    expect(flat.borderRadius).toBe(0);
  });

  it('resolves a numeric rounded prop (e.g. 12 for tile usage in PhotoTimeline)', () => {
    render(
      <HeroPhoto
        source={{ uri: 'file:///ok' }}
        accessibilityLabel="Photo of Mona"
        rounded={12}
        testID="hero"
      />,
    );
    const hero = screen.getByTestId('hero');
    const flat = flatStyle(hero.props.style);
    expect(flat.borderRadius).toBe(12);
  });
});
