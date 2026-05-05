import { darkTheme, lightTheme } from '@plantcare/theme';
import { fireEvent, render } from '@testing-library/react-native';

import { useTheme } from '../../hooks/useTheme';
import { formatRelativeDate, PhotoTimeline, type PhotoEntry } from '../PhotoTimeline';

jest.mock('../../hooks/useTheme', () => ({
  useTheme: jest.fn(),
}));

const mockedUseTheme = useTheme as unknown as jest.Mock<ReturnType<typeof useTheme>, []>;

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function flatten(style: unknown): Record<string, unknown> {
  if (Array.isArray(style)) {
    return Object.assign({}, ...style.map((s) => flatten(s)));
  }
  return (style ?? {}) as Record<string, unknown>;
}

function makePhoto(overrides: Partial<PhotoEntry> & { id: string; takenAtMs: number }): PhotoEntry {
  return {
    uri: `file:///documents/${overrides.id}.jpg`,
    ...overrides,
  };
}

describe('PhotoTimeline', () => {
  beforeEach(() => {
    mockedUseTheme.mockReturnValue(lightTheme);
  });

  afterEach(() => {
    mockedUseTheme.mockReset();
  });

  it('renders an italic empty-state line when photos is empty', () => {
    const { getByTestId, queryAllByLabelText } = render(
      <PhotoTimeline photos={[]} testID="timeline" />,
    );
    const empty = getByTestId('timeline-empty');
    expect(empty).toBeOnTheScreen();
    expect(empty.props.children).toMatch(/No photos yet/i);
    expect(flatten(empty.props.style).fontStyle).toBe('italic');
    // No thumbnails.
    expect(queryAllByLabelText(/Photo from/)).toHaveLength(0);
  });

  it('renders a single thumbnail + date label for one photo', () => {
    const now = Date.UTC(2026, 4, 4, 12, 0, 0);
    const photos = [makePhoto({ id: 'a', takenAtMs: now })];
    const { getAllByLabelText } = render(
      <PhotoTimeline photos={photos} nowMs={now} testID="timeline" />,
    );
    expect(getAllByLabelText(/Photo from Today/)).toHaveLength(1);
  });

  it('renders 4 thumbnails for 4 photos (with onPhotoPress wired)', () => {
    const now = new Date(2026, 4, 4, 12, 0, 0).getTime();
    const photos = [0, 1, 2, 3].map((i) =>
      makePhoto({ id: `p${i}`, takenAtMs: now - i * ONE_DAY_MS }),
    );
    const onPress = jest.fn();
    const { getByTestId } = render(
      <PhotoTimeline photos={photos} nowMs={now} onPhotoPress={onPress} testID="timeline" />,
    );
    expect(getByTestId('timeline-tile-p0')).toBeOnTheScreen();
    expect(getByTestId('timeline-tile-p1')).toBeOnTheScreen();
    expect(getByTestId('timeline-tile-p2')).toBeOnTheScreen();
    expect(getByTestId('timeline-tile-p3')).toBeOnTheScreen();
  });

  it('renders the 4 most-recent when given 5 photos and drops the oldest', () => {
    const now = new Date(2026, 4, 4, 12, 0, 0).getTime();
    const photos = [0, 1, 2, 3, 4].map((i) =>
      makePhoto({ id: `p${i}`, takenAtMs: now - i * ONE_DAY_MS }),
    );
    const onPress = jest.fn();
    const { getByTestId, queryByTestId } = render(
      <PhotoTimeline photos={photos} nowMs={now} onPhotoPress={onPress} testID="timeline" />,
    );
    // p0..p3 render; p4 (oldest) does not.
    expect(getByTestId('timeline-tile-p0')).toBeOnTheScreen();
    expect(getByTestId('timeline-tile-p1')).toBeOnTheScreen();
    expect(getByTestId('timeline-tile-p2')).toBeOnTheScreen();
    expect(getByTestId('timeline-tile-p3')).toBeOnTheScreen();
    expect(queryByTestId('timeline-tile-p4')).toBeNull();
  });

  it('sorts photos most-recent-first when input order is random', () => {
    const now = new Date(2026, 4, 4, 12, 0, 0).getTime();
    const photos = [
      makePhoto({ id: 'old', takenAtMs: now - 5 * ONE_DAY_MS }),
      makePhoto({ id: 'newest', takenAtMs: now }),
      makePhoto({ id: 'mid', takenAtMs: now - 2 * ONE_DAY_MS }),
    ];
    const onPress = jest.fn();
    const { getByTestId } = render(
      <PhotoTimeline photos={photos} nowMs={now} onPhotoPress={onPress} testID="timeline" />,
    );
    // Walk the parent chain from each tile up to the timeline; record the
    // index-of-appearance to confirm DOM order.
    const root = getByTestId('timeline');
    function findIdsInOrder(node: { children: unknown[] }): string[] {
      const acc: string[] = [];
      function walk(n: { props?: { testID?: unknown }; children?: unknown[] }): void {
        if (typeof n.props?.testID === 'string' && n.props.testID.startsWith('timeline-tile-')) {
          const id = n.props.testID.replace('timeline-tile-', '');
          if (!acc.includes(id)) acc.push(id);
        }
        for (const c of (n.children ?? []) as Array<{
          props?: { testID?: unknown };
          children?: unknown[];
        }>) {
          if (typeof c === 'object' && c !== null) walk(c);
        }
      }
      walk(node as unknown as { props?: { testID?: unknown }; children?: unknown[] });
      return acc;
    }
    expect(findIdsInOrder(root as unknown as { children: unknown[] })).toEqual([
      'newest',
      'mid',
      'old',
    ]);
  });

  it('formats "Today" when takenAtMs equals nowMs', () => {
    const now = new Date(2026, 4, 4, 12, 0, 0).getTime();
    expect(formatRelativeDate(now, now)).toBe('Today');
  });

  it('formats "Yesterday" for a photo taken on the previous local calendar day', () => {
    // 2pm yesterday vs 9am today → calendar-day delta = 1 → "Yesterday"
    // (NOT "1 day ago", which would be wrong — that bucket is reserved for the
    // 2-6 day range, and the boundary is calendar-day not 24h.)
    const now = new Date(2026, 4, 4, 9, 0, 0).getTime();
    const yesterday2pm = new Date(2026, 4, 3, 14, 0, 0).getTime();
    expect(formatRelativeDate(yesterday2pm, now)).toBe('Yesterday');
  });

  it('formats "3 days ago" for 3 calendar days back', () => {
    const now = new Date(2026, 4, 4, 12, 0, 0).getTime();
    const threeDaysAgo = new Date(2026, 4, 1, 12, 0, 0).getTime();
    expect(formatRelativeDate(threeDaysAgo, now)).toBe('3 days ago');
  });

  it('formats "1 week ago" for 7-13 calendar days back', () => {
    const now = new Date(2026, 4, 14, 12, 0, 0).getTime();
    expect(formatRelativeDate(new Date(2026, 4, 7, 12, 0, 0).getTime(), now)).toBe('1 week ago');
    expect(formatRelativeDate(new Date(2026, 4, 1, 12, 0, 0).getTime(), now)).toBe('1 week ago');
  });

  it('formats absolute "May 4" (en-US) for 14+ calendar days back', () => {
    const now = new Date(2026, 5, 1, 12, 0, 0).getTime(); // Jun 1
    const may4 = new Date(2026, 4, 4, 12, 0, 0).getTime(); // May 4 (28 days)
    // toLocaleDateString output depends on the runtime's default locale; we
    // assert the structure (a 3-letter month + day) rather than locking to
    // en-US, which would fail under non-en-US Intl defaults.
    const out = formatRelativeDate(may4, now);
    expect(out).toMatch(/^[A-Za-z]{3,}\.?\s?\d{1,2}$|^\d{1,2}\s?[A-Za-z]{3,}\.?$|^\d{1,2}\/\d{1,2}$/);
    expect(out).not.toMatch(/Today|Yesterday|days ago|week/);
  });

  it('clamps future timestamps (clock skew / bad EXIF) to "Today"', () => {
    const now = new Date(2026, 4, 4, 9, 0, 0).getTime();
    const futureToday = new Date(2026, 4, 4, 23, 0, 0).getTime();
    const tomorrow = new Date(2026, 4, 5, 9, 0, 0).getTime();
    expect(formatRelativeDate(futureToday, now)).toBe('Today');
    expect(formatRelativeDate(tomorrow, now)).toBe('Today');
  });

  it('fires onPhotoPress with the correct PhotoEntry on tap', () => {
    const now = new Date(2026, 4, 4, 12, 0, 0).getTime();
    const target = makePhoto({ id: 'tap-me', takenAtMs: now });
    const onPress = jest.fn();
    const { getByTestId } = render(
      <PhotoTimeline photos={[target]} nowMs={now} onPhotoPress={onPress} testID="timeline" />,
    );
    fireEvent.press(getByTestId('timeline-tile-tap-me'));
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(onPress).toHaveBeenCalledWith(target);
  });

  it('uses the dark theme textMuted token for the caption when Midnight is active', () => {
    mockedUseTheme.mockReturnValue(darkTheme);
    const now = new Date(2026, 4, 4, 12, 0, 0).getTime();
    const photos = [makePhoto({ id: 'p', takenAtMs: now })];
    const { getByText } = render(
      <PhotoTimeline photos={photos} nowMs={now} testID="timeline" />,
    );
    const caption = getByText('Today');
    expect(flatten(caption.props.style).color).toBe(darkTheme.colors.textMuted);
    expect(flatten(caption.props.style).fontSize).toBe(11);
  });

  it('survives DST/clock-skew: 36h gap that spans 2 local calendar days still labels "2 days ago"', () => {
    // The watering-engine regression contract (E4-002) demands calendar-day
    // math, not ms-per-day math. Construct a fixture in *local time* where the
    // wall-clock ms diff is < 2 days (1.5 days = 36h) but the calendar-day
    // delta is 2. Naive `floor((now - then) / 86_400_000)` would yield 1 →
    // "Yesterday" (wrong). Local-Y/M/D walk yields 2 → "2 days ago" (correct).
    // This fixture is TZ-independent because it uses local-time constructors
    // on both sides.
    const now = new Date(2025, 10, 4, 8, 0, 0).getTime(); // Nov 4 8am local
    const thirtySixHoursBack = new Date(2025, 10, 2, 20, 0, 0).getTime(); // Nov 2 8pm local
    expect((now - thirtySixHoursBack) / ONE_DAY_MS).toBeLessThan(2);
    expect(formatRelativeDate(thirtySixHoursBack, now)).toBe('2 days ago');
  });

  it('falls back to "Photo from {date}" accessibilityLabel when none is provided per-photo', () => {
    const now = new Date(2026, 4, 4, 12, 0, 0).getTime();
    const photo = makePhoto({ id: 'a', takenAtMs: now - ONE_DAY_MS });
    const onPress = jest.fn();
    const { getByTestId } = render(
      <PhotoTimeline
        photos={[photo]}
        nowMs={now}
        onPhotoPress={onPress}
        testID="timeline"
      />,
    );
    const tile = getByTestId('timeline-tile-a');
    expect(tile.props.accessibilityLabel).toBe('Photo from Yesterday');
  });

  it('uses the per-photo accessibilityLabel when provided (overrides relative-date label)', () => {
    const now = new Date(2026, 4, 4, 12, 0, 0).getTime();
    const photo = makePhoto({
      id: 'a',
      takenAtMs: now,
      accessibilityLabel: 'Photo of Mona the Monstera, taken Today',
    });
    const onPress = jest.fn();
    const { getByTestId } = render(
      <PhotoTimeline
        photos={[photo]}
        nowMs={now}
        onPhotoPress={onPress}
        testID="timeline"
      />,
    );
    const tile = getByTestId('timeline-tile-a');
    expect(tile.props.accessibilityLabel).toBe('Photo of Mona the Monstera, taken Today');
  });
});
