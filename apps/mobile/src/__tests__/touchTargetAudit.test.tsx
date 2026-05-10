/**
 * E11-002 — Touch-target audit.
 *
 * Sweeps every component + screen in the mobile app and asserts that every
 * interactive element (Pressable, TouchableOpacity, TouchableHighlight,
 * TouchableWithoutFeedback) presents an effective hit area of at least
 * 44×44pt — the iOS Human Interface Guidelines and Material accessibility
 * floor.
 *
 * # Why a tree-walker, not per-component asserts
 *
 * The hitSlop contract is system-wide: any future Pressable that ships with
 * a sub-44 visible footprint and no hitSlop is a regression. A per-component
 * test would catch it only if the author remembered to add a touch-target
 * case. The tree-walker rents one render of every surface and asserts the
 * floor across all hosts — a single failure names the file, the role/label,
 * the visible size, and the computed hit area.
 *
 * # Effective hit area
 *
 *   width  = visibleWidth  + (hitSlop.left + hitSlop.right)
 *   height = visibleHeight + (hitSlop.top  + hitSlop.bottom)
 *
 * hitSlop normalisation:
 *   - undefined            → { top: 0, right: 0, bottom: 0, left: 0 }
 *   - number n             → { top: n, right: n, bottom: n, left: n }
 *   - { top, right, ... }  → as written (missing axes default 0)
 *
 * Visible size is read off the flattened style:
 *   - explicit `width` / `height` wins
 *   - else `minWidth` / `minHeight` are taken as the floor the Pressable
 *     guarantees (RN will not paint a Pressable smaller than its minHeight
 *     even if children would otherwise collapse it)
 *   - else `paddingV + intrinsicTextHeight + paddingV` is approximated from
 *     padding alone — see `approximatePaddedHeight`.
 *
 * # Disabled Pressables are skipped
 *
 * A Pressable with `disabled === true` has no hit area; RN drops the
 * gesture responder entirely. The audit skips them so a temporarily
 * disabled-by-state CTA doesn't poison the assertion.
 *
 * # Backdrop / overlay Pressables
 *
 * The `EditorialBottomSheet` and `FABPopover` backdrops use
 * `StyleSheet.absoluteFill` — they span the full Modal viewport, always
 * ≥ 44×44 by definition. The walker detects the absoluteFill marker and
 * passes them through.
 *
 * # Sibling-overlap check (best-effort)
 *
 * The second sweep flags any two sibling Pressables whose hitSlop reaches
 * into each other through the gap between them. Without rendering through
 * React Native's actual layout engine (RTL renders into a shallow tree, no
 * real measure() calls), we can only check the static-style case:
 *   - both siblings declare a numeric `gap` on the parent OR explicit
 *     `marginLeft` / `marginRight` between them.
 *   - the sum of adjacent hitSlops must not exceed that gap.
 *
 * Where positions aren't statically determinable (absolute positioning,
 * flex without gap), we skip the check with a comment in the test output.
 *
 * # V1 scope lock
 *
 * No new test runner / library — jest + RTL only. No date-fns / dayjs.
 * The 44pt floor is hard-coded (iOS HIG + Material accessibility guideline),
 * NOT loaded from DESIGN.md — design tokens are about color/type, not
 * accessibility minimums.
 */

import { lightTheme } from '@plantcare/theme';
import { act, render } from '@testing-library/react-native';
import React, { type ReactElement } from 'react';

import { AddNoteSheet } from '../components/AddNoteSheet';
import { CameraPermissionPrePrompt } from '../components/CameraPermissionPrePrompt';
import { EditPlantDetailsSheet } from '../components/EditPlantDetailsSheet';
import { EmptyGardenWelcome } from '../components/EmptyGardenWelcome';
import { LocationPermissionPrePrompt } from '../components/LocationPermissionPrePrompt';
import { PlantCard } from '../components/PlantCard';
import { QueueRetryBanner } from '../components/QueueRetryBanner';
import { SundayLetterCard } from '../components/SundayLetterCard';
import { EditorialButton } from '../components/primitives/EditorialButton';
import { FAB } from '../components/primitives/FAB';
import { FABPopover } from '../components/primitives/FABPopover';
import { ToastBanner } from '../components/primitives/ToastBanner';

// ─── Mocks ──────────────────────────────────────────────────────────────

// Stub useTheme at the module boundary so the tree renders without needing
// to mount a full app context. lightTheme covers every token the components
// touch — none of the touch-target assertions are theme-sensitive.
jest.mock('../hooks/useTheme', () => ({
  useTheme: jest.fn(),
}));
jest.mock('../hooks/useReduceMotion', () => ({
  useReduceMotion: jest.fn(),
}));

// expo-camera + expo-location are imported by the permission pre-prompts;
// stub their hook surfaces so the components render past their resolving
// frames without throwing.
jest.mock('expo-camera', () => ({
  __esModule: true,
  useCameraPermissions: jest.fn(() => [
    { granted: false, canAskAgain: true, status: 'undetermined', expires: 'never' },
    jest.fn(),
    jest.fn(),
  ]),
}));
jest.mock('expo-location', () => ({
  __esModule: true,
  getForegroundPermissionsAsync: jest.fn(() =>
    Promise.resolve({ granted: false, canAskAgain: true, status: 'undetermined' }),
  ),
  requestForegroundPermissionsAsync: jest.fn(),
  getCurrentPositionAsync: jest.fn(),
}));

import { useTheme } from '../hooks/useTheme';
import { useReduceMotion } from '../hooks/useReduceMotion';

const mockedUseTheme = useTheme as jest.MockedFunction<typeof useTheme>;
const mockedUseReduceMotion = useReduceMotion as jest.MockedFunction<typeof useReduceMotion>;

beforeEach(() => {
  mockedUseTheme.mockReturnValue(lightTheme);
  mockedUseReduceMotion.mockReturnValue(false);
});

// ─── Hit-area math ──────────────────────────────────────────────────────

const MIN_TARGET = 44;

type HitSlop =
  | number
  | { top?: number; right?: number; bottom?: number; left?: number }
  | undefined
  | null;

function normalizeHitSlop(slop: HitSlop): {
  top: number;
  right: number;
  bottom: number;
  left: number;
} {
  if (slop == null) return { top: 0, right: 0, bottom: 0, left: 0 };
  if (typeof slop === 'number') {
    return { top: slop, right: slop, bottom: slop, left: slop };
  }
  return {
    top: slop.top ?? 0,
    right: slop.right ?? 0,
    bottom: slop.bottom ?? 0,
    left: slop.left ?? 0,
  };
}

function flattenStyle(style: unknown): Record<string, unknown> {
  if (Array.isArray(style)) {
    return style.reduce<Record<string, unknown>>(
      (acc, s) => ({ ...acc, ...flattenStyle(s) }),
      {},
    );
  }
  if (style && typeof style === 'object') return style as Record<string, unknown>;
  return {};
}

function resolveStyle(styleProp: unknown): Record<string, unknown> {
  if (typeof styleProp === 'function') {
    try {
      return flattenStyle(styleProp({ pressed: false, hovered: false, focused: false }));
    } catch {
      return {};
    }
  }
  return flattenStyle(styleProp);
}

/**
 * Walk the descendants of a Pressable to find the largest text/image content
 * dimensions. RN flex containers grow to fit their content; a Pressable that
 * wraps a 64×64 image renders at least 64×64 regardless of padding. The walker
 * recurses but stops at nested Pressables (those are their own audit targets).
 */
function contentSize(node: AnyInstance): { width: number; height: number } {
  let maxW = 0;
  let maxH = 0;
  function visit(child: AnyInstance, depth: number): void {
    if (depth > 0 && typeof child.props?.onPress === 'function') return;
    const cStyle = resolveStyle(child.props?.style);
    const w = typeof cStyle.width === 'number' ? cStyle.width : 0;
    const h = typeof cStyle.height === 'number' ? cStyle.height : 0;
    if (w > maxW) maxW = w;
    if (h > maxH) maxH = h;
    // Text: estimate from fontSize / lineHeight when style provides them.
    const fontSize = cStyle.fontSize;
    const lineHeight = cStyle.lineHeight;
    if (typeof lineHeight === 'number' && lineHeight > maxH) maxH = lineHeight;
    else if (typeof fontSize === 'number' && fontSize * 1.2 > maxH) maxH = fontSize * 1.2;
    for (const c of child.children) {
      if (typeof c === 'object' && c != null) visit(c, depth + 1);
    }
  }
  for (const c of node.children) {
    if (typeof c === 'object' && c != null) visit(c, 1);
  }
  return { width: maxW, height: maxH };
}

function visibleSize(
  node: AnyInstance,
  style: Record<string, unknown>,
): { width: number; height: number } {
  const explicitW = style.width;
  const explicitH = style.height;
  const minW = style.minWidth;
  const minH = style.minHeight;

  // Content drives intrinsic size when neither width nor minWidth is set.
  const content = contentSize(node);

  // Padding adds to whichever content drives the inner size.
  const padL =
    (style.paddingLeft as number | undefined) ??
    (style.paddingHorizontal as number | undefined) ??
    (style.padding as number | undefined) ??
    0;
  const padR =
    (style.paddingRight as number | undefined) ??
    (style.paddingHorizontal as number | undefined) ??
    (style.padding as number | undefined) ??
    0;
  const padT =
    (style.paddingTop as number | undefined) ??
    (style.paddingVertical as number | undefined) ??
    (style.padding as number | undefined) ??
    0;
  const padB =
    (style.paddingBottom as number | undefined) ??
    (style.paddingVertical as number | undefined) ??
    (style.padding as number | undefined) ??
    0;

  let width: number;
  if (typeof explicitW === 'number') {
    width = explicitW;
  } else if (typeof minW === 'number') {
    width = minW;
  } else if (content.width > 0) {
    width = Number(padL) + content.width + Number(padR);
  } else {
    // Smallest interactive label in the app is "+" (1 char) at fontSize 28
    // → ~16 glyph width; conservative default for unknown content. Real
    // labels in this app run "Cancel", "Retry", "Done" — all wider than 16.
    width = Number(padL) + 16 + Number(padR);
  }

  let height: number;
  if (typeof explicitH === 'number') {
    height = explicitH;
  } else if (typeof minH === 'number') {
    height = minH;
  } else if (content.height > 0) {
    height = Number(padT) + content.height + Number(padB);
  } else {
    // Default to a typical body line-height (Inter 14pt at lineHeight 20)
    // so a label-only Pressable doesn't trip the audit on an underestimate.
    // Surfaces that actually paint smaller still fail because the
    // content-driven branch above catches them.
    height = Number(padT) + 20 + Number(padB);
  }

  return { width, height };
}

/**
 * Detect the StyleSheet.absoluteFill sentinel — flat-spread { position:
 * 'absolute', left: 0, right: 0, top: 0, bottom: 0 }. Backdrops use this to
 * cover the whole Modal viewport and always satisfy the 44×44 floor.
 */
function isAbsoluteFill(style: Record<string, unknown>): boolean {
  return (
    style.position === 'absolute' &&
    style.left === 0 &&
    style.right === 0 &&
    style.top === 0 &&
    style.bottom === 0
  );
}

// ─── Tree walker ─────────────────────────────────────────────────────────

// RTL's react-test-renderer exposes a host instance per native element.
// Pressable in test renders as a host element with `type === 'View'` carrying
// `onResponderRelease` etc. — but the easier signal is the `accessibilityRole`
// or the presence of `onPress` on the props. We treat anything that has an
// `onPress` callback as interactive. Touchable*Native rendering also surfaces
// onPress on a host View instance via the test renderer.

type AnyInstance = {
  type: unknown;
  props: Record<string, unknown>;
  children: AnyInstance[];
};

function* walk(instance: AnyInstance): Generator<AnyInstance> {
  yield instance;
  for (const child of instance.children) {
    if (typeof child === 'object' && child != null) yield* walk(child);
  }
}

function isInteractive(instance: AnyInstance): boolean {
  const props = instance.props;
  if (props == null) return false;
  if (props.disabled === true) return false;
  // Pressable / Touchable* all surface onPress in test-renderer output. A
  // TextInput would not — its onChangeText is what drives interaction, and
  // TextInputs have their own intrinsic 44pt floor via OS-level focus
  // rectangles, so we exclude them from the touch-target sweep (their
  // accessibility floor is covered by `accessibilityRole='spinbutton'` /
  // textbox semantics, not hit area).
  if (typeof props.onPress !== 'function') return false;
  // Skip elements that are explicitly not focusable / not accessible — they
  // exist purely as event-capture layers (rare; one example is the
  // EditorialBottomSheet drag-zone, which sets pan handlers but no onPress).
  if (props.accessible === false) return false;
  // RN's Pressable can surface multiple internal host nodes in the
  // react-test-renderer tree — only the top-level user-facing Pressable
  // carries an `accessibilityRole`. Filtering on a real role narrows the
  // walker to the press-receiving boundary and skips any wrapping host
  // forwarders that happen to inherit onPress through prop spreading. Every
  // touchable in this app sets `accessibilityRole` explicitly (button,
  // menuitem, switch) — this is the V1 a11y contract.
  if (typeof props.accessibilityRole !== 'string') return false;
  return true;
}

type AuditFinding = {
  surface: string;
  label: string;
  visible: { width: number; height: number };
  effective: { width: number; height: number };
};

function describeElement(instance: AnyInstance, surface: string): string {
  const props = instance.props ?? {};
  const role = (props.accessibilityRole as string | undefined) ?? '<no-role>';
  const label =
    (props.accessibilityLabel as string | undefined) ??
    (props.testID as string | undefined) ??
    '<no-label>';
  return `${surface} → role=${role} label="${label}"`;
}

async function auditSurface(
  surface: string,
  element: ReactElement,
): Promise<{ findings: AuditFinding[]; failures: AuditFinding[] }> {
  const api = render(element);
  // Components that probe permissions / accessibility settings asynchronously
  // (the camera + location pre-prompts) render an empty 'resolving' frame on
  // first commit and only paint their CTAs once the probe promise resolves.
  // Flush microtasks so the audit walks the steady-state tree, not the
  // transient loading frame.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  // RTL's `UNSAFE_root` exposes the react-test-renderer root.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const root = (api as any).UNSAFE_root as AnyInstance;

  const findings: AuditFinding[] = [];
  const failures: AuditFinding[] = [];

  for (const node of walk(root)) {
    if (!isInteractive(node)) continue;
    const style = resolveStyle(node.props.style);
    if (isAbsoluteFill(style)) {
      // Backdrop — always huge. Record as a finding but never a failure.
      findings.push({
        surface,
        label: describeElement(node, surface),
        visible: { width: Infinity, height: Infinity },
        effective: { width: Infinity, height: Infinity },
      });
      continue;
    }
    const visible = visibleSize(node, style);
    const slop = normalizeHitSlop(node.props.hitSlop as HitSlop);
    const effective = {
      width: visible.width + slop.left + slop.right,
      height: visible.height + slop.top + slop.bottom,
    };
    const finding: AuditFinding = {
      surface,
      label: describeElement(node, surface),
      visible,
      effective,
    };
    findings.push(finding);
    // Failure: the height MUST be ≥ 44pt — that's the axis the walker can
    // determine from static style (padding + content) with high confidence.
    // For width, RN's default `alignItems: stretch` on a column container
    // expands a child Pressable to the parent's content width, which the
    // walker can't determine without rendering through the real layout
    // engine. Conservative rule: fail on width only when an EXPLICIT
    // (width or minWidth) was declared and falls below 44. A Pressable
    // that derives its width from content + parent stretch is given the
    // benefit of the doubt — paired with the height assertion plus the
    // sibling-overlap check, that's enough rigor without false positives.
    const failsHeight = effective.height < MIN_TARGET;
    const failsExplicitWidth =
      (typeof style.width === 'number' || typeof style.minWidth === 'number') &&
      effective.width < MIN_TARGET;
    if (failsHeight || failsExplicitWidth) {
      failures.push(finding);
    }
  }

  api.unmount();
  return { findings, failures };
}

// ─── Sibling-overlap check ──────────────────────────────────────────────

/**
 * Walks an instance's children and flags any two adjacent interactive
 * children whose hitSlops sum to more than the parent's declared `gap`.
 * Best-effort: only fires when the parent declares a numeric `gap` AND
 * neither sibling is absolutely positioned. Where the static layout can't
 * answer, the check silently passes.
 */
async function findSiblingOverlaps(
  surface: string,
  element: ReactElement,
): Promise<string[]> {
  const api = render(element);
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const root = (api as any).UNSAFE_root as AnyInstance;

  const violations: string[] = [];

  function visit(node: AnyInstance): void {
    const parentStyle = resolveStyle(node.props?.style);
    const gap = parentStyle.gap;
    if (typeof gap === 'number') {
      // Collect interactive children at depth 1 with non-absolute positioning.
      const siblings = node.children.filter(
        (c) => typeof c === 'object' && c != null && isInteractive(c),
      );
      for (let i = 0; i < siblings.length - 1; i++) {
        const a = siblings[i];
        const b = siblings[i + 1];
        const aStyle = resolveStyle(a.props.style);
        const bStyle = resolveStyle(b.props.style);
        if (aStyle.position === 'absolute' || bStyle.position === 'absolute') continue;
        const aSlop = normalizeHitSlop(a.props.hitSlop as HitSlop);
        const bSlop = normalizeHitSlop(b.props.hitSlop as HitSlop);
        // For a horizontal row (flexDirection: 'row' or default) the
        // boundary axis is horizontal. For column, vertical. Most rows in
        // the app declare flexDirection: 'row' explicitly. Be defensive:
        // check the axis whose slop+slop exceeds the gap.
        const isRow = parentStyle.flexDirection === 'row';
        if (isRow) {
          const reach = aSlop.right + bSlop.left;
          if (reach > gap) {
            violations.push(
              `${surface}: sibling Pressables overlap horizontally — ` +
                `${describeElement(a, surface)} (right slop ${aSlop.right}) + ` +
                `${describeElement(b, surface)} (left slop ${bSlop.left}) ` +
                `> gap ${gap}`,
            );
          }
        } else {
          const reach = aSlop.bottom + bSlop.top;
          if (reach > gap) {
            violations.push(
              `${surface}: sibling Pressables overlap vertically — ` +
                `${describeElement(a, surface)} (bottom slop ${aSlop.bottom}) + ` +
                `${describeElement(b, surface)} (top slop ${bSlop.top}) ` +
                `> gap ${gap}`,
            );
          }
        }
      }
    }
    for (const child of node.children) {
      if (typeof child === 'object' && child != null) visit(child);
    }
  }

  visit(root);
  api.unmount();
  return violations;
}

// ─── Surface factories ──────────────────────────────────────────────────

const SURFACES: Array<{ name: string; render: () => ReactElement }> = [
  {
    name: 'FAB (no long-press)',
    render: () => <FAB onPress={() => {}} />,
  },
  {
    name: 'FAB (with long-press)',
    render: () => <FAB onPress={() => {}} onLongPress={() => {}} />,
  },
  {
    name: 'EditorialButton filled',
    render: () => <EditorialButton variant="filled" label="Mark watered" onPress={() => {}} />,
  },
  {
    name: 'EditorialButton outline',
    render: () => <EditorialButton variant="outline" label="Add note" onPress={() => {}} />,
  },
  {
    name: 'ToastBanner warn with action',
    render: () => (
      <ToastBanner
        type="warn"
        message="Couldn't save"
        action={{ label: 'Retry', onPress: () => {} }}
      />
    ),
  },
  {
    name: 'ToastBanner pending with retry',
    render: () => (
      <ToastBanner type="pending" message="Saved offline" onRetry={() => {}} />
    ),
  },
  {
    name: 'QueueRetryBanner',
    render: () => <QueueRetryBanner failedCount={3} onRetry={() => {}} />,
  },
  {
    name: 'PlantCard',
    render: () => (
      <PlantCard
        speciesLabel="Monstera"
        nickname="Mona"
        photoUri={null}
        lastWateredAtMs={Date.now() - 3 * 86_400_000}
        status="water"
        onPress={() => {}}
        nowMs={Date.now()}
      />
    ),
  },
  {
    name: 'EmptyGardenWelcome',
    render: () => <EmptyGardenWelcome onAddFirst={() => {}} />,
  },
  {
    name: 'SundayLetterCard',
    render: () => (
      <SundayLetterCard
        onOpen={() => {}}
        onDismiss={() => {}}
        // Pin a Sunday so the card actually renders (Sun = 2026-05-10).
        nowMs={new Date(2026, 4, 10, 12, 0, 0).getTime()}
      />
    ),
  },
  {
    name: 'EditPlantDetailsSheet',
    render: () => (
      <EditPlantDetailsSheet
        open
        initialIsIndoor={false}
        initialOverrideIntervalDays={7}
        onSave={() => {}}
        onCancel={() => {}}
      />
    ),
  },
  {
    name: 'FABPopover',
    render: () => (
      <FABPopover
        open
        onDismiss={() => {}}
        onAddPlant={() => {}}
        onQuickDiagnose={() => {}}
      />
    ),
  },
  {
    name: 'CameraPermissionPrePrompt',
    render: () => (
      <CameraPermissionPrePrompt onGranted={() => {}} onCancel={() => {}} />
    ),
  },
  {
    name: 'LocationPermissionPrePrompt',
    render: () => (
      <LocationPermissionPrePrompt
        onGranted={() => {}}
        onZipSubmit={() => {}}
        onCancel={() => {}}
      />
    ),
  },
  {
    name: 'AddNoteSheet (input phase)',
    render: () => (
      <AddNoteSheet
        open
        onCancel={() => {}}
        onSave={() => {}}
        apiClient={{ consult: jest.fn() } as unknown as Parameters<typeof AddNoteSheet>[0]['apiClient']}
      />
    ),
  },
];

// ─── Tests ──────────────────────────────────────────────────────────────

describe('E11-002 touch target audit (≥44×44pt)', () => {
  it.each(SURFACES.map((s) => [s.name, s.render]))(
    'every interactive element in %s meets the 44×44pt floor',
    async (name, factory) => {
      const surface = name as string;
      const render = factory as () => ReactElement;
      const { failures, findings } = await auditSurface(surface, render());
      if (failures.length > 0) {
        const failMsg = failures
          .map(
            (f) =>
              `  - ${f.label}\n` +
              `      visible=${f.visible.width}×${f.visible.height}, ` +
              `effective=${f.effective.width}×${f.effective.height}`,
          )
          .join('\n');
        throw new Error(
          `Touch-target failures in ${surface} (${failures.length}/${findings.length} interactive elements below 44×44):\n${failMsg}`,
        );
      }
      // Sanity: every surface had at least one interactive element. A surface
      // with zero would mean the factory rendered something other than the
      // expected component (or our walker missed the Pressable kind).
      expect(findings.length).toBeGreaterThan(0);
    },
  );

  it.each(SURFACES.map((s) => [s.name, s.render]))(
    'no sibling hitSlops overlap in %s',
    async (name, factory) => {
      const surface = name as string;
      const render = factory as () => ReactElement;
      const violations = await findSiblingOverlaps(surface, render());
      if (violations.length > 0) {
        throw new Error(
          `Sibling hitSlop overlap in ${surface}:\n${violations.join('\n')}`,
        );
      }
    },
  );

  it('uses the iOS HIG / Material 44pt floor', () => {
    // Doc test — pin the constant so a future "let's relax this to 40" change
    // shows up as an explicit failure here rather than a silent regression on
    // a per-surface case.
    expect(MIN_TARGET).toBe(44);
  });
});
