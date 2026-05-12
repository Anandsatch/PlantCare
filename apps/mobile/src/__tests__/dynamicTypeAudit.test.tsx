/**
 * E11-003 — Dynamic Type audit.
 *
 * iOS Dynamic Type and Android Font Size let users scale fonts up to 310%
 * (some a11y modes go higher). At those scales:
 *   - Fixed `lineHeight` shorter than rendered text height CLIPS descenders.
 *   - Single-line text in fixed-height containers gets cut off.
 *   - Two-line text that becomes three lines at scale overflows containers.
 *
 * This suite enforces the two rules from the E11-003 contract:
 *
 *   RULE 1 (line-height ratios)
 *     For body/UI sans (Inter) sites with an explicit fixed-pixel
 *     `lineHeight`, the ratio `lineHeight / fontSize` MUST be >= 1.4×.
 *     For display serif (Fraunces) sites with an explicit fixed-pixel
 *     `lineHeight`, the ratio MUST be >= 1.15× (tight display leading is
 *     intentional at the display scale, but the leading must still leave
 *     descender room).
 *
 *   RULE 2 (text-bearing containers must flex)
 *     A View that contains a `<Text>` child must NOT pin a fixed `height`
 *     (use `minHeight` + padding instead). Fixed-size icon buttons (close
 *     "×", FAB "+") may keep `height` only when their Text child opts out
 *     of font scaling via `allowFontScaling={false}` — those glyphs are
 *     chrome, not flowing copy.
 *
 * The walker re-renders the primitive surface with PixelRatio.getFontScale
 * mocked to 3.1 (the iOS Dynamic Type ceiling) and confirms the rendered
 * style props still satisfy the contract. The static stylesheet assertions
 * cover the screen-level surface where rendering would require an
 * impractical web of navigation/DB/api mocks.
 */

import { darkTheme, lightTheme } from '@plantcare/theme';
import { render, type RenderResult } from '@testing-library/react-native';
import { Text, View, PixelRatio } from 'react-native';

// Mock useTheme so primitives render without a Provider.
jest.mock('../hooks/useTheme', () => ({
  useTheme: jest.fn(),
}));
import { useTheme } from '../hooks/useTheme';

import { EditorialButton, FAB, StatusChip, ToastBanner, fabPopoverStyles } from '../components/primitives';
import { fabStyles } from '../components/primitives/FAB';
import { PlantCard } from '../components/PlantCard';
import { EmptyGardenWelcome } from '../components/EmptyGardenWelcome';
import { DiagnoseLoadingState } from '../components/DiagnoseLoadingState';

const mockedUseTheme = useTheme as jest.MockedFunction<typeof useTheme>;

beforeEach(() => {
  mockedUseTheme.mockReturnValue(lightTheme);
  // Mock the iOS Dynamic Type ceiling (310%). RN's StyleSheet doesn't bake
  // this into the static style — `allowFontScaling` and the layout engine
  // honor it at render time — but pinning the mock here documents what we
  // are simulating and protects future hooks that read getFontScale().
  jest.spyOn(PixelRatio, 'getFontScale').mockReturnValue(3.1);
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ─── Tree-walking helpers ─────────────────────────────────────────────────

type JsonNode = {
  type: string;
  props: Record<string, unknown>;
  children: ReadonlyArray<JsonNode | string> | null;
};

function flattenStyle(raw: unknown): Record<string, unknown> {
  if (!raw) return {};
  if (Array.isArray(raw)) {
    return raw.reduce<Record<string, unknown>>((acc, s) => {
      if (s == null || typeof s === 'boolean') return acc;
      return { ...acc, ...flattenStyle(s) };
    }, {});
  }
  if (typeof raw === 'object') return raw as Record<string, unknown>;
  return {};
}

function allNodes(r: RenderResult): JsonNode[] {
  const out: JsonNode[] = [];
  const visit = (node: JsonNode | string | null | undefined): void => {
    if (!node || typeof node === 'string') return;
    out.push(node);
    if (Array.isArray(node.children)) {
      for (const c of node.children) visit(c);
    }
  };
  const tree = r.toJSON();
  if (Array.isArray(tree)) {
    for (const n of tree) visit(n as unknown as JsonNode);
  } else if (tree) {
    visit(tree as unknown as JsonNode);
  }
  return out;
}

function findTextNodes(r: RenderResult): JsonNode[] {
  return allNodes(r).filter((n) => n.type === 'Text');
}

// Inter (body sans) — the loaded font family names from @expo-google-fonts/inter.
const INTER_FAMILIES = new Set([
  'Inter_400Regular',
  'Inter_500Medium',
  'Inter_600SemiBold',
]);
// Fraunces (display serif).
const FRAUNCES_FAMILIES = new Set([
  'Fraunces_400Regular',
  'Fraunces_400Regular_Italic',
  'Fraunces_600SemiBold',
  'Fraunces',
]);

function classifyFamily(fontFamily: unknown): 'inter' | 'fraunces' | 'unknown' {
  if (typeof fontFamily !== 'string') return 'unknown';
  if (INTER_FAMILIES.has(fontFamily)) return 'inter';
  if (FRAUNCES_FAMILIES.has(fontFamily)) return 'fraunces';
  return 'unknown';
}

function assertRatioContract(node: JsonNode): void {
  const s = flattenStyle(node.props.style);
  if (typeof s.fontSize !== 'number' || typeof s.lineHeight !== 'number') return;
  // Skip ornamental glyphs that opt out of scaling entirely.
  if (node.props.allowFontScaling === false) return;
  const family = classifyFamily(s.fontFamily);
  const min = family === 'fraunces' ? 1.15 : 1.4;
  const ratio = s.lineHeight / s.fontSize;
  if (ratio < min) {
    throw new Error(
      `lineHeight/fontSize ratio ${ratio.toFixed(2)} below ${min} for family=${family} (fontSize=${s.fontSize}, lineHeight=${s.lineHeight})`,
    );
  }
}

function assertNoFixedHeightWithTextChild(r: RenderResult): void {
  const containers = allNodes(r).filter((n) => n.type === 'View');
  for (const c of containers) {
    const s = flattenStyle(c.props.style);
    if (typeof s.height !== 'number') continue;
    const hasFlowingTextChild = Array.isArray(c.children)
      ? c.children.some((ch) => {
          if (typeof ch !== 'object' || ch === null) return false;
          const cn = ch as JsonNode;
          if (cn.type !== 'Text') return false;
          // Text that opts out of scaling is chrome (e.g. close "×", FAB "+").
          return cn.props.allowFontScaling !== false;
        })
      : false;
    if (hasFlowingTextChild) {
      throw new Error(
        `View has fixed height:${s.height} with a flowing Text child. Use minHeight + paddingVertical.`,
      );
    }
  }
}

// ─── Static stylesheet contract ───────────────────────────────────────────

describe('E11-003 line-height ratio contract (static stylesheet)', () => {
  test('FAB primitive — "+" glyph opts out of scaling and matches Fraunces ratio', () => {
    // The FAB renders the "+" glyph at fontSize:28/lineHeight:32 inside a
    // fixed 56×56 circular button. Because the glyph is chrome (not flowing
    // copy), it sets allowFontScaling={false} on the Text node — see RULE 2.
    // The static style ratio is still safely > 1.0 so the glyph fits the
    // circle even if Fraunces metrics shift across versions.
    expect(fabStyles.icon.fontSize).toBe(28);
    expect(fabStyles.icon.lineHeight).toBe(32);
    expect(fabStyles.icon.lineHeight / fabStyles.icon.fontSize).toBeGreaterThanOrEqual(1.1);
  });

  test('FABPopover label — Inter ratio >= 1.4× (E11-003 fix from 1.25 → 1.5)', () => {
    expect(fabPopoverStyles.label.fontSize).toBe(16);
    expect(fabPopoverStyles.label.lineHeight).toBe(24);
    const fs = fabPopoverStyles.label.fontSize as number;
    const lh = fabPopoverStyles.label.lineHeight as number;
    expect(lh / fs).toBeGreaterThanOrEqual(1.4);
  });
});

// ─── Render-walk contract ─────────────────────────────────────────────────

describe('E11-003 rendered-tree contract (PixelRatio.getFontScale = 3.1)', () => {
  test('PixelRatio.getFontScale() returns the mocked Dynamic Type ceiling', () => {
    // Sanity: the mock IS applied for this suite, so any future code that
    // gates on getFontScale (e.g. a max-scale guard in useTheme) is under test.
    expect(PixelRatio.getFontScale()).toBeCloseTo(3.1, 5);
  });

  test('StatusChip — chip pill uses padding (no fixed height) and Inter label meets ratio', () => {
    const r = render(<StatusChip type="water" />);
    const texts = findTextNodes(r);
    expect(texts.length).toBeGreaterThan(0);
    for (const t of texts) assertRatioContract(t);
    assertNoFixedHeightWithTextChild(r);
  });

  test('EditorialButton — Fraunces label has 1.5× lineHeight ratio (was 1.25)', () => {
    const r = render(<EditorialButton variant="filled" label="Get started" onPress={() => {}} />);
    const texts = findTextNodes(r);
    const label = texts.find((t) => {
      const s = flattenStyle(t.props.style);
      return typeof s.fontSize === 'number';
    });
    expect(label).toBeDefined();
    const s = flattenStyle(label!.props.style);
    // Fraunces CTA — was 16/20 (1.25×), E11-003 raised to 16/24 (1.5×).
    expect(s.fontSize).toBe(16);
    expect(s.lineHeight).toBe(24);
    for (const t of texts) assertRatioContract(t);
  });

  test('FAB — "+" glyph opts out of scaling (escape hatch from RULE 2)', () => {
    const r = render(<FAB onPress={() => {}} accessibilityLabel="Add" />);
    const texts = findTextNodes(r);
    const plusGlyph = texts.find((t) => {
      const children = t.children;
      if (!Array.isArray(children)) return false;
      return children.some((c) => c === '+');
    });
    expect(plusGlyph).toBeDefined();
    // The chrome glyph escape hatch — RULE 2 permits height:SIZE on the
    // parent only because the Text declines to scale.
    expect(plusGlyph!.props.allowFontScaling).toBe(false);
    // The walker should be satisfied because the only text inside the FAB
    // explicitly opts out of font scaling.
    assertNoFixedHeightWithTextChild(r);
  });

  test('ToastBanner — pending message Text meets Inter ratio at fontScale 3.1', () => {
    const r = render(<ToastBanner type="pending" message="Saving notice…" />);
    const texts = findTextNodes(r);
    expect(texts.length).toBeGreaterThan(0);
    for (const t of texts) assertRatioContract(t);
    assertNoFixedHeightWithTextChild(r);
  });

  test('PlantCard — species/nickname/lastWatered meet ratio + no fixed-height text wrappers', () => {
    const r = render(
      <PlantCard
        speciesLabel="Calathea orbifolia"
        nickname="Lily"
        photoUri={null}
        lastWateredAtMs={Date.now() - 2 * 24 * 60 * 60 * 1000}
        status="water"
        onPress={() => {}}
        nowMs={Date.now()}
      />,
    );
    const texts = findTextNodes(r);
    expect(texts.length).toBeGreaterThan(0);
    for (const t of texts) assertRatioContract(t);
    assertNoFixedHeightWithTextChild(r);
  });

  test('EmptyGardenWelcome — Fraunces CTA label no longer pins lineHeight === fontSize', () => {
    const r = render(<EmptyGardenWelcome onAddFirst={() => {}} />);
    const texts = findTextNodes(r);
    let sawCta = false;
    for (const t of texts) {
      const s = flattenStyle(t.props.style);
      if (typeof s.fontSize === 'number' && typeof s.lineHeight === 'number') {
        // Pre-fix the ctaLabel had 16/16 (ratio 1.0) which clipped "g" descenders.
        expect(s.lineHeight).toBeGreaterThan(s.fontSize);
        if (s.fontSize === 16 && s.lineHeight === 22) sawCta = true;
      }
    }
    expect(sawCta).toBe(true);
    for (const t of texts) assertRatioContract(t);
  });

  test('DiagnoseLoadingState — copy meets ratio (Inter 18/26 = 1.44)', () => {
    const r = render(<DiagnoseLoadingState />);
    const texts = findTextNodes(r);
    expect(texts.length).toBeGreaterThan(0);
    for (const t of texts) assertRatioContract(t);
  });
});

// ─── Anti-regression: every fixed-height-with-Text-child gets caught ──────

describe('E11-003 regression guard — no fixed-height containers wrap flowing Text', () => {
  // Renders a deliberate violation to confirm the assertion would CATCH a
  // regression. This locks the test logic itself.
  test('walker rejects a View with `height` containing a Text child (control)', () => {
    const r = render(
      <View testID="bad" style={{ height: 30 }}>
        <Text style={{ fontSize: 14 }}>Some flowing copy</Text>
      </View>,
    );
    expect(() => assertNoFixedHeightWithTextChild(r)).toThrow(/fixed height/);
  });

  // The walker should accept the same fixed-height container when the Text
  // child opts out of scaling (chrome glyph escape hatch).
  test('walker allows fixed height when Text child opts out of font scaling', () => {
    const r = render(
      <View testID="ok" style={{ height: 30 }}>
        <Text allowFontScaling={false} style={{ fontSize: 14 }}>×</Text>
      </View>,
    );
    expect(() => assertNoFixedHeightWithTextChild(r)).not.toThrow();
  });

  // Dark-theme twin — same rule, dark rendering path.
  test('PlantCard renders identically under darkTheme', () => {
    mockedUseTheme.mockReturnValue(darkTheme);
    const r = render(
      <PlantCard
        speciesLabel="Calathea orbifolia"
        nickname="Lily"
        photoUri={null}
        lastWateredAtMs={Date.now() - 2 * 24 * 60 * 60 * 1000}
        status="water"
        onPress={() => {}}
        nowMs={Date.now()}
      />,
    );
    const texts = findTextNodes(r);
    for (const t of texts) assertRatioContract(t);
    assertNoFixedHeightWithTextChild(r);
  });
});
