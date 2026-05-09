/**
 * FABPopover tests (E3-004).
 *
 * Coverage:
 *  - open=false renders nothing
 *  - open=true renders the menu with two items in the locked order
 *  - tap "Add a plant" → onAddPlant + onDismiss; onQuickDiagnose NOT called
 *  - tap "Quick diagnose" → onQuickDiagnose + onDismiss; onAddPlant NOT called
 *  - tap-outside (backdrop) → onDismiss only; neither handler fires
 *  - Android hardware back → onRequestClose → onDismiss
 *  - menu has accessibilityRole='menu' + accessibilityViewIsModal + label
 *  - items have accessibilityRole='menuitem'
 *  - StrictMode / double-tap latch: second tap is a no-op
 *  - re-open resets the latch (next session works)
 *  - reduce-motion ON: opacity initialized at 1, no Animated.timing fires
 *  - reduce-motion OFF: opacity initialized at 1 (init-at-end-state),
 *    Animated.timing runs to 1 (V1 init-at-end-state pattern)
 *  - dark theme: surface uses darkTheme.colors.surface (token-driven swap)
 *  - V1 scope lock: no `transform: [{ scale: ... }]` on the menu container
 *  - testID prop threads through to backdrop, menu, and items
 */

import { darkTheme, lightTheme, type Theme } from '@plantcare/theme';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { AccessibilityInfo, Animated } from 'react-native';

import { FABPopover, fabPopoverStyles } from '../FABPopover';

jest.mock('../../../hooks/useTheme', () => ({ useTheme: jest.fn() }));
jest.mock('../../../hooks/useReduceMotion', () => ({ useReduceMotion: jest.fn() }));

import { useTheme } from '../../../hooks/useTheme';
import { useReduceMotion } from '../../../hooks/useReduceMotion';

const mockedUseTheme = useTheme as jest.MockedFunction<() => Theme>;
const mockedUseReduceMotion = useReduceMotion as unknown as jest.Mock<boolean, []>;

function flattenStyle(style: unknown): Record<string, unknown> {
  if (Array.isArray(style)) {
    return style.reduce<Record<string, unknown>>(
      (acc, entry) => ({ ...acc, ...flattenStyle(entry) }),
      {},
    );
  }
  if (style && typeof style === 'object') return style as Record<string, unknown>;
  return {};
}

beforeEach(() => {
  mockedUseTheme.mockReturnValue(lightTheme);
  mockedUseReduceMotion.mockReturnValue(false);
  // Default OS probe → motion ON (matches `useReduceMotion()` mock above).
  // Tests that need the OS to report reduce-motion override per-test.
  jest
    .spyOn(AccessibilityInfo, 'isReduceMotionEnabled')
    .mockResolvedValue(false);
  jest
    .spyOn(AccessibilityInfo, 'isScreenReaderEnabled')
    .mockResolvedValue(false);
  // Guard against findNodeHandle returning a stale value — default to null
  // so the focus-return path never silently fires across tests that don't
  // pass a triggerRef. Tests that drive focus return override this.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  jest.spyOn(require('react-native'), 'findNodeHandle').mockReturnValue(null);
});

afterEach(() => {
  mockedUseTheme.mockReset();
  mockedUseReduceMotion.mockReset();
  jest.restoreAllMocks();
});

describe('FABPopover', () => {
  const noop = () => {};

  it('open=false → renders nothing', () => {
    const { queryByTestId, toJSON } = render(
      <FABPopover open={false} onDismiss={noop} onAddPlant={noop} onQuickDiagnose={noop} />,
    );
    expect(queryByTestId('fab-popover-menu')).toBeNull();
    expect(toJSON()).toBeNull();
  });

  it('open=true → renders the menu with two items in the locked order', () => {
    const { getByTestId, getAllByRole } = render(
      <FABPopover open onDismiss={noop} onAddPlant={noop} onQuickDiagnose={noop} />,
    );
    expect(getByTestId('fab-popover-menu')).toBeTruthy();
    expect(getByTestId('fab-popover-item-add')).toBeTruthy();
    expect(getByTestId('fab-popover-item-diagnose')).toBeTruthy();

    const items = getAllByRole('menuitem');
    expect(items).toHaveLength(2);
    expect(items[0].props.accessibilityLabel).toBe('Add a plant');
    expect(items[1].props.accessibilityLabel).toBe('Quick diagnose');
  });

  it('tap "Add a plant" → onAddPlant + onDismiss fire; onQuickDiagnose does NOT', () => {
    const onDismiss = jest.fn();
    const onAddPlant = jest.fn();
    const onQuickDiagnose = jest.fn();
    const { getByTestId } = render(
      <FABPopover
        open
        onDismiss={onDismiss}
        onAddPlant={onAddPlant}
        onQuickDiagnose={onQuickDiagnose}
      />,
    );
    fireEvent.press(getByTestId('fab-popover-item-add'));
    expect(onAddPlant).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onQuickDiagnose).not.toHaveBeenCalled();
  });

  it('tap "Quick diagnose" → onQuickDiagnose + onDismiss fire; onAddPlant does NOT', () => {
    const onDismiss = jest.fn();
    const onAddPlant = jest.fn();
    const onQuickDiagnose = jest.fn();
    const { getByTestId } = render(
      <FABPopover
        open
        onDismiss={onDismiss}
        onAddPlant={onAddPlant}
        onQuickDiagnose={onQuickDiagnose}
      />,
    );
    fireEvent.press(getByTestId('fab-popover-item-diagnose'));
    expect(onQuickDiagnose).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onAddPlant).not.toHaveBeenCalled();
  });

  it('tap-outside (backdrop) → onDismiss only; neither handler fires', () => {
    const onDismiss = jest.fn();
    const onAddPlant = jest.fn();
    const onQuickDiagnose = jest.fn();
    const { getByTestId } = render(
      <FABPopover
        open
        onDismiss={onDismiss}
        onAddPlant={onAddPlant}
        onQuickDiagnose={onQuickDiagnose}
      />,
    );
    fireEvent.press(getByTestId('fab-popover-backdrop'));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onAddPlant).not.toHaveBeenCalled();
    expect(onQuickDiagnose).not.toHaveBeenCalled();
  });

  it('Android hardware back (Modal.onRequestClose) → onDismiss', () => {
    const onDismiss = jest.fn();
    const { UNSAFE_getByType } = render(
      <FABPopover open onDismiss={onDismiss} onAddPlant={noop} onQuickDiagnose={noop} />,
    );
    // The Modal exposes onRequestClose; invoking it directly simulates the
    // Android hardware back press.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Modal = require('react-native').Modal;
    const modal = UNSAFE_getByType(Modal);
    modal.props.onRequestClose();
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('menu has accessibilityRole=menu, accessibilityViewIsModal=true, and a label', () => {
    const { getByTestId } = render(
      <FABPopover open onDismiss={noop} onAddPlant={noop} onQuickDiagnose={noop} />,
    );
    const menu = getByTestId('fab-popover-menu');
    expect(menu.props.accessibilityRole).toBe('menu');
    expect(menu.props.accessibilityViewIsModal).toBe(true);
    expect(menu.props.accessibilityLabel).toBe('Add a plant menu');
    expect(menu.props.importantForAccessibility).toBe('yes');
  });

  it('items have accessibilityRole=menuitem', () => {
    const { getByTestId } = render(
      <FABPopover open onDismiss={noop} onAddPlant={noop} onQuickDiagnose={noop} />,
    );
    expect(getByTestId('fab-popover-item-add').props.accessibilityRole).toBe('menuitem');
    expect(getByTestId('fab-popover-item-diagnose').props.accessibilityRole).toBe(
      'menuitem',
    );
  });

  it('double-tap latch: second tap on the same item is a no-op', () => {
    const onAddPlant = jest.fn();
    const onDismiss = jest.fn();
    const { getByTestId } = render(
      <FABPopover
        open
        onDismiss={onDismiss}
        onAddPlant={onAddPlant}
        onQuickDiagnose={noop}
      />,
    );
    fireEvent.press(getByTestId('fab-popover-item-add'));
    fireEvent.press(getByTestId('fab-popover-item-add'));
    expect(onAddPlant).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('double-tap latch: tapping a different item after dispatch is a no-op', () => {
    const onAddPlant = jest.fn();
    const onQuickDiagnose = jest.fn();
    const onDismiss = jest.fn();
    const { getByTestId } = render(
      <FABPopover
        open
        onDismiss={onDismiss}
        onAddPlant={onAddPlant}
        onQuickDiagnose={onQuickDiagnose}
      />,
    );
    fireEvent.press(getByTestId('fab-popover-item-add'));
    fireEvent.press(getByTestId('fab-popover-item-diagnose'));
    expect(onAddPlant).toHaveBeenCalledTimes(1);
    expect(onQuickDiagnose).not.toHaveBeenCalled();
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('re-opening the popover resets the dispatch latch', () => {
    const onAddPlant = jest.fn();
    const onDismiss = jest.fn();
    const { getByTestId, rerender } = render(
      <FABPopover
        open
        onDismiss={onDismiss}
        onAddPlant={onAddPlant}
        onQuickDiagnose={noop}
      />,
    );
    fireEvent.press(getByTestId('fab-popover-item-add'));
    expect(onAddPlant).toHaveBeenCalledTimes(1);

    // Close + re-open. Latch must reset so the next open can dispatch.
    rerender(
      <FABPopover
        open={false}
        onDismiss={onDismiss}
        onAddPlant={onAddPlant}
        onQuickDiagnose={noop}
      />,
    );
    rerender(
      <FABPopover
        open
        onDismiss={onDismiss}
        onAddPlant={onAddPlant}
        onQuickDiagnose={noop}
      />,
    );
    fireEvent.press(getByTestId('fab-popover-item-add'));
    expect(onAddPlant).toHaveBeenCalledTimes(2);
  });

  it('reduce-motion hook ON → opacity at 1 immediately, NO Animated.timing fires', async () => {
    mockedUseReduceMotion.mockReturnValue(true);
    const timingSpy = jest.spyOn(Animated, 'timing');
    render(<FABPopover open onDismiss={noop} onAddPlant={noop} onQuickDiagnose={noop} />);
    // Synchronous: no animation kicked off when the hook says reduce-motion.
    expect(timingSpy).not.toHaveBeenCalled();
    // Even after the OS probe resolves, no animation fires.
    await waitFor(() => {
      expect(timingSpy).not.toHaveBeenCalled();
    });
  });

  it('reduce-motion async-window guard: timing does NOT start before OS probe resolves (codex P1 fix)', () => {
    // Hook says false (boot window), but OS probe hasn't resolved yet.
    mockedUseReduceMotion.mockReturnValue(false);
    let resolveProbe: (value: boolean) => void = () => {};
    (AccessibilityInfo.isReduceMotionEnabled as jest.Mock).mockReturnValue(
      new Promise<boolean>((res) => {
        resolveProbe = res;
      }),
    );
    const timingSpy = jest.spyOn(Animated, 'timing');
    render(<FABPopover open onDismiss={noop} onAddPlant={noop} onQuickDiagnose={noop} />);
    // Probe is in-flight; timing must NOT have started yet — biased toward
    // no-motion when OS preference is unknown.
    expect(timingSpy).not.toHaveBeenCalled();
    // Avoid an unresolved-promise warning at teardown.
    resolveProbe(true);
  });

  it('OS probe says reduce-motion ON → snap to end, NO Animated.timing fires', async () => {
    mockedUseReduceMotion.mockReturnValue(false);
    (AccessibilityInfo.isReduceMotionEnabled as jest.Mock).mockResolvedValue(true);
    const timingSpy = jest.spyOn(Animated, 'timing');
    render(<FABPopover open onDismiss={noop} onAddPlant={noop} onQuickDiagnose={noop} />);
    // Resolve the probe; assert timing still wasn't called.
    await waitFor(() => {
      expect((AccessibilityInfo.isReduceMotionEnabled as jest.Mock)).toHaveBeenCalled();
    });
    expect(timingSpy).not.toHaveBeenCalled();
  });

  it('OS probe says motion allowed → Animated.timing fires with toValue: 1, useNativeDriver', async () => {
    mockedUseReduceMotion.mockReturnValue(false);
    (AccessibilityInfo.isReduceMotionEnabled as jest.Mock).mockResolvedValue(false);
    const timingSpy = jest.spyOn(Animated, 'timing');
    render(<FABPopover open onDismiss={noop} onAddPlant={noop} onQuickDiagnose={noop} />);
    await waitFor(() => {
      expect(timingSpy).toHaveBeenCalledTimes(1);
    });
    const call = timingSpy.mock.calls[0];
    const config = call[1] as { toValue: number; useNativeDriver?: boolean };
    expect(config.toValue).toBe(1);
    expect(config.useNativeDriver).toBe(true);
  });

  it('focus return: triggerRef.current=null is a safe no-op (no setFocus call) — runs FIRST so prior render leaks are avoided', async () => {
    const setFocusSpyA = jest
      .spyOn(AccessibilityInfo, 'setAccessibilityFocus')
      .mockImplementation(() => undefined);
    const triggerRefA = { current: null };
    const { rerender } = render(
      <FABPopover
        open
        onDismiss={noop}
        onAddPlant={noop}
        onQuickDiagnose={noop}
        triggerRef={triggerRefA as never}
      />,
    );
    await act(async () => {
      rerender(
        <FABPopover
          open={false}
          onDismiss={noop}
          onAddPlant={noop}
          onQuickDiagnose={noop}
          triggerRef={triggerRefA as never}
        />,
      );
    });
    expect(setFocusSpyA).not.toHaveBeenCalled();
  });

  it('focus return on dismiss: AccessibilityInfo.setAccessibilityFocus is called when triggerRef provided (codex P2 fix)', async () => {
    const setFocusSpy = jest
      .spyOn(AccessibilityInfo, 'setAccessibilityFocus')
      .mockImplementation(() => undefined);
    // Stub findNodeHandle by handing a real-ish ref object whose `.current`
    // is a host node — RN's findNodeHandle returns null for plain objects in
    // jest-expo, so we mock it to return a stable handle.
    const reactNative = jest.requireMock('react-native') as Record<string, unknown> | null;
    void reactNative; // appease no-unused
    const triggerRef = { current: {} as unknown };
    const findNodeHandleSpy = jest
      .spyOn(require('react-native'), 'findNodeHandle')
      .mockReturnValue(42);

    const { rerender } = render(
      <FABPopover
        open
        onDismiss={noop}
        onAddPlant={noop}
        onQuickDiagnose={noop}
        triggerRef={triggerRef as never}
      />,
    );
    // Dismiss the popover.
    await act(async () => {
      rerender(
        <FABPopover
          open={false}
          onDismiss={noop}
          onAddPlant={noop}
          onQuickDiagnose={noop}
          triggerRef={triggerRef as never}
        />,
      );
    });
    expect(findNodeHandleSpy).toHaveBeenCalled();
    expect(setFocusSpy).toHaveBeenCalledWith(42);
  });


  it('dark theme: menu surface uses darkTheme.colors.surface (token-driven swap)', () => {
    mockedUseTheme.mockReturnValue(darkTheme);
    const { getByTestId } = render(
      <FABPopover open onDismiss={noop} onAddPlant={noop} onQuickDiagnose={noop} />,
    );
    const menu = getByTestId('fab-popover-menu');
    const style = flattenStyle(menu.props.style);
    expect(style.backgroundColor).toBe(darkTheme.colors.surface);
    expect(darkTheme.colors.surface).not.toBe(lightTheme.colors.surface);
  });

  it('V1 scope lock: no scale transform on the menu container (no Reanimated tween)', () => {
    const { getByTestId } = render(
      <FABPopover open onDismiss={noop} onAddPlant={noop} onQuickDiagnose={noop} />,
    );
    const menu = getByTestId('fab-popover-menu');
    const style = flattenStyle(menu.props.style);
    // The animated transform array MAY exist for opacity-driven layouts but
    // must NOT contain a scale entry. (We assert the explicit V1 contract:
    // no scale-based "pop" anim.)
    const transform = style.transform as
      | ReadonlyArray<Record<string, unknown>>
      | undefined;
    if (Array.isArray(transform)) {
      for (const entry of transform) {
        expect(entry).not.toHaveProperty('scale');
        expect(entry).not.toHaveProperty('scaleX');
        expect(entry).not.toHaveProperty('scaleY');
      }
    }
  });

  it('static-layout contract: menu radius 12, item paddings locked', () => {
    // Pin the V1 visual contract so a future "let's make it bigger" tweak is
    // a deliberate unlock, not a quiet drift away from the master plan
    // "small Conservatory cream popover" copy.
    const menuRule = fabPopoverStyles.menu as { borderRadius?: number; minWidth?: number };
    expect(menuRule.borderRadius).toBe(12);
    expect(menuRule.minWidth).toBe(200);
    const itemRule = fabPopoverStyles.item as {
      paddingVertical?: number;
      paddingHorizontal?: number;
    };
    expect(itemRule.paddingVertical).toBe(14);
    expect(itemRule.paddingHorizontal).toBe(20);
  });

  it('testID prop threads through to backdrop, menu, and items', () => {
    const { getByTestId } = render(
      <FABPopover
        open
        onDismiss={noop}
        onAddPlant={noop}
        onQuickDiagnose={noop}
        testID="my-popover"
      />,
    );
    expect(getByTestId('my-popover-backdrop')).toBeTruthy();
    expect(getByTestId('my-popover-menu')).toBeTruthy();
    expect(getByTestId('my-popover-item-add')).toBeTruthy();
    expect(getByTestId('my-popover-item-diagnose')).toBeTruthy();
  });
});
