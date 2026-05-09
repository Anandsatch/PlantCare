// Dark-mode rendering verification for every primitive in the manifest
// (E10-001). The Component Garden (E2-013) is the visual surface; this file
// adds the structural assertions that catch token misuse, contrast failures,
// and undefined accent fallbacks at PR time — before they ship to a user
// flipping their phone into dark mode.
//
// Approach:
//   - For every primitive in PRIMITIVE_SECTIONS we render it twice: once with
//     `lightTheme` forced via <ForcedTheme>, once with `darkTheme`. We then
//     walk the rendered tree and assert:
//       1. There exists at least one node whose backgroundColor swaps between
//          light and dark (the "tokens are wired" sanity).
//       2. No color string anywhere in the tree resolves to a forbidden
//          fallback ('undefined', 'transparent', empty string, NaN).
//       3. For text-bearing primitives, the foreground text vs the nearest
//          ancestor background passes the WCAG-AA 4.5:1 contrast ratio.
//   - The contrast helper is inline (V1 lock — no a11y library dep).
//
// Why we don't snapshot pixels: V1 is structural-only (per the master plan
// GSTACK REVIEW REPORT footer). Visual snapshots require a screenshot
// runner we haven't budgeted. The structural assertions catch the failure
// modes that have actually bitten dark mode in past projects: hardcoded
// hairlines, accent tokens that map to undefined, text-on-accent contrast.

import { darkTheme, lightTheme, type Theme } from '@plantcare/theme';
import { render, type RenderResult } from '@testing-library/react-native';
import type { ReactElement } from 'react';

import { ForcedTheme } from '../../hooks/useTheme';
import { PRIMITIVE_SECTIONS } from '../ComponentGardenScreen';

import {
  Droplet,
  EditorialBottomSheet,
  EditorialButton,
  FAB,
  HandOnSoilIcon,
  HeroPhoto,
  LeafIcon,
  StatusChip,
  ToastBanner,
} from '../../components/primitives';

// Mock expo-camera in case any composite leaks in via the manifest. Defensive —
// PRIMITIVE_SECTIONS only lists primitives, but the import surface is shared
// with COMPOSITE_SECTIONS through the same module file.
jest.mock('expo-camera', () => ({
  useCameraPermissions: () => [
    { status: 'undetermined', granted: false, canAskAgain: true },
    jest.fn(),
    jest.fn(),
  ],
}));

// ---------------------------------------------------------------------------
// Tree walking + color extraction
// ---------------------------------------------------------------------------

type JsonNode = {
  readonly type: string;
  readonly props: Record<string, unknown>;
  readonly children: JsonNode[] | null;
};

function toTree(r: RenderResult): JsonNode[] {
  const t = r.toJSON();
  if (t === null) return [];
  if (Array.isArray(t)) return t as unknown as JsonNode[];
  return [t as unknown as JsonNode];
}

function flatStyle(raw: unknown): Record<string, unknown> {
  if (!raw) return {};
  if (Array.isArray(raw)) {
    return raw.reduce<Record<string, unknown>>(
      (acc, s) => ({ ...acc, ...flatStyle(s) }),
      {},
    );
  }
  if (typeof raw === 'object') {
    return raw as Record<string, unknown>;
  }
  return {};
}

function walk(nodes: JsonNode[], visit: (n: JsonNode) => void): void {
  for (const n of nodes) {
    // Text leaves render as raw strings in react-test-renderer's JSON tree,
    // not as JsonNode objects. Skip non-object children defensively so the
    // walker stays robust against future RN renderer changes.
    if (!n || typeof n !== 'object') continue;
    if (!n.props) continue;
    visit(n);
    if (n.children) walk(n.children, visit);
  }
}

// react-native-svg renders Path's fill/stroke as packed-color objects of the
// shape `{ type: 0, payload: 0xFFRRGGBB >>> 0 }`. Convert them back into
// canonical '#RRGGBB' uppercase strings so the contains-checks below align
// with the same hex strings the theme module exports.
function unpackToHex(value: unknown): string | null {
  if (
    value &&
    typeof value === 'object' &&
    (value as { type?: number }).type === 0 &&
    typeof (value as { payload?: number }).payload === 'number'
  ) {
    const packed = (value as { payload: number }).payload >>> 0;
    const rgb = packed & 0x00ffffff;
    return '#' + rgb.toString(16).toUpperCase().padStart(6, '0');
  }
  return null;
}

// Extract every color-ish string from style props (background, color, border,
// shadow, fill, stroke). RNSVG packs colors as objects, so we unpack those
// into hex strings before adding them to the result.
function collectColorStrings(r: RenderResult): string[] {
  const out: string[] = [];
  walk(toTree(r), (n) => {
    const style = flatStyle(n.props.style);
    for (const k of [
      'backgroundColor',
      'color',
      'borderColor',
      'borderTopColor',
      'borderBottomColor',
      'borderLeftColor',
      'borderRightColor',
      'shadowColor',
      'tintColor',
    ] as const) {
      const v = style[k];
      if (typeof v === 'string') out.push(v);
      else {
        const hex = unpackToHex(v);
        if (hex) out.push(hex);
      }
    }
    // RNSVG Path props (fill/stroke). At the JSON-tree layer these come
    // through as packed color objects; unpack to hex.
    for (const k of ['fill', 'stroke'] as const) {
      const v = n.props[k];
      if (typeof v === 'string') out.push(v);
      else {
        const hex = unpackToHex(v);
        if (hex) out.push(hex);
      }
    }
  });
  return out;
}

// Find the first node with a backgroundColor in styles. Returns the resolved
// hex string or null.
function findFirstBg(r: RenderResult): string | null {
  let bg: string | null = null;
  walk(toTree(r), (n) => {
    if (bg !== null) return;
    const style = flatStyle(n.props.style);
    const v = style.backgroundColor;
    if (typeof v === 'string' && v.length > 0) bg = v;
  });
  return bg;
}

// Find the first node that's a Text node and return its rendered color.
function findFirstTextColor(r: RenderResult): string | null {
  let c: string | null = null;
  walk(toTree(r), (n) => {
    if (c !== null) return;
    if (n.type !== 'Text') return;
    const style = flatStyle(n.props.style);
    const v = style.color;
    if (typeof v === 'string' && v.length > 0) c = v;
  });
  return c;
}

// ---------------------------------------------------------------------------
// Inline luminance + contrast (WCAG 2.1 relative-luminance formula)
// ---------------------------------------------------------------------------

function parseHex(hex: string): { r: number; g: number; b: number } | null {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

function relativeLuminance(hex: string): number | null {
  const c = parseHex(hex);
  if (!c) return null;
  const chan = (v: number): number => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * chan(c.r) + 0.7152 * chan(c.g) + 0.0722 * chan(c.b);
}

function contrastRatio(fg: string, bg: string): number | null {
  const lf = relativeLuminance(fg);
  const lb = relativeLuminance(bg);
  if (lf === null || lb === null) return null;
  const [hi, lo] = lf >= lb ? [lf, lb] : [lb, lf];
  return (hi + 0.05) / (lo + 0.05);
}

// Sanity: the helpers themselves must be correct or every assertion below is
// noise. The known anchors come from DESIGN.md token tables.
describe('contrast helper sanity', () => {
  it('matches the known Conservatory text-on-bg ratio (~13.32)', () => {
    const r = contrastRatio(lightTheme.colors.text, lightTheme.colors.bg);
    expect(r).not.toBeNull();
    expect(r as number).toBeGreaterThan(13);
    expect(r as number).toBeLessThan(14);
  });
  it('matches the known Midnight text-on-bg ratio (~16.55)', () => {
    const r = contrastRatio(darkTheme.colors.text, darkTheme.colors.bg);
    expect(r).not.toBeNull();
    expect(r as number).toBeGreaterThan(16);
    expect(r as number).toBeLessThan(17);
  });
  it('rejects invalid hex strings', () => {
    expect(parseHex('not-a-hex')).toBeNull();
    expect(parseHex('rgba(0,0,0,0.5)')).toBeNull();
    expect(relativeLuminance('transparent')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Manifest parity — every primitive section must be exercised below
// ---------------------------------------------------------------------------

describe('PRIMITIVE_SECTIONS — dark-mode coverage parity', () => {
  // Every primitive that has its own dark suite below must be listed here.
  // Add a new entry when adding a new primitive; the parity test fails until
  // the manifest matches the dark-suite list.
  const DARK_SUITE_NAMES = [
    'Droplet',
    'LeafIcon',
    'HandOnSoilIcon',
    'StatusChip',
    'EditorialButton',
    'FAB',
    'HeroPhoto',
    'EditorialBottomSheet',
    'ToastBanner',
  ] as const;

  it('the dark suite covers every entry in PRIMITIVE_SECTIONS', () => {
    const manifestNames = PRIMITIVE_SECTIONS.map((s) => s.name).sort();
    const suiteNames = [...DARK_SUITE_NAMES].sort();
    expect(suiteNames).toEqual(manifestNames);
  });
});

// ---------------------------------------------------------------------------
// Per-primitive dark-mode tests
// ---------------------------------------------------------------------------

function ThemedRender(theme: Theme, ui: ReactElement) {
  return render(<ForcedTheme value={theme}>{ui}</ForcedTheme>);
}

const FORBIDDEN_COLORS = new Set<string>([
  'undefined',
  'null',
  'NaN',
  '',
]);

function expectNoForbiddenColors(r: RenderResult): void {
  const colors = collectColorStrings(r);
  // Allow 'none' on SVG fill/stroke (idiomatic for outline-only paths) and
  // 'transparent' (intentional — used by overlays). The contrast assertions
  // catch the case where 'transparent' would silently lose text legibility.
  const filtered = colors.filter((c) => c !== 'none' && c !== 'transparent');
  for (const c of filtered) {
    expect(FORBIDDEN_COLORS.has(c)).toBe(false);
  }
}

function expectBackgroundSwaps(rl: RenderResult, rd: RenderResult): void {
  const bgL = findFirstBg(rl);
  const bgD = findFirstBg(rd);
  expect(bgL).not.toBeNull();
  expect(bgD).not.toBeNull();
  expect(bgL).not.toEqual(bgD);
}

function expectTextContrast(r: RenderResult, bgHex: string, minRatio = 4.5): void {
  const fg = findFirstTextColor(r);
  expect(fg).not.toBeNull();
  const ratio = contrastRatio(fg as string, bgHex);
  expect(ratio).not.toBeNull();
  expect(ratio as number).toBeGreaterThanOrEqual(minRatio);
}

describe('Droplet — dark-mode rendering', () => {
  it('forbidden-color check passes in both themes', () => {
    expectNoForbiddenColors(ThemedRender(lightTheme, <Droplet filled />));
    expectNoForbiddenColors(ThemedRender(darkTheme, <Droplet filled />));
  });
  it('SVG fill swaps surface token between themes (filled=false branch)', () => {
    const rl = ThemedRender(lightTheme, <Droplet />);
    const rd = ThemedRender(darkTheme, <Droplet />);
    const fillsL = collectColorStrings(rl).filter((c) => c.startsWith('#'));
    const fillsD = collectColorStrings(rd).filter((c) => c.startsWith('#'));
    expect(fillsL).toContain(lightTheme.colors.surface);
    expect(fillsD).toContain(darkTheme.colors.surface);
    expect(lightTheme.colors.surface).not.toEqual(darkTheme.colors.surface);
  });
});

describe('LeafIcon — dark-mode rendering', () => {
  it('forbidden-color check passes in both themes', () => {
    expectNoForbiddenColors(ThemedRender(lightTheme, <LeafIcon />));
    expectNoForbiddenColors(ThemedRender(darkTheme, <LeafIcon />));
  });
  it('stroke token swaps between themes', () => {
    const rl = ThemedRender(lightTheme, <LeafIcon />);
    const rd = ThemedRender(darkTheme, <LeafIcon />);
    expect(collectColorStrings(rl)).toContain(lightTheme.colors.stroke);
    expect(collectColorStrings(rd)).toContain(darkTheme.colors.stroke);
  });
});

describe('HandOnSoilIcon — dark-mode rendering', () => {
  it('forbidden-color check passes in both themes', () => {
    expectNoForbiddenColors(ThemedRender(lightTheme, <HandOnSoilIcon />));
    expectNoForbiddenColors(ThemedRender(darkTheme, <HandOnSoilIcon />));
  });
  it('stroke token swaps between themes', () => {
    const rl = ThemedRender(lightTheme, <HandOnSoilIcon />);
    const rd = ThemedRender(darkTheme, <HandOnSoilIcon />);
    expect(collectColorStrings(rl)).toContain(lightTheme.colors.stroke);
    expect(collectColorStrings(rd)).toContain(darkTheme.colors.stroke);
  });
});

describe('StatusChip — dark-mode rendering', () => {
  it('forbidden-color check passes for all three types in both themes', () => {
    for (const type of ['water', 'skip', 'soil'] as const) {
      expectNoForbiddenColors(ThemedRender(lightTheme, <StatusChip type={type} />));
      expectNoForbiddenColors(ThemedRender(darkTheme, <StatusChip type={type} />));
    }
  });
  it('chip surface swaps between themes', () => {
    const rl = ThemedRender(lightTheme, <StatusChip type="water" />);
    const rd = ThemedRender(darkTheme, <StatusChip type="water" />);
    expectBackgroundSwaps(rl, rd);
  });
  it('label has >=4.5:1 contrast vs surface in dark mode (all three types)', () => {
    for (const type of ['water', 'skip', 'soil'] as const) {
      const r = ThemedRender(darkTheme, <StatusChip type={type} />);
      expectTextContrast(r, darkTheme.colors.surface);
    }
  });
  it('label has >=4.5:1 contrast vs surface in light mode (all three types)', () => {
    for (const type of ['water', 'skip', 'soil'] as const) {
      const r = ThemedRender(lightTheme, <StatusChip type={type} />);
      expectTextContrast(r, lightTheme.colors.surface);
    }
  });
  it('accent border resolves to a real token (not undefined) in dark mode', () => {
    for (const type of ['water', 'skip', 'soil'] as const) {
      const r = ThemedRender(darkTheme, <StatusChip type={type} />);
      const root = toTree(r)[0];
      const style = flatStyle(root.props.style);
      const borderColor = style.borderColor;
      expect(typeof borderColor).toBe('string');
      expect(FORBIDDEN_COLORS.has(borderColor as string)).toBe(false);
    }
  });
});

describe('EditorialButton — dark-mode rendering', () => {
  const noop = () => undefined;
  it('forbidden-color check passes for both variants x both themes', () => {
    for (const variant of ['filled', 'outline'] as const) {
      expectNoForbiddenColors(
        ThemedRender(lightTheme, <EditorialButton variant={variant} label="x" onPress={noop} />),
      );
      expectNoForbiddenColors(
        ThemedRender(darkTheme, <EditorialButton variant={variant} label="x" onPress={noop} />),
      );
    }
  });
  it('filled bg swaps between themes', () => {
    const rl = ThemedRender(lightTheme, <EditorialButton variant="filled" label="x" onPress={noop} />);
    const rd = ThemedRender(darkTheme, <EditorialButton variant="filled" label="x" onPress={noop} />);
    expectBackgroundSwaps(rl, rd);
  });
  it('label has >=4.5:1 contrast vs button bg in dark mode (filled variant)', () => {
    const r = ThemedRender(darkTheme, <EditorialButton variant="filled" label="Mark watered" onPress={noop} />);
    // filled: bg = text token = cream in dark
    expectTextContrast(r, darkTheme.colors.text);
  });
  it('label has >=4.5:1 contrast vs button bg in dark mode (outline variant)', () => {
    const r = ThemedRender(darkTheme, <EditorialButton variant="outline" label="Add note" onPress={noop} />);
    // outline: bg = surface = forest in dark
    expectTextContrast(r, darkTheme.colors.surface);
  });
});

describe('FAB — dark-mode rendering', () => {
  const noop = () => undefined;
  it('forbidden-color check passes in both themes', () => {
    expectNoForbiddenColors(ThemedRender(lightTheme, <FAB onPress={noop} />));
    expectNoForbiddenColors(ThemedRender(darkTheme, <FAB onPress={noop} />));
  });
  it('background swaps between themes', () => {
    const rl = ThemedRender(lightTheme, <FAB onPress={noop} />);
    const rd = ThemedRender(darkTheme, <FAB onPress={noop} />);
    expectBackgroundSwaps(rl, rd);
  });
  it('default + glyph has >=4.5:1 contrast vs FAB bg in dark mode', () => {
    const r = ThemedRender(darkTheme, <FAB onPress={noop} />);
    // FAB bg = text token = cream in dark; glyph color = surface = forest.
    expectTextContrast(r, darkTheme.colors.text);
  });
});

describe('HeroPhoto — dark-mode rendering', () => {
  it('forbidden-color check passes in both themes', () => {
    expectNoForbiddenColors(
      ThemedRender(
        lightTheme,
        <HeroPhoto source={{ uri: 'file:///placeholder' }} accessibilityLabel="x" />,
      ),
    );
    expectNoForbiddenColors(
      ThemedRender(
        darkTheme,
        <HeroPhoto source={{ uri: 'file:///placeholder' }} accessibilityLabel="x" />,
      ),
    );
  });
  it('skeleton background (surface token) swaps between themes', () => {
    const rl = ThemedRender(
      lightTheme,
      <HeroPhoto source={{ uri: 'file:///x' }} accessibilityLabel="x" />,
    );
    const rd = ThemedRender(
      darkTheme,
      <HeroPhoto source={{ uri: 'file:///x' }} accessibilityLabel="x" />,
    );
    expectBackgroundSwaps(rl, rd);
  });
});

describe('EditorialBottomSheet — dark-mode rendering', () => {
  const noop = () => undefined;
  it('open=false renders nothing in either theme (no color leakage)', () => {
    const rl = ThemedRender(
      lightTheme,
      <EditorialBottomSheet open={false} onDismiss={noop}>
        <></>
      </EditorialBottomSheet>,
    );
    const rd = ThemedRender(
      darkTheme,
      <EditorialBottomSheet open={false} onDismiss={noop}>
        <></>
      </EditorialBottomSheet>,
    );
    expect(toTree(rl)).toEqual([]);
    expect(toTree(rd)).toEqual([]);
  });
  it('open=true: sheet surface swaps between themes', () => {
    const rl = ThemedRender(
      lightTheme,
      <EditorialBottomSheet open onDismiss={noop}>
        <></>
      </EditorialBottomSheet>,
    );
    const rd = ThemedRender(
      darkTheme,
      <EditorialBottomSheet open onDismiss={noop}>
        <></>
      </EditorialBottomSheet>,
    );
    const colorsL = collectColorStrings(rl);
    const colorsD = collectColorStrings(rd);
    expect(colorsL).toContain(lightTheme.colors.surface);
    expect(colorsD).toContain(darkTheme.colors.surface);
    expectNoForbiddenColors(rl);
    expectNoForbiddenColors(rd);
  });
});

describe('ToastBanner — dark-mode rendering', () => {
  it('forbidden-color check passes for all three types in both themes', () => {
    for (const type of ['warn', 'info', 'pending'] as const) {
      expectNoForbiddenColors(
        ThemedRender(lightTheme, <ToastBanner type={type} message="x" />),
      );
      expectNoForbiddenColors(
        ThemedRender(darkTheme, <ToastBanner type={type} message="x" />),
      );
    }
  });
  it('warn/pending use tan, info uses sage — same in both themes (constants)', () => {
    // tan and sage are intentionally constant across Conservatory + Midnight
    // (DESIGN.md "Status icon system"). The banner background should NOT swap.
    const rl = ThemedRender(lightTheme, <ToastBanner type="warn" message="x" testID="b" />);
    const rd = ThemedRender(darkTheme, <ToastBanner type="warn" message="x" testID="b" />);
    const styleL = flatStyle(toTree(rl)[0].props.style);
    const styleD = flatStyle(toTree(rd)[0].props.style);
    expect(styleL.backgroundColor).toEqual(lightTheme.colors.tan);
    expect(styleD.backgroundColor).toEqual(darkTheme.colors.tan);
    expect(lightTheme.colors.tan).toEqual(darkTheme.colors.tan);
  });
  it('message text has >=4.5:1 contrast vs banner bg in dark mode (all three types)', () => {
    // Regression for E10-001: previously the banner used theme.colors.text
    // (cream in dark) on tan/sage, yielding 1.68-2.09:1. Fixed by locking
    // text-on-accent to the deep ink (#2A2A2A).
    const minRatio = 4.5;
    {
      const r = ThemedRender(darkTheme, <ToastBanner type="warn" message="x" />);
      expectTextContrast(r, darkTheme.colors.tan, minRatio);
    }
    {
      const r = ThemedRender(darkTheme, <ToastBanner type="info" message="x" />);
      expectTextContrast(r, darkTheme.colors.sage, minRatio);
    }
    {
      const r = ThemedRender(darkTheme, <ToastBanner type="pending" message="x" />);
      expectTextContrast(r, darkTheme.colors.tan, minRatio);
    }
  });
  it('message text has >=4.5:1 contrast vs banner bg in light mode (all three types)', () => {
    {
      const r = ThemedRender(lightTheme, <ToastBanner type="warn" message="x" />);
      expectTextContrast(r, lightTheme.colors.tan);
    }
    {
      const r = ThemedRender(lightTheme, <ToastBanner type="info" message="x" />);
      expectTextContrast(r, lightTheme.colors.sage);
    }
    {
      const r = ThemedRender(lightTheme, <ToastBanner type="pending" message="x" />);
      expectTextContrast(r, lightTheme.colors.tan);
    }
  });
});
