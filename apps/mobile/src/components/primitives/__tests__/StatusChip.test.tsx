import { darkTheme, lightTheme } from '@plantcare/theme';
import { render, type RenderResult } from '@testing-library/react-native';

// Mock useTheme so each test pins the active token table without depending on
// the system color scheme. Same per-suite jest.mock pattern as
// src/components/primitives/__tests__/icons.test.tsx.
jest.mock('../../../hooks/useTheme', () => ({
  useTheme: jest.fn(),
}));

import { useTheme } from '../../../hooks/useTheme';
import { StatusChip } from '../index';

const mockedUseTheme = useTheme as jest.MockedFunction<typeof useTheme>;

// JSON-tree helpers — same approach as icons.test.tsx. Color values arrive as
// `{type: 0, payload: <uint32>}` packed unsigned. `>>> 0` is load-bearing for
// hex roundtrips — without it JS bitwise math returns the signed twin.
type ColorPayload = { type: 0; payload: number };
function packHex(hex: string): number {
  const rgb = parseInt(hex.slice(1), 16);
  return (0xff000000 | rgb) >>> 0;
}
function expectColor(actual: unknown, hex: string): void {
  expect(actual).toEqual<ColorPayload>({ type: 0, payload: packHex(hex) });
}

type JsonNode = {
  type: string;
  props: Record<string, unknown>;
  children: JsonNode[] | null;
};
function rootNode(r: RenderResult): JsonNode {
  const tree = r.toJSON();
  if (Array.isArray(tree)) return tree[0] as JsonNode;
  return tree as unknown as JsonNode;
}

// flatten StyleSheet style props (a chip uses an array of [styles.chip, {bg, border}]).
function flatStyle(node: JsonNode): Record<string, unknown> {
  const raw = node.props.style;
  if (!raw) return {};
  if (Array.isArray(raw)) {
    return raw.reduce<Record<string, unknown>>(
      (acc, s) => ({ ...acc, ...(s as Record<string, unknown>) }),
      {},
    );
  }
  return raw as Record<string, unknown>;
}

// The chip tree: View(chip) -> [ Svg(icon), Text(label) ]
function chipChildren(r: RenderResult): {
  chip: JsonNode;
  svg: JsonNode;
  text: JsonNode;
} {
  const chip = rootNode(r);
  const children = (chip.children ?? []) as JsonNode[];
  // Children: [Svg, Text]. Find by type so reordering stays test-resilient.
  const svg = children.find((c) => typeof c.type === 'string' && c.type.startsWith('RNSVG'));
  const text = children.find((c) => c.type === 'Text');
  if (!svg) throw new Error(`expected an RNSVG child; got ${children.map((c) => c.type).join(', ')}`);
  if (!text) throw new Error(`expected a Text child; got ${children.map((c) => c.type).join(', ')}`);
  return { chip, svg, text };
}

beforeEach(() => {
  mockedUseTheme.mockReturnValue(lightTheme);
});

afterEach(() => {
  mockedUseTheme.mockReset();
});

describe('StatusChip — type=water', () => {
  it('renders a filled Droplet (water token) and "WATER TODAY" label', () => {
    const r = render(<StatusChip type="water" testID="chip" />);
    const { svg, text } = chipChildren(r);
    // Svg root carries the size and viewBox from Droplet; the inner Path
    // payload carries the fill color.
    expect(svg.props.width).toBe(14);
    expect(svg.props.height).toBe(14);
    const path = (svg.children?.[0]?.children?.[0] ?? null) as JsonNode | null;
    expect(path).not.toBeNull();
    expectColor(path!.props.fill, lightTheme.colors.water);
    // Label text — uppercase via textTransform; assert the source string.
    expect(text.children?.[0]).toBe('WATER TODAY');
  });

  it('uses surface fill (cream) and water-token hairline border', () => {
    const r = render(<StatusChip type="water" testID="chip" />);
    const { chip } = chipChildren(r);
    const style = flatStyle(chip);
    expect(style.backgroundColor).toBe(lightTheme.colors.surface);
    expect(style.borderColor).toBe(lightTheme.colors.water);
    expect(style.borderWidth).toBe(1);
  });

  it('defaults accessibilityLabel to "Water today"', () => {
    const r = render(<StatusChip type="water" testID="chip" />);
    const { chip } = chipChildren(r);
    expect(chip.props.accessibilityLabel).toBe('Water today');
  });
});

describe('StatusChip — type=skip', () => {
  it('renders a LeafIcon at size 14 and "SKIP" label', () => {
    const r = render(<StatusChip type="skip" testID="chip" />);
    const { svg, text } = chipChildren(r);
    expect(svg.props.width).toBe(14);
    expect(svg.props.height).toBe(14);
    expect(text.children?.[0]).toBe('SKIP');
  });

  it('uses surface fill and sage-token hairline border (skip semantic accent)', () => {
    const r = render(<StatusChip type="skip" testID="chip" />);
    const { chip } = chipChildren(r);
    const style = flatStyle(chip);
    expect(style.backgroundColor).toBe(lightTheme.colors.surface);
    expect(style.borderColor).toBe(lightTheme.colors.sage);
  });

  it('defaults accessibilityLabel to "Skip watering"', () => {
    const r = render(<StatusChip type="skip" testID="chip" />);
    const { chip } = chipChildren(r);
    expect(chip.props.accessibilityLabel).toBe('Skip watering');
  });
});

describe('StatusChip — type=soil', () => {
  it('renders a HandOnSoilIcon at size 14 and "CHECK SOIL" label', () => {
    const r = render(<StatusChip type="soil" testID="chip" />);
    const { svg, text } = chipChildren(r);
    expect(svg.props.width).toBe(14);
    expect(svg.props.height).toBe(14);
    expect(text.children?.[0]).toBe('CHECK SOIL');
  });

  it('uses surface fill and tan-token hairline border (check-soil accent)', () => {
    const r = render(<StatusChip type="soil" testID="chip" />);
    const { chip } = chipChildren(r);
    const style = flatStyle(chip);
    expect(style.backgroundColor).toBe(lightTheme.colors.surface);
    expect(style.borderColor).toBe(lightTheme.colors.tan);
  });

  it('defaults accessibilityLabel to "Check soil"', () => {
    const r = render(<StatusChip type="soil" testID="chip" />);
    const { chip } = chipChildren(r);
    expect(chip.props.accessibilityLabel).toBe('Check soil');
  });
});

describe('StatusChip — shared shape + behavior', () => {
  it('lets a caller override accessibilityLabel for any type', () => {
    const r = render(
      <StatusChip type="water" accessibilityLabel="Monstera Mona needs water" testID="chip" />,
    );
    const { chip } = chipChildren(r);
    expect(chip.props.accessibilityLabel).toBe('Monstera Mona needs water');
  });

  it('renders as a non-interactive pill (no Pressable, no onPress)', () => {
    const r = render(<StatusChip type="water" testID="chip" />);
    const { chip } = chipChildren(r);
    // The outer node is a plain View — Pressable serializes to a different
    // type ("View" with onResponderRelease, etc.). Keep this loose: just
    // assert there is no onPress prop on the chip.
    expect(chip.props.onPress).toBeUndefined();
    // And no Pressable in the tree (would surface as "View" with onClick on web,
    // but on RN test renderer Pressables get a `collapsable=false` View). The
    // strongest guarantee is shape: chip has 2 children (svg + text), nothing else.
    expect((chip.children ?? []).length).toBe(2);
  });

  it('renders a pill (borderRadius 999) with hairline border', () => {
    const r = render(<StatusChip type="water" testID="chip" />);
    const { chip } = chipChildren(r);
    const style = flatStyle(chip);
    expect(style.borderRadius).toBe(999);
    expect(style.borderWidth).toBe(1);
  });

  it('uses Inter all-caps small label sizing per DESIGN.md', () => {
    const r = render(<StatusChip type="water" testID="chip" />);
    const { text } = chipChildren(r);
    const style = flatStyle(text);
    expect(style.fontSize).toBe(11);
    expect(style.fontWeight).toBe('600');
    expect(style.letterSpacing).toBe(0.5);
    expect(style.textTransform).toBe('uppercase');
  });

  it('flips fill + label color in dark mode without a per-type code path', () => {
    mockedUseTheme.mockReturnValue(darkTheme);
    const r = render(<StatusChip type="water" testID="chip" />);
    const { chip, text } = chipChildren(r);
    const chipStyle = flatStyle(chip);
    const textStyle = flatStyle(text);
    // surface in dark = forest (#1F3826); border accent token (water) is
    // mode-stable (same hue, passes 6.88:1 on forest per DESIGN.md).
    expect(chipStyle.backgroundColor).toBe(darkTheme.colors.surface);
    expect(chipStyle.borderColor).toBe(darkTheme.colors.water);
    // Label flips to cream in dark.
    expect(textStyle.color).toBe(darkTheme.colors.text);
    // Sanity: dark surface != light surface, otherwise the mock isn't wired.
    expect(darkTheme.colors.surface).not.toBe(lightTheme.colors.surface);
  });

  it('sets accessible=true on the chip and accessible=false on the inner label so VoiceOver reads once', () => {
    const r = render(<StatusChip type="water" testID="chip" />);
    const { chip, text } = chipChildren(r);
    expect(chip.props.accessible).toBe(true);
    expect(text.props.accessible).toBe(false);
  });

  it('all three types render the icon at size 14 (visually balanced chip family)', () => {
    for (const type of ['water', 'skip', 'soil'] as const) {
      const r = render(<StatusChip type={type} testID="chip" />);
      const { svg } = chipChildren(r);
      expect(svg.props.width).toBe(14);
      expect(svg.props.height).toBe(14);
    }
  });

  it('forwards testID to the chip root', () => {
    const r = render(<StatusChip type="water" testID="status-chip-water" />);
    const { chip } = chipChildren(r);
    expect(chip.props.testID).toBe('status-chip-water');
  });
});
