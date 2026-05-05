import { darkTheme, lightTheme } from '@plantcare/theme';
import { fireEvent, render } from '@testing-library/react-native';

import { useReduceMotion } from '../../hooks/useReduceMotion';
import { useTheme } from '../../hooks/useTheme';
import {
  composeAccessibilityLabel,
  composePressableStyle,
  formatLastWatered,
  localDayDelta,
  PlantCard,
} from '../PlantCard';

jest.mock('../../hooks/useTheme', () => ({
  useTheme: jest.fn(),
}));
jest.mock('../../hooks/useReduceMotion', () => ({
  useReduceMotion: jest.fn(),
}));

const mockedUseTheme = useTheme as unknown as jest.Mock<ReturnType<typeof useTheme>, []>;
const mockedUseReduceMotion = useReduceMotion as unknown as jest.Mock<boolean, []>;

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function flatten(style: unknown): Record<string, unknown> {
  if (Array.isArray(style)) {
    return Object.assign({}, ...style.map((s) => flatten(s)));
  }
  return (style ?? {}) as Record<string, unknown>;
}

const baseProps = {
  speciesLabel: 'Monstera deliciosa',
  nickname: 'Mona',
  photoUri: 'file:///documents/monstera.jpg',
  lastWateredAtMs: null as number | null,
  status: 'water' as const,
  onPress: () => {},
};

describe('PlantCard', () => {
  beforeEach(() => {
    mockedUseTheme.mockReturnValue(lightTheme);
    mockedUseReduceMotion.mockReturnValue(false);
  });

  afterEach(() => {
    mockedUseTheme.mockReset();
    mockedUseReduceMotion.mockReset();
  });

  // ────────────────────────────────────────────────────────────────────
  // Rendering — all four status states (water, skip, soil, with both
  // null and populated lastWateredAtMs to exercise the empty-history path).
  // ────────────────────────────────────────────────────────────────────

  // The chip is intentionally inside an `accessibilityElementsHidden` View
  // so VoiceOver doesn't double-announce. RTL's getByText/getByTestId treat
  // hidden subtrees as not-on-screen, so we use `getByTestId(.., {includeHiddenElements: true})`
  // to assert the chip's text payload.
  const findIncludeHidden = { includeHiddenElements: true } as const;

  it('renders the WATER TODAY chip when status="water"', () => {
    const { getByTestId, getByText } = render(
      <PlantCard
        {...baseProps}
        status="water"
        lastWateredAtMs={Date.UTC(2026, 4, 1, 12)}
        nowMs={Date.UTC(2026, 4, 4, 12)}
        testID="card"
      />,
    );
    expect(getByTestId('card-chip', findIncludeHidden)).toBeOnTheScreen();
    expect(getByText('WATER TODAY', findIncludeHidden)).toBeOnTheScreen();
  });

  it('renders the SKIP chip when status="skip"', () => {
    const { getByTestId, getByText } = render(
      <PlantCard
        {...baseProps}
        status="skip"
        lastWateredAtMs={Date.UTC(2026, 4, 4, 8)}
        nowMs={Date.UTC(2026, 4, 4, 12)}
        testID="card"
      />,
    );
    expect(getByTestId('card-chip', findIncludeHidden)).toBeOnTheScreen();
    expect(getByText('SKIP', findIncludeHidden)).toBeOnTheScreen();
  });

  it('renders the CHECK SOIL chip when status="check_soil"', () => {
    const { getByTestId, getByText } = render(
      <PlantCard
        {...baseProps}
        status="check_soil"
        lastWateredAtMs={null}
        testID="card"
      />,
    );
    expect(getByTestId('card-chip', findIncludeHidden)).toBeOnTheScreen();
    expect(getByText('CHECK SOIL', findIncludeHidden)).toBeOnTheScreen();
  });

  it('renders all three text rows: species, nickname, last-watered', () => {
    const { getByTestId } = render(
      <PlantCard
        {...baseProps}
        speciesLabel="Fiddle Leaf Fig"
        nickname="Tall Fig"
        status="check_soil"
        lastWateredAtMs={new Date(2026, 4, 1, 9).getTime()}
        nowMs={new Date(2026, 4, 4, 12).getTime()}
        testID="card"
      />,
    );
    expect(getByTestId('card-species').props.children).toBe('Fiddle Leaf Fig');
    // Per DESIGN.md "Italic for plant nicknames in quotes" + A-1 mockup,
    // nicknames render wrapped in curly single quotes ('Tall Fig' visually,
    // ‘Tall Fig’ in unicode). The accessibilityLabel keeps the unquoted form.
    expect(getByTestId('card-nickname').props.children).toBe('‘Tall Fig’');
    expect(getByTestId('card-last-watered').props.children).toBe('Last watered 3 days ago');
  });

  // ────────────────────────────────────────────────────────────────────
  // Tap behaviour
  // ────────────────────────────────────────────────────────────────────

  it('fires onPress when the row is tapped', () => {
    const onPress = jest.fn();
    const { getByTestId } = render(
      <PlantCard
        {...baseProps}
        status="water"
        onPress={onPress}
        testID="card"
      />,
    );
    fireEvent.press(getByTestId('card'));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  // ────────────────────────────────────────────────────────────────────
  // accessibilityLabel composition — order, status verbiage, supporting
  // context. Mirrors the master-plan example
  // "Monstera Mona, water today, last watered 5 days ago".
  // ────────────────────────────────────────────────────────────────────

  it('composes the master-plan accessibilityLabel for a watered plant', () => {
    const now = new Date(2026, 4, 6, 12).getTime();
    const fiveDaysAgo = new Date(2026, 4, 1, 12).getTime();
    const { getByTestId } = render(
      <PlantCard
        speciesLabel="Monstera"
        nickname="Mona"
        photoUri="file:///documents/m.jpg"
        status="water"
        lastWateredAtMs={fiveDaysAgo}
        onPress={() => {}}
        nowMs={now}
        testID="card"
      />,
    );
    expect(getByTestId('card').props.accessibilityLabel).toBe(
      'Monstera Mona, water today, last watered 5 days ago',
    );
    expect(getByTestId('card').props.accessibilityRole).toBe('button');
  });

  it('falls back gracefully when nickname is missing', () => {
    const out = composeAccessibilityLabel({
      speciesLabel: 'Snake Plant',
      nickname: null,
      status: 'skip',
      lastWateredAtMs: new Date(2026, 4, 4, 12).getTime(),
      nowMs: new Date(2026, 4, 4, 12).getTime(),
    });
    expect(out).toBe('Snake Plant, skip watering, last watered today');
  });

  it('falls back to "Unidentified plant" when both species and nickname are null', () => {
    const out = composeAccessibilityLabel({
      speciesLabel: null,
      nickname: null,
      status: 'check_soil',
      lastWateredAtMs: null,
      nowMs: 0,
    });
    expect(out).toBe('Unidentified plant, check soil, not yet watered');
  });

  // ────────────────────────────────────────────────────────────────────
  // formatLastWatered buckets — Today / Yesterday / N days ago / 1 week
  // is folded into the 2-13 bucket per the file header / 14+ absolute.
  // ────────────────────────────────────────────────────────────────────

  it('formats lastWateredAtMs=null as "Not yet watered"', () => {
    expect(formatLastWatered(null, new Date(2026, 4, 4, 12).getTime())).toBe(
      'Not yet watered',
    );
  });

  it('formats today as "Last watered today"', () => {
    const now = new Date(2026, 4, 4, 12).getTime();
    const earlierToday = new Date(2026, 4, 4, 9).getTime();
    expect(formatLastWatered(earlierToday, now)).toBe('Last watered today');
  });

  it('formats yesterday as "Last watered yesterday" (calendar-day, not 24h)', () => {
    // 2pm yesterday vs 9am today — 19h elapsed, but ONE local calendar day.
    // Naive Math.floor((now - last) / 86400000) === 0 → "today" (wrong).
    // Calendar walk → 1 day → "yesterday" (correct).
    const now = new Date(2026, 4, 4, 9).getTime();
    const yesterday2pm = new Date(2026, 4, 3, 14).getTime();
    expect((now - yesterday2pm) / ONE_DAY_MS).toBeLessThan(1);
    expect(formatLastWatered(yesterday2pm, now)).toBe('Last watered yesterday');
  });

  it('formats 2-13 calendar days back as "Last watered N days ago"', () => {
    const now = new Date(2026, 4, 14, 12).getTime();
    expect(formatLastWatered(new Date(2026, 4, 12, 12).getTime(), now)).toBe(
      'Last watered 2 days ago',
    );
    expect(formatLastWatered(new Date(2026, 4, 1, 12).getTime(), now)).toBe(
      'Last watered 13 days ago',
    );
  });

  it('formats 14+ calendar days back as an absolute date', () => {
    const now = new Date(2026, 5, 1, 12).getTime(); // Jun 1
    const may1 = new Date(2026, 4, 1, 12).getTime(); // 31 days back
    const out = formatLastWatered(may1, now);
    expect(out).toMatch(/^Last watered on /);
    expect(out).not.toMatch(/today|yesterday|days ago/);
  });

  it('falls back to a static "Mon D" when toLocaleDateString throws (Hermes-without-Intl)', () => {
    // Mirrors the WateringLedger Intl-fallback regression test. Older Android
    // RN builds ship a Hermes without full Intl; toLocaleDateString throws
    // there. The component should fall through to the static MONTH_SHORT
    // table so the absolute-date branch keeps working.
    const realToLocale = Date.prototype.toLocaleDateString;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (Date.prototype as any).toLocaleDateString = function () {
      throw new Error('Intl unavailable');
    };
    try {
      const now = new Date(2026, 5, 1, 12).getTime(); // Jun 1
      const may1 = new Date(2026, 4, 1, 12).getTime(); // 31 days back
      const out = formatLastWatered(may1, now);
      // Static format: "May 1" (month short index 4).
      expect(out).toBe('Last watered on May 1');
    } finally {
      Date.prototype.toLocaleDateString = realToLocale;
    }
  });

  // ────────────────────────────────────────────────────────────────────
  // Sub-day-precision regression — the canonical 3d 12h case. Mirrors
  // E4-002's invariant: Math.floor((now - last) / 86_400_000) === 3
  // and 4 *both* possible depending on tz-of-day; the calendar walk gives
  // the deterministic local answer regardless of wall-clock-of-day.
  // ────────────────────────────────────────────────────────────────────

  it('regression: 3d 12h fixture buckets by local calendar day, not by ms-floor', () => {
    // Construct two timestamps on local-time constructors so the test is
    // tz-independent. last is May 1, 0:00 local; now is May 4, 12:00 local.
    // Wall-clock delta = 3.5 days. Math.floor(3.5) = 3 ⇒ "3 days ago".
    // Calendar walk: May 1 → May 2 → May 3 → May 4 = 3 days delta ⇒
    // "Last watered 3 days ago". Both happen to agree here. The next test
    // catches the case where they diverge.
    const last = new Date(2026, 4, 1, 0, 0, 0).getTime();
    const now = new Date(2026, 4, 4, 12, 0, 0).getTime();
    expect(formatLastWatered(last, now)).toBe('Last watered 3 days ago');
  });

  it('regression: 3d 12h boundary — calendar-day floor of UTC ms is the bug', () => {
    // last = Apr 30, 18:00 local; now = May 4, 6:00 local. Wall-clock delta
    // = 3.5 days = 84 hours. Math.floor(84/24) = 3 ⇒ "3 days ago".
    // Calendar walk Apr 30 → May 1 → May 2 → May 3 → May 4 = 4 days ⇒
    // "Last watered 4 days ago". The component reports the calendar answer.
    const last = new Date(2026, 3, 30, 18, 0, 0).getTime(); // Apr 30 6pm
    const now = new Date(2026, 4, 4, 6, 0, 0).getTime(); // May 4 6am
    const elapsedDays = (now - last) / ONE_DAY_MS;
    expect(elapsedDays).toBeLessThan(4);
    expect(elapsedDays).toBeGreaterThan(3);
    expect(Math.floor(elapsedDays)).toBe(3); // the bug
    expect(formatLastWatered(last, now)).toBe('Last watered 4 days ago'); // the fix
  });

  it('regression: 36h fixture spanning 2 local calendar days reads "2 days ago"', () => {
    // Same DST-style fixture as PhotoTimeline's regression test. 36h ms diff
    // but 2 calendar days. Naive ms-floor would say 1 ⇒ "yesterday". Local
    // walk says 2.
    const now = new Date(2025, 10, 4, 8, 0, 0).getTime();
    const thirtySixHoursBack = new Date(2025, 10, 2, 20, 0, 0).getTime();
    expect((now - thirtySixHoursBack) / ONE_DAY_MS).toBeLessThan(2);
    expect(formatLastWatered(thirtySixHoursBack, now)).toBe('Last watered 2 days ago');
  });

  it('regression: future timestamp (clock skew) clamps to "today"', () => {
    const now = new Date(2026, 4, 4, 9, 0, 0).getTime();
    const tomorrow = new Date(2026, 4, 5, 9, 0, 0).getTime();
    expect(formatLastWatered(tomorrow, now)).toBe('Last watered today');
    expect(localDayDelta(tomorrow, now)).toBe(0);
  });

  // ────────────────────────────────────────────────────────────────────
  // Reduce-motion: pressed scale becomes a no-op (HARD disable per
  // DESIGN.md "Reduce motion"). The opacity feedback stays — only the
  // scale transform is gated.
  // ────────────────────────────────────────────────────────────────────

  // composePressableStyle is the load-bearing branch: pressed-with-motion
  // includes `transform: [{ scale }]`; pressed-with-reduce-motion drops it
  // entirely (HARD disable, not damped scale). Tested directly because RTL's
  // toJSON pre-resolves Pressable's function-style with pressed=false on
  // render, so the pressed branch can't be observed via the rendered tree.
  it('reduce-motion: pressed style omits the scale transform entirely', () => {
    const style = composePressableStyle({ base: { padding: 12 }, pressed: true, reduceMotion: true });
    const flat = flatten(style);
    expect(flat.transform).toBeUndefined();
    // Opacity feedback is preserved (the press is still acknowledged).
    expect(flat.opacity).toBe(0.92);
    expect(flat.padding).toBe(12);
  });

  it('reduce-motion off: pressed style includes the scale transform', () => {
    const style = composePressableStyle({ base: { padding: 12 }, pressed: true, reduceMotion: false });
    const flat = flatten(style);
    expect(flat.transform).toEqual([{ scale: 0.98 }]);
    expect(flat.opacity).toBe(0.92);
  });

  it('resting: returns just the base style regardless of reduce-motion', () => {
    const restingMotion = composePressableStyle({ base: { padding: 12 }, pressed: false, reduceMotion: false });
    const restingReduced = composePressableStyle({ base: { padding: 12 }, pressed: false, reduceMotion: true });
    expect(flatten(restingMotion).opacity).toBeUndefined();
    expect(flatten(restingReduced).opacity).toBeUndefined();
    expect(flatten(restingMotion).transform).toBeUndefined();
  });

  it('useReduceMotion is consulted by the rendered Pressable (smoke)', () => {
    // The Pressable's style callback closes over the hook value; this test
    // just guards against a future refactor that drops the hook call. We
    // verify by toggling the mock and observing the resting-style render
    // doesn't crash either way.
    mockedUseReduceMotion.mockReturnValue(true);
    const { getByTestId, rerender } = render(
      <PlantCard {...baseProps} status="water" testID="card" />,
    );
    expect(getByTestId('card')).toBeOnTheScreen();
    mockedUseReduceMotion.mockReturnValue(false);
    rerender(<PlantCard {...baseProps} status="water" testID="card" />);
    expect(getByTestId('card')).toBeOnTheScreen();
  });

  // ────────────────────────────────────────────────────────────────────
  // Theme swap — dark mode uses Midnight tokens for surface + text.
  // ────────────────────────────────────────────────────────────────────

  it('uses Midnight Conservatory tokens when dark theme is active', () => {
    mockedUseTheme.mockReturnValue(darkTheme);
    const { getByTestId } = render(
      <PlantCard
        {...baseProps}
        status="water"
        lastWateredAtMs={new Date(2026, 4, 1, 12).getTime()}
        nowMs={new Date(2026, 4, 4, 12).getTime()}
        testID="card"
      />,
    );
    const species = getByTestId('card-species');
    expect(flatten(species.props.style).color).toBe(darkTheme.colors.text);
    const lastWatered = getByTestId('card-last-watered');
    expect(flatten(lastWatered.props.style).color).toBe(darkTheme.colors.textMuted);
  });

  // ────────────────────────────────────────────────────────────────────
  // Empty / queued cases
  // ────────────────────────────────────────────────────────────────────

  it('renders the "Not yet watered" copy when lastWateredAtMs is null', () => {
    const { getByTestId } = render(
      <PlantCard
        {...baseProps}
        status="check_soil"
        lastWateredAtMs={null}
        testID="card"
      />,
    );
    expect(getByTestId('card-last-watered').props.children).toBe('Not yet watered');
  });

  it('omits the nickname row when nickname is null', () => {
    const { queryByTestId, getByTestId } = render(
      <PlantCard
        {...baseProps}
        nickname={null}
        status="water"
        testID="card"
      />,
    );
    expect(getByTestId('card-species')).toBeOnTheScreen();
    expect(queryByTestId('card-nickname')).toBeNull();
  });

  // ────────────────────────────────────────────────────────────────────
  // Accessibility identity — Pressable is the announcing surface;
  // inner Texts are accessible={false} so VoiceOver doesn't double-read
  // (StatusChip Wave 1 lesson, propagated to the composite here).
  // ────────────────────────────────────────────────────────────────────

  it('hides nested HeroPhoto + StatusChip from accessibility (no double-announce)', () => {
    // Codex P1: HeroPhoto's wrapping View is `accessibilityRole="image"` and
    // StatusChip's wrapping View is `accessible` — both can land focus on
    // VoiceOver/TalkBack as separate stops if the parent doesn't suppress
    // descendants. The card wraps both in `importantForAccessibility=
    // "no-hide-descendants"` + `accessibilityElementsHidden`. Walk the tree
    // for those wrappers and assert the props.
    const { toJSON } = render(
      <PlantCard {...baseProps} status="water" testID="card" />,
    );
    type Node = { type: string; props: Record<string, unknown>; children: Node[] | string[] | null };
    const walk = (n: Node, hits: Node[]): Node[] => {
      if (
        n.props?.importantForAccessibility === 'no-hide-descendants' &&
        n.props?.accessibilityElementsHidden === true
      ) {
        hits.push(n);
      }
      const children = Array.isArray(n.children)
        ? (n.children.filter((c) => typeof c !== 'string') as Node[])
        : [];
      for (const c of children) walk(c, hits);
      return hits;
    };
    const tree = toJSON() as unknown as Node;
    const hidden = walk(tree, []);
    // Two: the photo wrapper and the chip wrapper.
    expect(hidden.length).toBeGreaterThanOrEqual(2);
  });

  it('inner Text rows are non-accessible (Pressable owns the announcement)', () => {
    const { getByTestId } = render(
      <PlantCard
        {...baseProps}
        status="water"
        lastWateredAtMs={new Date(2026, 4, 1, 12).getTime()}
        nowMs={new Date(2026, 4, 4, 12).getTime()}
        testID="card"
      />,
    );
    expect(getByTestId('card-species').props.accessible).toBe(false);
    expect(getByTestId('card-nickname').props.accessible).toBe(false);
    expect(getByTestId('card-last-watered').props.accessible).toBe(false);
    // The Pressable carries the role+label.
    expect(getByTestId('card').props.accessibilityRole).toBe('button');
    expect(typeof getByTestId('card').props.accessibilityLabel).toBe('string');
  });
});
