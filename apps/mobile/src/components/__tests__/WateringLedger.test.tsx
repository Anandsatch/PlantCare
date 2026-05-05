import { darkTheme, lightTheme } from '@plantcare/theme';
import { render, type RenderResult } from '@testing-library/react-native';

// Mock useTheme per the established pattern (icons.test.tsx + useTheme.test.tsx).
jest.mock('../../hooks/useTheme', () => ({
  useTheme: jest.fn(),
}));

import { useTheme } from '../../hooks/useTheme';
import { WateringLedger, type WateringEvent } from '../WateringLedger';

const mockedUseTheme = useTheme as jest.MockedFunction<typeof useTheme>;

// Color packing helper — RNSVG normalizes color props to {type:0, payload:uint32}
// where payload === 0xFFRRGGBB. The icons.test.tsx file documents this. We use
// the same approach to verify droplet fill/stroke per column.
type ColorPayload = { type: 0; payload: number };
function packHex(hex: string): number {
  const rgb = parseInt(hex.slice(1), 16);
  return (0xff000000 | rgb) >>> 0;
}
function isColor(actual: unknown, hex: string): boolean {
  const expected: ColorPayload = { type: 0, payload: packHex(hex) };
  return JSON.stringify(actual) === JSON.stringify(expected);
}

type JsonNode = {
  type: string;
  props: Record<string, unknown>;
  children: (JsonNode | string)[] | null;
};

function rootNode(r: RenderResult): JsonNode {
  const tree = r.toJSON();
  if (Array.isArray(tree)) return tree[0] as unknown as JsonNode;
  return tree as unknown as JsonNode;
}

/**
 * Walk the rendered tree and find every RNSVGSvgView (one per column droplet)
 * in document order — i.e. left-to-right column order.
 */
function collectDroplets(node: JsonNode | string | null): JsonNode[] {
  if (!node || typeof node === 'string') return [];
  const out: JsonNode[] = [];
  if (typeof node.type === 'string' && node.type.startsWith('RNSVGSvgView')) {
    out.push(node);
  }
  if (node.children) {
    for (const child of node.children) {
      out.push(...collectDroplets(child as JsonNode));
    }
  }
  return out;
}

/**
 * Read the fill payload of a droplet's <Path> child, which is what tells us
 * whether the droplet is filled (water token) or outline-only (surface token).
 */
function dropletFill(svg: JsonNode): unknown {
  const group = (svg.children?.[0] as JsonNode) ?? null;
  const path = (group?.children?.[0] as JsonNode) ?? null;
  return path?.props?.fill;
}

function isFilled(svg: JsonNode, theme: typeof lightTheme): boolean {
  return isColor(dropletFill(svg), theme.colors.water);
}

// 2026-05-04 was a Monday in any tz where users currently live (US/EU/IN).
// Using noon-local removes any DST-edge ambiguity from the day anchor itself.
const MONDAY_2026_05_04_NOON = new Date(2026, 4, 4, 12, 0, 0, 0).getTime();

function eventNDaysAgoNoon(n: number, anchorMs: number): WateringEvent {
  const d = new Date(anchorMs - n * 86_400_000);
  d.setHours(12, 0, 0, 0);
  return { wateredAtMs: d.getTime() };
}

beforeEach(() => {
  mockedUseTheme.mockReturnValue(lightTheme);
});

afterEach(() => {
  mockedUseTheme.mockReset();
});

describe('WateringLedger', () => {
  it('renders 7 outline-only droplets and the empty caption when events is empty', () => {
    const r = render(
      <WateringLedger events={[]} startDate={MONDAY_2026_05_04_NOON} />
    );
    const droplets = collectDroplets(rootNode(r));
    expect(droplets).toHaveLength(7);
    for (const d of droplets) {
      expect(isFilled(d, lightTheme)).toBe(false);
    }
    expect(r.getByText(/No watering recorded yet/i)).toBeTruthy();
  });

  it('fills only the today column when there is one event today', () => {
    const r = render(
      <WateringLedger
        events={[eventNDaysAgoNoon(0, MONDAY_2026_05_04_NOON)]}
        startDate={MONDAY_2026_05_04_NOON}
      />
    );
    const droplets = collectDroplets(rootNode(r));
    const filled = droplets.map((d) => isFilled(d, lightTheme));
    expect(filled).toEqual([false, false, false, false, false, false, true]);
  });

  it('fills the correct historical column when an event was 3 days ago', () => {
    const r = render(
      <WateringLedger
        events={[eventNDaysAgoNoon(3, MONDAY_2026_05_04_NOON)]}
        startDate={MONDAY_2026_05_04_NOON}
      />
    );
    const droplets = collectDroplets(rootNode(r));
    const filled = droplets.map((d) => isFilled(d, lightTheme));
    // index 6 = today, index 3 = three days ago.
    expect(filled).toEqual([false, false, false, true, false, false, false]);
  });

  it('fills all 7 columns when there is one event per day', () => {
    const events = [0, 1, 2, 3, 4, 5, 6].map((n) =>
      eventNDaysAgoNoon(n, MONDAY_2026_05_04_NOON)
    );
    const r = render(
      <WateringLedger events={events} startDate={MONDAY_2026_05_04_NOON} />
    );
    const droplets = collectDroplets(rootNode(r));
    expect(droplets.every((d) => isFilled(d, lightTheme))).toBe(true);
  });

  it('does not fill any column when the only event is 8 days ago (out of window)', () => {
    const r = render(
      <WateringLedger
        events={[eventNDaysAgoNoon(8, MONDAY_2026_05_04_NOON)]}
        startDate={MONDAY_2026_05_04_NOON}
      />
    );
    const droplets = collectDroplets(rootNode(r));
    expect(droplets.every((d) => !isFilled(d, lightTheme))).toBe(true);
    // Caption only renders when events.length === 0, not when all events are
    // out of window. Defensive — see WateringLedger.tsx isEmpty semantics.
    expect(r.queryByText(/No watering recorded yet/i)).toBeNull();
  });

  it('ignores events in the future (defensive)', () => {
    const future = MONDAY_2026_05_04_NOON + 2 * 86_400_000;
    const r = render(
      <WateringLedger
        events={[{ wateredAtMs: future }]}
        startDate={MONDAY_2026_05_04_NOON}
      />
    );
    const droplets = collectDroplets(rootNode(r));
    expect(droplets.every((d) => !isFilled(d, lightTheme))).toBe(true);
  });

  it('shows the today indicator dot only on the rightmost column', () => {
    const r = render(
      <WateringLedger events={[]} startDate={MONDAY_2026_05_04_NOON} />
    );
    // Today dot has backgroundColor === theme.colors.text. Walk the tree and
    // count Views with that backgroundColor in their style — should be 1.
    function countTodayDots(node: JsonNode | string | null): number {
      if (!node || typeof node === 'string') return 0;
      let n = 0;
      if (typeof node.type === 'string' && node.type === 'View') {
        const style = node.props.style;
        const arr = Array.isArray(style) ? style : [style];
        for (const s of arr) {
          if (
            s &&
            typeof s === 'object' &&
            (s as Record<string, unknown>).backgroundColor === lightTheme.colors.text
          ) {
            n++;
          }
        }
      }
      if (node.children) {
        for (const c of node.children) n += countTodayDots(c as JsonNode);
      }
      return n;
    }
    expect(countTodayDots(rootNode(r))).toBe(1);
  });

  it('orders columns oldest-on-left, today-on-right (event 6 days ago lands in column 0; today in column 6)', () => {
    const r = render(
      <WateringLedger
        events={[
          eventNDaysAgoNoon(6, MONDAY_2026_05_04_NOON),
          eventNDaysAgoNoon(0, MONDAY_2026_05_04_NOON),
        ]}
        startDate={MONDAY_2026_05_04_NOON}
      />
    );
    const droplets = collectDroplets(rootNode(r));
    const filled = droplets.map((d) => isFilled(d, lightTheme));
    expect(filled[0]).toBe(true);
    expect(filled[6]).toBe(true);
    // Middle columns untouched.
    for (let i = 1; i <= 5; i++) expect(filled[i]).toBe(false);
  });

  it('day-of-week labels reflect the actual weekday (Mon anchor → leftmost is Tue 6 days prior)', () => {
    // Anchor: Mon 2026-05-04. Six days prior = Tue 2026-04-28.
    // Labels are environment-locale-dependent (en-* gives "TUE"); we assert
    // that the rightmost label is the same weekday as the anchor and the
    // leftmost is the weekday of (anchor - 6 days), without hard-coding "TUE"
    // (CI may run in a non-English locale via test runner config).
    const r = render(
      <WateringLedger events={[]} startDate={MONDAY_2026_05_04_NOON} />
    );
    const expectedRightmost = new Date(MONDAY_2026_05_04_NOON)
      .toLocaleDateString(undefined, { weekday: 'short' })
      .toUpperCase()
      .slice(0, 3);
    const expectedLeftmost = new Date(MONDAY_2026_05_04_NOON - 6 * 86_400_000)
      .toLocaleDateString(undefined, { weekday: 'short' })
      .toUpperCase()
      .slice(0, 3);
    expect(r.getAllByText(expectedRightmost).length).toBeGreaterThan(0);
    expect(r.getAllByText(expectedLeftmost).length).toBeGreaterThan(0);
  });

  it('reskins droplet stroke + caption color in dark mode without a code path change', () => {
    mockedUseTheme.mockReturnValue(darkTheme);
    const r = render(
      <WateringLedger events={[]} startDate={MONDAY_2026_05_04_NOON} />
    );
    // In dark mode the outline droplet's stroke flips to cream (#FAF6EE).
    const droplets = collectDroplets(rootNode(r));
    const firstPath = (droplets[0].children?.[0] as JsonNode)
      ?.children?.[0] as JsonNode;
    expect(isColor(firstPath.props.stroke, darkTheme.colors.stroke)).toBe(true);

    // Empty caption color resolves to theme.colors.textMuted (Midnight ~ #B5B2A8).
    const caption = r.getByText(/No watering recorded yet/i);
    const styleProp: unknown = caption.props.style;
    const styleArr: unknown[] = Array.isArray(styleProp) ? styleProp : [styleProp];
    let color: string | undefined;
    for (const s of styleArr) {
      if (s && typeof s === 'object' && 'color' in (s as Record<string, unknown>)) {
        color = (s as Record<string, unknown>).color as string;
      }
    }
    expect(color).toBe(darkTheme.colors.textMuted);
  });

  it('exposes a per-column accessibilityLabel that names the day and its watered state', () => {
    const r = render(
      <WateringLedger
        events={[eventNDaysAgoNoon(0, MONDAY_2026_05_04_NOON)]}
        startDate={MONDAY_2026_05_04_NOON}
      />
    );
    // Today's full weekday name as VoiceOver will read it.
    const todayName = new Date(MONDAY_2026_05_04_NOON).toLocaleDateString(
      undefined,
      { weekday: 'long' }
    );
    expect(r.getByLabelText(`${todayName}, watered`)).toBeTruthy();

    // 6 days prior had no event — its column should advertise the no-watering state.
    const oldName = new Date(
      MONDAY_2026_05_04_NOON - 6 * 86_400_000
    ).toLocaleDateString(undefined, { weekday: 'long' });
    expect(r.getByLabelText(`${oldName}, no watering recorded`)).toBeTruthy();
  });

  it('treats two events on the same day as a single filled column (idempotent)', () => {
    const today1 = eventNDaysAgoNoon(0, MONDAY_2026_05_04_NOON);
    const today2: WateringEvent = {
      wateredAtMs: today1.wateredAtMs + 5 * 60 * 60 * 1000, // +5 hours, same local day
    };
    const r = render(
      <WateringLedger
        events={[today1, today2]}
        startDate={MONDAY_2026_05_04_NOON}
      />
    );
    const droplets = collectDroplets(rootNode(r));
    const filled = droplets.map((d) => isFilled(d, lightTheme));
    // Exactly one column filled.
    expect(filled.filter(Boolean).length).toBe(1);
    expect(filled[6]).toBe(true);
  });

  it('uses the default accessibilityLabel "7-day watering history" on the root', () => {
    const r = render(
      <WateringLedger events={[]} startDate={MONDAY_2026_05_04_NOON} />
    );
    expect(r.getByLabelText('7-day watering history')).toBeTruthy();
  });

  // === DST regression tests ===
  // The component snaps every column to local midnight via setHours(0,0,0,0)
  // so a 23-hour spring-forward day or 25-hour fall-back day still buckets
  // events into the correct column. These pin the contract.
  //
  // Anchor dates use US/EU 2026 DST transitions:
  //   - US spring forward: 2026-03-08 (Sunday). Bucketing window includes
  //     the 23-hour day.
  //   - US fall back: 2026-11-01 (Sunday). Bucketing window includes the
  //     25-hour day.
  // The actual DST behavior depends on the test runner's TZ. Jest defaults
  // to the host TZ; CI runs UTC where DST is a no-op (good — these tests
  // must still pass, asserting the underlying ms-stepping is correct
  // regardless of whether the host actually observes DST).

  it('buckets an event on a US-spring-forward day to the correct column', () => {
    // 2026-03-08 was the US spring-forward Sunday. Anchor 2 days later
    // (Tue 2026-03-10 at noon) so the spring-forward Sunday is column index 4
    // (today=6, ystrday=5, sun=4).
    const tueAfter = new Date(2026, 2, 10, 12, 0, 0, 0).getTime();
    const sundaySpringForward: WateringEvent = {
      wateredAtMs: new Date(2026, 2, 8, 12, 0, 0, 0).getTime(),
    };
    const r = render(
      <WateringLedger events={[sundaySpringForward]} startDate={tueAfter} />
    );
    const droplets = collectDroplets(rootNode(r));
    const filled = droplets.map((d) => isFilled(d, lightTheme));
    expect(filled[4]).toBe(true);
    // Exactly one filled — no duplicate buckets across the DST seam.
    expect(filled.filter(Boolean).length).toBe(1);
  });

  it('buckets an event on a US-fall-back day to the correct column', () => {
    // 2026-11-01 was the US fall-back Sunday (25-hour local day).
    const tueAfter = new Date(2026, 10, 3, 12, 0, 0, 0).getTime();
    const sundayFallBack: WateringEvent = {
      wateredAtMs: new Date(2026, 10, 1, 12, 0, 0, 0).getTime(),
    };
    const r = render(
      <WateringLedger events={[sundayFallBack]} startDate={tueAfter} />
    );
    const droplets = collectDroplets(rootNode(r));
    const filled = droplets.map((d) => isFilled(d, lightTheme));
    expect(filled[4]).toBe(true);
    expect(filled.filter(Boolean).length).toBe(1);
  });

  it('falls back to a hard-coded weekday when toLocaleDateString throws (Android RN with limited Intl)', () => {
    const realToLocale = Date.prototype.toLocaleDateString;
    // Force the Intl path to throw, exercising the fallback table.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (Date.prototype as any).toLocaleDateString = function () {
      throw new Error('Intl unavailable');
    };
    try {
      const r = render(
        <WateringLedger events={[]} startDate={MONDAY_2026_05_04_NOON} />
      );
      // Anchor is Monday → rightmost label must be 'MON' from the fallback table.
      expect(r.getAllByText('MON').length).toBeGreaterThan(0);
      // 6 days prior = Tuesday → fallback labels 'TUE' on the leftmost column.
      expect(r.getAllByText('TUE').length).toBeGreaterThan(0);
      // Per-column accessibilityLabel uses the long fallback.
      expect(r.getByLabelText('Monday, no watering recorded')).toBeTruthy();
    } finally {
      Date.prototype.toLocaleDateString = realToLocale;
    }
  });
});
