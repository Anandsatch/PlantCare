import { darkTheme, lightTheme } from '@plantcare/theme';
import { render, type RenderResult } from '@testing-library/react-native';

// Mock useTheme so each test pins the active token table without depending on
// the system color scheme. Mirrors the pattern in src/hooks/__tests__/useTheme.test.tsx
// and apps/mobile/__tests__/layout.test.tsx (per-suite jest.mock + mockReturnValue).
jest.mock('../../../hooks/useTheme', () => ({
  useTheme: jest.fn(),
}));

import { useTheme } from '../../../hooks/useTheme';
import { Droplet, HandOnSoilIcon, LeafIcon } from '../index';

const mockedUseTheme = useTheme as jest.MockedFunction<typeof useTheme>;

// Tests assert against the JSON tree produced by react-test-renderer (via
// RenderResult.toJSON()), not against ReactTestInstance. RNSVG's test-instance
// fiber collapses Path siblings; the JSON tree exposes the canonical
// RNSVGSvgView -> RNSVGGroup -> RNSVGPath[] structure.
//
// At that level, color values arrive as `{type: 0, payload: <uint32>}` where
// payload === 0xFFRRGGBB packed unsigned. `>>> 0` is load-bearing — without
// it JS bitwise math returns the signed twin (e.g. `#FAF6EE` → -330002 instead
// of 4294637294) and toEqual fails.
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
function pathsOf(r: RenderResult): JsonNode[] {
  // RNSVG renders to: RNSVGSvgView -> RNSVGGroup -> RNSVGPath[]
  const svg = rootNode(r);
  const group = svg.children?.[0];
  return (group?.children ?? []) as JsonNode[];
}

beforeEach(() => {
  mockedUseTheme.mockReturnValue(lightTheme);
});

afterEach(() => {
  mockedUseTheme.mockReset();
});

describe('Droplet', () => {
  it('renders at default size 16 with the 24x24 viewBox', () => {
    const r = render(<Droplet testID="droplet" />);
    const svg = rootNode(r);
    expect(svg.props.width).toBe(16);
    expect(svg.props.height).toBe(16);
    // RNSVG normalizes the `viewBox` string into vbWidth/vbHeight at parse time.
    expect(svg.props.vbWidth).toBe(24);
    expect(svg.props.vbHeight).toBe(24);
  });

  it('renders at a custom size when size prop is passed', () => {
    const r = render(<Droplet testID="droplet" size={24} />);
    const svg = rootNode(r);
    expect(svg.props.width).toBe(24);
    expect(svg.props.height).toBe(24);
  });

  it('paints the path with the water token when filled=true', () => {
    const r = render(<Droplet testID="droplet" filled />);
    const [path] = pathsOf(r);
    expectColor(path.props.fill, lightTheme.colors.water);
    expectColor(path.props.stroke, lightTheme.colors.stroke);
  });

  it('paints the path with the surface token when filled is omitted (outline-only)', () => {
    const r = render(<Droplet testID="droplet" />);
    const [path] = pathsOf(r);
    expectColor(path.props.fill, lightTheme.colors.surface);
  });

  it('always paints the hairline stroke at strokeWidth 1 regardless of filled state', () => {
    const filledR = render(<Droplet testID="filled" filled />);
    const outlineR = render(<Droplet testID="outline" />);
    const [filled] = pathsOf(filledR);
    const [outline] = pathsOf(outlineR);
    expectColor(filled.props.stroke, lightTheme.colors.stroke);
    expect(filled.props.strokeWidth).toBe(1);
    expectColor(outline.props.stroke, lightTheme.colors.stroke);
    expect(outline.props.strokeWidth).toBe(1);
  });

  it('forwards accessibilityLabel to the Svg root when provided', () => {
    const r = render(<Droplet testID="droplet" accessibilityLabel="Tuesday, watered" />);
    const svg = rootNode(r);
    expect(svg.props.accessibilityLabel).toBe('Tuesday, watered');
  });

  it('flips fill from Conservatory cream to Midnight forest in dark mode without code changes', () => {
    mockedUseTheme.mockReturnValue(darkTheme);
    const r = render(<Droplet testID="droplet" />);
    const [path] = pathsOf(r);
    // surface in dark = forest (#1F3826); stroke in dark = cream (#FAF6EE).
    expectColor(path.props.fill, darkTheme.colors.surface);
    expectColor(path.props.stroke, darkTheme.colors.stroke);
    // Guard against a regression where useTheme is read but not threaded
    // through — packed payloads for cream and forest must differ.
    expect(packHex(darkTheme.colors.surface)).not.toBe(packHex(lightTheme.colors.surface));
    expect(packHex(darkTheme.colors.stroke)).not.toBe(packHex(lightTheme.colors.stroke));
  });
});

describe('LeafIcon', () => {
  it('renders at default size 14 with the 24x24 viewBox', () => {
    const r = render(<LeafIcon testID="leaf" />);
    const svg = rootNode(r);
    expect(svg.props.width).toBe(14);
    expect(svg.props.height).toBe(14);
    expect(svg.props.vbWidth).toBe(24);
    expect(svg.props.vbHeight).toBe(24);
  });

  it('renders at a custom size when size prop is passed', () => {
    const r = render(<LeafIcon testID="leaf" size={20} />);
    const svg = rootNode(r);
    expect(svg.props.width).toBe(20);
    expect(svg.props.height).toBe(20);
  });

  it('paints outline with surface fill + forest stroke at strokeWidth 1', () => {
    const r = render(<LeafIcon testID="leaf" />);
    const [outline] = pathsOf(r);
    expectColor(outline.props.fill, lightTheme.colors.surface);
    expectColor(outline.props.stroke, lightTheme.colors.stroke);
    expect(outline.props.strokeWidth).toBe(1);
  });

  it('forwards accessibilityLabel to the Svg root when provided', () => {
    const r = render(<LeafIcon testID="leaf" accessibilityLabel="Skip" />);
    const svg = rootNode(r);
    expect(svg.props.accessibilityLabel).toBe('Skip');
  });
});

describe('HandOnSoilIcon', () => {
  it('renders at default size 14 with the 24x24 viewBox', () => {
    const r = render(<HandOnSoilIcon testID="hand" />);
    const svg = rootNode(r);
    expect(svg.props.width).toBe(14);
    expect(svg.props.height).toBe(14);
    expect(svg.props.vbWidth).toBe(24);
    expect(svg.props.vbHeight).toBe(24);
  });

  it('renders at a custom size when size prop is passed', () => {
    const r = render(<HandOnSoilIcon testID="hand" size={18} />);
    const svg = rootNode(r);
    expect(svg.props.width).toBe(18);
    expect(svg.props.height).toBe(18);
  });

  it('paints soil + palm with surface fill + forest stroke matching the leaf treatment', () => {
    const r = render(<HandOnSoilIcon testID="hand" />);
    const [soil, palm] = pathsOf(r);
    expectColor(soil.props.fill, lightTheme.colors.surface);
    expectColor(soil.props.stroke, lightTheme.colors.stroke);
    expect(soil.props.strokeWidth).toBe(1);
    expectColor(palm.props.fill, lightTheme.colors.surface);
    expectColor(palm.props.stroke, lightTheme.colors.stroke);
    expect(palm.props.strokeWidth).toBe(1);
  });

  it('forwards accessibilityLabel to the Svg root when provided', () => {
    const r = render(<HandOnSoilIcon testID="hand" accessibilityLabel="Check soil" />);
    const svg = rootNode(r);
    expect(svg.props.accessibilityLabel).toBe('Check soil');
  });
});
