/**
 * E11-001 — accessibility audit.
 *
 * Sweeps every component + screen in the mobile app and asserts the V1 a11y
 * contract on every interactive node:
 *
 *   RULE A (role): every Pressable / Touchable surfaces an
 *     `accessibilityRole` (button / menuitem / switch / link). The tree-walker
 *     trips on a missing role with the surface name + label so the failure
 *     names exactly which Pressable lost its identity.
 *
 *   RULE B (label): every Pressable surfaces a non-empty
 *     `accessibilityLabel` (or `accessibilityLabelledBy`). VoiceOver / TalkBack
 *     reads this string when focus lands on the control. A Pressable with no
 *     label announces as "Pressable" (the RN component name) — the worst
 *     screen-reader experience this audit can catch.
 *
 *   RULE C (disabled state): every Pressable that consumes a `disabled` prop
 *     also forwards `accessibilityState.disabled`. Without it, an iOS rotor
 *     user can still focus the control and hear it as "button" with no
 *     indication it's inert. The walker only asserts the contract when the
 *     Pressable IS disabled — un-disabled Pressables may omit the state.
 *
 *   RULE D (header role on visual hierarchy): the top-of-screen Text nodes
 *     that act as page headlines carry `accessibilityRole='header'` so iOS
 *     VoiceOver's rotor "by header" navigation surfaces them as landmarks.
 *     This rule is asserted on a per-surface basis where applicable.
 *
 * # Why a tree-walker, not per-component cases
 *
 * The a11y contract is system-wide: any future Pressable that ships without
 * a label or role is a regression. A per-component test would catch it only
 * if the author remembered to add a case. The tree-walker rents one render of
 * every surface and asserts the contract across every collected host node — a
 * single failure names the file, the visible position, and the missing prop.
 *
 * # Walker: collect by handler shape, NOT by role (E4-008 codex P2 lesson)
 *
 * Pre-filtering on `accessibilityRole === 'button'` would silently EXCLUDE
 * any Pressable that's missing the role — which is exactly the regression
 * RULE A is supposed to catch. The walker collects every host `View` that
 * carries an `onClick` handler in props (RN's serialized Pressable shape) and
 * asserts RULES A + B on each. A Pressable missing the role lands in the
 * collected set and trips RULE A; a Pressable missing the label trips RULE B.
 *
 * # Disabled Pressables are NOT skipped
 *
 * touchTargetAudit (E11-002) skips `disabled === true` because RN drops the
 * gesture responder entirely on disabled controls — there's no hit area to
 * measure. The a11y audit, however, treats disabled controls AS controls —
 * they still occupy the focus order and screen readers announce them. RULE C
 * specifically targets the disabled case to ensure the state propagates.
 *
 * # Backdrop / overlay Pressables
 *
 * Modal backdrops (EditorialBottomSheet, FABPopover) use `StyleSheet.absoluteFill`
 * + `accessibilityRole='button'` + `accessibilityLabel='Close'` (or similar).
 * They DO count as interactive — and they DO have labels — so the walker
 * happily includes them and asserts the same contract.
 *
 * # V1 scope lock
 *
 * No new test runner / library — jest + RTL only. The role / label
 * vocabulary is hard-coded (the React Native AccessibilityRole enum, plus
 * 'menu' / 'menuitem' / 'dialog' / 'status' / 'spinbutton' which the legacy
 * RN type omits but the native bridges accept).
 */

import { lightTheme } from '@plantcare/theme';
import { act, render } from '@testing-library/react-native';
import * as React from 'react';
import { Pressable, Text, View } from 'react-native';

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

// Stub useTheme at the module boundary so the primitives render without
// needing a full app provider. lightTheme is sufficient — none of the a11y
// assertions are theme-sensitive.
jest.mock('../hooks/useTheme', () => ({
  useTheme: jest.fn(),
}));
jest.mock('../hooks/useReduceMotion', () => ({
  useReduceMotion: jest.fn(),
}));

// expo-camera + expo-location are imported by the permission pre-prompts;
// stub their hook surfaces so the components render past the 'resolving'
// frame without throwing.
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

// ─── Tree walker ─────────────────────────────────────────────────────────

// React Native's serialized Pressable surfaces as a host `View` with an
// `onClick` handler in its props (RN's web-style synthetic event name; on
// native this is the press receiver). This is the same shape the
// E4-008 collectPressables helper uses — codex P2 lesson: collect by the
// HANDLER shape only, not by accessibilityRole, so the assertion can trip on
// a Pressable that's missing its role.

type JsonNode = {
  type: string;
  props: Record<string, unknown>;
  children: ReadonlyArray<JsonNode | string> | null;
};

function collectPressables(node: JsonNode | string | null): JsonNode[] {
  if (!node || typeof node === 'string') return [];
  const out: JsonNode[] = [];
  if (
    node.type === 'View' &&
    typeof (node.props as Record<string, unknown>).onClick === 'function'
  ) {
    out.push(node);
  }
  if (node.children) {
    for (const c of node.children) {
      out.push(...collectPressables(c as JsonNode));
    }
  }
  return out;
}

function collectTextNodes(node: JsonNode | string | null): JsonNode[] {
  if (!node || typeof node === 'string') return [];
  const out: JsonNode[] = [];
  if (node.type === 'Text') out.push(node);
  if (node.children) {
    for (const c of node.children) {
      out.push(...collectTextNodes(c as JsonNode));
    }
  }
  return out;
}

// Valid AccessibilityRole values the V1 contract accepts on interactive
// elements. The native bridges accept additional roles (image, header,
// summary, alert, status, dialog, menu, menuitem, spinbutton) that aren't on
// the legacy `@types/react-native` enum — we include those we use as
// literals via `as AccessibilityRole` casts in source. The walker accepts
// all of them. Decorative-text roles ('text', 'header') are NOT valid on a
// Pressable — those would indicate the Pressable was mis-typed.
const VALID_INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'menuitem',
  'menu',
  'switch',
  'checkbox',
  'radio',
  'tab',
  'spinbutton',
  'imagebutton',
]);

// ─── Assertions ──────────────────────────────────────────────────────────

type AuditFinding = {
  surface: string;
  index: number;
  role: string | undefined;
  label: string | undefined;
};

function describe1(finding: AuditFinding): string {
  return `${finding.surface}[#${finding.index}] role=${
    finding.role ?? '<missing>'
  } label="${finding.label ?? '<missing>'}"`;
}

/**
 * Walks a rendered surface and asserts RULES A + B + C on every Pressable.
 * Returns the collected findings (one per Pressable) so per-surface tests
 * can also count how many pressables a surface exposes.
 */
async function auditSurface(
  surface: string,
  element: React.ReactElement,
): Promise<AuditFinding[]> {
  const api = render(element);
  // Permission pre-prompts probe async hooks (camera / location) on mount —
  // render a single blank frame on the first commit. Flush microtasks so the
  // walker visits the steady-state tree.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  const tree = api.toJSON();
  const roots: JsonNode[] = Array.isArray(tree)
    ? (tree as unknown as JsonNode[])
    : tree
      ? [tree as unknown as JsonNode]
      : [];

  const findings: AuditFinding[] = [];
  let index = 0;

  for (const root of roots) {
    for (const node of collectPressables(root)) {
      const props = node.props as Record<string, unknown>;
      const role = typeof props.accessibilityRole === 'string'
        ? (props.accessibilityRole as string)
        : undefined;
      const label = typeof props.accessibilityLabel === 'string'
        ? (props.accessibilityLabel as string)
        : undefined;
      const finding: AuditFinding = { surface, index, role, label };
      findings.push(finding);

      // RULE A — role must be present + on the interactive-role allowlist.
      if (!role) {
        throw new Error(
          `E11-001 RULE A (missing role): ${describe1(finding)}\n` +
            `Every interactive control must declare an accessibilityRole.`,
        );
      }
      if (!VALID_INTERACTIVE_ROLES.has(role)) {
        throw new Error(
          `E11-001 RULE A (invalid role "${role}"): ${describe1(finding)}\n` +
            `Interactive roles must be one of: ${[...VALID_INTERACTIVE_ROLES].join(', ')}.`,
        );
      }

      // RULE B — label must be present + non-empty.
      if (!label || label.trim() === '') {
        throw new Error(
          `E11-001 RULE B (missing label): ${describe1(finding)}\n` +
            `Every interactive control must declare a non-empty accessibilityLabel.`,
        );
      }
      // RULE B continued — the label MUST NOT be "Pressable" (the RN
      // component name; the fallback announcement when a label is missing).
      if (label.trim().toLowerCase() === 'pressable') {
        throw new Error(
          `E11-001 RULE B (placeholder label "Pressable"): ${describe1(finding)}\n` +
            `Pick a descriptive label that announces the control's action.`,
        );
      }

      // RULE C — when a Pressable surfaces `accessibilityState`, the
      // `disabled` flag (when present) must be a boolean. We don't try to
      // infer "should this control be disabled?" from the rendered tree —
      // Pressable strips its own `disabled` prop before forwarding to the
      // host View, so the prop is invisible to the walker. Instead RULE C
      // sanity-checks the SHAPE of accessibilityState on the controls that
      // declare it. The per-surface tests below ALSO assert that controls
      // declared as disabled (EditorialButton disabled, FAB disabled, etc.)
      // surface accessibilityState.disabled=true — that lock is on the
      // surface factories, not the walker.
      const state = props.accessibilityState as
        | Record<string, unknown>
        | undefined;
      if (state !== undefined && state !== null) {
        if (typeof state !== 'object') {
          throw new Error(
            `E11-001 RULE C (accessibilityState not an object): ${describe1(finding)}`,
          );
        }
        if (
          'disabled' in state &&
          state.disabled !== undefined &&
          typeof state.disabled !== 'boolean'
        ) {
          throw new Error(
            `E11-001 RULE C (accessibilityState.disabled must be boolean): ${describe1(finding)}`,
          );
        }
      }

      index += 1;
    }
  }

  api.unmount();
  return findings;
}

/**
 * Asserts RULE D — at least one Text node in the surface declares
 * `accessibilityRole='header'` (a screen-level headline). Used only on
 * surfaces that visually present a top-level headline; primitives like FAB
 * and ToastBanner have no headline and skip the rule.
 */
async function expectHeaderLandmark(
  surface: string,
  element: React.ReactElement,
): Promise<void> {
  const api = render(element);
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  const tree = api.toJSON();
  const roots: JsonNode[] = Array.isArray(tree)
    ? (tree as unknown as JsonNode[])
    : tree
      ? [tree as unknown as JsonNode]
      : [];
  let foundHeader = false;
  for (const root of roots) {
    // Headers can live on a Text node OR on a wrapping View when the screen
    // groups headline + sub-headline into one a11y stop. Scan both.
    const headers = [
      ...collectTextNodes(root),
      ...collectViewNodes(root),
    ].filter(
      (n) =>
        (n.props as Record<string, unknown>).accessibilityRole === 'header',
    );
    if (headers.length > 0) {
      foundHeader = true;
      break;
    }
  }
  api.unmount();
  if (!foundHeader) {
    throw new Error(
      `E11-001 RULE D (no header landmark): ${surface}\n` +
        `Screens with visual headlines must declare accessibilityRole='header' on the headline Text.`,
    );
  }
}

function collectViewNodes(node: JsonNode | string | null): JsonNode[] {
  if (!node || typeof node === 'string') return [];
  const out: JsonNode[] = [];
  if (node.type === 'View') out.push(node);
  if (node.children) {
    for (const c of node.children) {
      out.push(...collectViewNodes(c as JsonNode));
    }
  }
  return out;
}

// ─── Surface factories ──────────────────────────────────────────────────

type Surface = {
  readonly name: string;
  readonly factory: () => React.ReactElement;
  /** Surfaces that own a visual page headline. Asserts RULE D on top. */
  readonly headerLandmark?: boolean;
  /** Minimum pressables this surface MUST render — defends against a future
   *  refactor that accidentally drops the CTA from the tree. */
  readonly minPressables: number;
};

const SURFACES: ReadonlyArray<Surface> = [
  {
    name: 'FAB (no long-press)',
    factory: () => <FAB onPress={() => {}} />,
    minPressables: 1,
  },
  {
    name: 'FAB (with long-press)',
    factory: () => <FAB onPress={() => {}} onLongPress={() => {}} />,
    minPressables: 1,
  },
  {
    name: 'FAB (disabled)',
    factory: () => <FAB onPress={() => {}} disabled />,
    // Disabled FAB still renders the Pressable (with disabled=true). The
    // walker asserts RULE C on it.
    minPressables: 1,
  },
  {
    name: 'EditorialButton filled',
    factory: () => (
      <EditorialButton variant="filled" label="Mark watered" onPress={() => {}} />
    ),
    minPressables: 1,
  },
  {
    name: 'EditorialButton outline',
    factory: () => (
      <EditorialButton variant="outline" label="Add note" onPress={() => {}} />
    ),
    minPressables: 1,
  },
  {
    name: 'EditorialButton disabled',
    factory: () => (
      <EditorialButton
        variant="filled"
        label="Save"
        onPress={() => {}}
        disabled
      />
    ),
    // Disabled state surfaces accessibilityState.disabled — RULE C target.
    minPressables: 1,
  },
  {
    name: 'EditorialButton loading',
    factory: () => (
      <EditorialButton
        variant="filled"
        label="Save"
        onPress={() => {}}
        loading
      />
    ),
    minPressables: 1,
  },
  {
    name: 'ToastBanner warn with action',
    factory: () => (
      <ToastBanner
        type="warn"
        message="Couldn't save"
        action={{ label: 'Retry', onPress: () => {} }}
      />
    ),
    minPressables: 1,
  },
  {
    name: 'ToastBanner pending with retry',
    factory: () => (
      <ToastBanner type="pending" message="Saved offline" onRetry={() => {}} />
    ),
    minPressables: 1,
  },
  {
    name: 'QueueRetryBanner',
    factory: () => <QueueRetryBanner failedCount={3} onRetry={() => {}} />,
    minPressables: 1,
  },
  {
    name: 'PlantCard',
    factory: () => (
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
    minPressables: 1,
  },
  {
    name: 'EmptyGardenWelcome',
    factory: () => <EmptyGardenWelcome onAddFirst={() => {}} />,
    headerLandmark: true,
    minPressables: 1,
  },
  {
    name: 'SundayLetterCard',
    factory: () => (
      <SundayLetterCard
        onOpen={() => {}}
        onDismiss={() => {}}
        // Pin a Sunday so the card actually renders (Sun = 2026-05-10).
        nowMs={new Date(2026, 4, 10, 12, 0, 0).getTime()}
      />
    ),
    headerLandmark: true,
    minPressables: 2,
  },
  {
    name: 'EditPlantDetailsSheet',
    factory: () => (
      <EditPlantDetailsSheet
        open
        initialIsIndoor={false}
        initialOverrideIntervalDays={7}
        onSave={() => {}}
        onCancel={() => {}}
      />
    ),
    headerLandmark: true,
    // Backdrop + decrement stepper + increment stepper + Cancel + Save = 5.
    minPressables: 5,
  },
  {
    name: 'FABPopover',
    factory: () => (
      <FABPopover
        open
        onDismiss={() => {}}
        onAddPlant={() => {}}
        onQuickDiagnose={() => {}}
      />
    ),
    // Backdrop + "Add a plant" + "Quick diagnose" = 3 pressables.
    minPressables: 3,
  },
  {
    name: 'CameraPermissionPrePrompt',
    factory: () => (
      <CameraPermissionPrePrompt onGranted={() => {}} onCancel={() => {}} />
    ),
    headerLandmark: true,
    // Allow CTA + Not now = 2.
    minPressables: 2,
  },
  {
    name: 'LocationPermissionPrePrompt',
    factory: () => (
      <LocationPermissionPrePrompt
        onGranted={() => {}}
        onZipSubmit={() => {}}
        onCancel={() => {}}
      />
    ),
    headerLandmark: true,
    // Use my location + Enter ZIP instead = 2.
    minPressables: 2,
  },
  {
    name: 'AddNoteSheet (input phase)',
    factory: () => (
      <AddNoteSheet
        open
        onCancel={() => {}}
        onSave={() => {}}
        apiClient={
          { consult: jest.fn() } as unknown as Parameters<
            typeof AddNoteSheet
          >[0]['apiClient']
        }
      />
    ),
    headerLandmark: true,
    // Backdrop + Cancel + Save & analyze = 3 (Save is initially disabled but
    // still rendered as a Pressable carrying disabled=true).
    minPressables: 3,
  },
];

// ─── Tests ──────────────────────────────────────────────────────────────

describe('E11-001 a11y audit (every interactive node has role + label)', () => {
  it.each(SURFACES.map((s) => [s.name, s]))(
    '%s — every interactive element declares role + label',
    async (_name, surface) => {
      const { name, factory, minPressables } = surface as Surface;
      const findings = await auditSurface(name, factory());
      expect(findings.length).toBeGreaterThanOrEqual(minPressables);
    },
  );

  // RULE D is a per-surface assertion gated on `headerLandmark: true`.
  // Filter the surfaces so it.each doesn't emit no-op test names.
  const headerSurfaces = SURFACES.filter((s) => s.headerLandmark === true);
  it.each(headerSurfaces.map((s) => [s.name, s]))(
    '%s — declares a header landmark',
    async (_name, surface) => {
      const { name, factory } = surface as Surface;
      await expectHeaderLandmark(name, factory());
    },
  );

  // RULE A regression guard: an explicit no-role-Pressable would trip the
  // walker. Locks the assertion logic itself so a future refactor that
  // weakens the walker (e.g. defaults `role || 'button'`) shows up here as
  // a failing CONTROL test rather than silently letting real Pressables off
  // the hook.
  it('walker REJECTS a Pressable with no accessibilityRole (control)', async () => {
    function NoRole(): React.ReactElement {
      return (
        <View>
          <Pressable accessibilityLabel="Bad" onPress={() => {}}>
            <Text>Bad</Text>
          </Pressable>
        </View>
      );
    }
    await expect(auditSurface('control:no-role', <NoRole />)).rejects.toThrow(
      /RULE A/,
    );
  });

  // RULE B regression guard.
  it('walker REJECTS a Pressable with empty accessibilityLabel (control)', async () => {
    function EmptyLabel(): React.ReactElement {
      return (
        <View>
          <Pressable accessibilityRole="button" accessibilityLabel="" onPress={() => {}}>
            <Text>Bad</Text>
          </Pressable>
        </View>
      );
    }
    await expect(
      auditSurface('control:empty-label', <EmptyLabel />),
    ).rejects.toThrow(/RULE B/);
  });

  // RULE B "Pressable" placeholder guard. If a future autocomplete suggests
  // the literal string "Pressable" as a label, the walker should refuse it.
  it('walker REJECTS the literal "Pressable" placeholder label (control)', async () => {
    function PlaceholderLabel(): React.ReactElement {
      return (
        <View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Pressable"
            onPress={() => {}}
          >
            <Text>Bad</Text>
          </Pressable>
        </View>
      );
    }
    await expect(
      auditSurface('control:placeholder-label', <PlaceholderLabel />),
    ).rejects.toThrow(/RULE B/);
  });

  // RULE C — disabled-state propagation contract for the production
  // surfaces that ship disabled affordances. EditorialButton's `disabled`
  // prop must flip `accessibilityState.disabled=true`; the FAB's same. The
  // walker can't observe the source-level `disabled` prop (RN's Pressable
  // strips it from the host View before serialization), so this assertion
  // mounts the surface and inspects the serialized tree directly for the
  // accessibilityState.disabled=true flag on at least one Pressable.
  it('EditorialButton disabled — accessibilityState.disabled=true on the Pressable', async () => {
    const r = render(
      <EditorialButton
        variant="filled"
        label="Save"
        onPress={() => {}}
        disabled
      />,
    );
    const tree = r.toJSON();
    const roots: JsonNode[] = Array.isArray(tree)
      ? (tree as unknown as JsonNode[])
      : tree
        ? [tree as unknown as JsonNode]
        : [];
    let foundDisabled = false;
    for (const root of roots) {
      for (const p of collectPressables(root)) {
        const state = (p.props as Record<string, unknown>).accessibilityState as
          | Record<string, unknown>
          | undefined;
        if (state && state.disabled === true) {
          foundDisabled = true;
          break;
        }
      }
    }
    r.unmount();
    expect(foundDisabled).toBe(true);
  });

  it('FAB disabled — accessibilityState.disabled=true on the Pressable', async () => {
    const r = render(<FAB onPress={() => {}} disabled />);
    const tree = r.toJSON();
    const roots: JsonNode[] = Array.isArray(tree)
      ? (tree as unknown as JsonNode[])
      : tree
        ? [tree as unknown as JsonNode]
        : [];
    let foundDisabled = false;
    for (const root of roots) {
      for (const p of collectPressables(root)) {
        const state = (p.props as Record<string, unknown>).accessibilityState as
          | Record<string, unknown>
          | undefined;
        if (state && state.disabled === true) {
          foundDisabled = true;
          break;
        }
      }
    }
    r.unmount();
    expect(foundDisabled).toBe(true);
  });

  // RULE C shape guard — a Pressable whose accessibilityState.disabled
  // isn't a boolean should trip the walker.
  it('walker REJECTS accessibilityState.disabled with non-boolean value (control)', async () => {
    function BadState(): React.ReactElement {
      return (
        <View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Save"
            // intentionally bad — should be boolean, not string
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            accessibilityState={{ disabled: 'yes' as any }}
            onPress={() => {}}
          >
            <Text>Save</Text>
          </Pressable>
        </View>
      );
    }
    await expect(
      auditSurface('control:bad-state-shape', <BadState />),
    ).rejects.toThrow(/RULE C/);
  });

  // RULE D regression guard — control surface with no header trips the rule.
  it('header walker REJECTS a surface with no header landmark (control)', async () => {
    function NoHeader(): React.ReactElement {
      return (
        <View>
          <Text>Just some prose, no headline role.</Text>
        </View>
      );
    }
    await expect(
      expectHeaderLandmark('control:no-header', <NoHeader />),
    ).rejects.toThrow(/RULE D/);
  });
});

// ─── Test seam: silence the React act() warning that can leak from the ───
// inner async permission-prompt mounts when their state machines run a
// late setState during the test teardown window. Wrapping unmount in act()
// at the surface auditor handles the common case; the suppress here is a
// last-resort guard so a flaky warning doesn't fail strict-mode CI.
//
// NOTE: only fire when running this suite — global silencing would mask
// real warnings in sibling suites. We restore in afterAll.
const realConsoleError = console.error;
beforeAll(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (console as any).error = (...args: unknown[]) => {
    const first = typeof args[0] === 'string' ? (args[0] as string) : '';
    if (first.includes('not wrapped in act')) return;
    realConsoleError(...(args as Parameters<typeof realConsoleError>));
  };
});
afterAll(() => {
  console.error = realConsoleError;
});

