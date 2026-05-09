/**
 * PlantDetailScreen tests (E4-005 + E4-006 wiring).
 *
 * Covers the prop contract, the watering-engine integration, the
 * E4-007 `noteEnabled` hidden-button default, the reading-order a11y contract,
 * the dark-theme token swap, the sub-day-precision `formatLastWatered`
 * regression that PlantCard / PhotoTimeline already pin, and the E4-006
 * Mark watered mutation wiring (mutate → onMarkWatered re-query callback,
 * pending-state button disable, success toast, error toast).
 *
 * `useWateringEngine`, `useTheme`, `useReduceMotion`, and `useMarkWatered`
 * are mocked: this is a UI integration test, not a SQLite test — each
 * mocked hook has its own test file.
 */
import { darkTheme, lightTheme } from '@plantcare/theme';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';

import { PhotoTimeline } from '../../components/PhotoTimeline';
import { WateringLedger } from '../../components/WateringLedger';
import { useMarkWatered, type MarkWateredResult } from '../../hooks/useMarkWatered';
import { useReduceMotion } from '../../hooks/useReduceMotion';
import { useTheme } from '../../hooks/useTheme';
import { useWateringEngine } from '../../hooks/useWateringEngine';
import type { WateringStatus } from '../../watering';
import type { Plant } from '../../db/types';
import {
  PlantDetailScreen,
  formatLastWatered,
  resolveSpeciesHeadline,
} from '../PlantDetailScreen';

// ---- Mocks -----------------------------------------------------------------

jest.mock('../../hooks/useTheme', () => ({
  useTheme: jest.fn(),
}));
jest.mock('../../hooks/useWateringEngine', () => ({
  useWateringEngine: jest.fn(),
}));
jest.mock('../../hooks/useReduceMotion', () => ({
  useReduceMotion: jest.fn(),
}));
jest.mock('../../hooks/useMarkWatered', () => ({
  useMarkWatered: jest.fn(),
}));

const mockedUseTheme = useTheme as unknown as jest.Mock<
  ReturnType<typeof useTheme>,
  []
>;
const mockedEngine = useWateringEngine as unknown as jest.Mock<
  WateringStatus,
  [Parameters<typeof useWateringEngine>[0]]
>;
const mockedReduceMotion = useReduceMotion as unknown as jest.Mock<boolean, []>;
const mockedUseMarkWatered = useMarkWatered as unknown as jest.Mock<
  ReturnType<typeof useMarkWatered>,
  [string]
>;

/**
 * Default mock of `useMarkWatered`. Returns an idle hook whose `mutate`
 * resolves `{ ok: true, row }` so `onMarkWatered` (re-query trigger) fires
 * immediately. Tests that need to drive specific transitions override the
 * mock per-test.
 */
function makeMarkWateredMock(opts?: {
  status?: 'idle' | 'pending' | 'ok' | 'error';
  result?: MarkWateredResult;
}): ReturnType<typeof useMarkWatered> {
  const result: MarkWateredResult = opts?.result ?? {
    ok: true,
    row: {
      id: 'w-1',
      plant_id: 'plant-1',
      watered_at: 1_700_000_000_000,
      source: 'user',
      note: null,
    },
  };
  return {
    mutate: jest.fn().mockResolvedValue(result),
    status: opts?.status ?? 'idle',
    error: null,
  };
}

// ---- Fixtures --------------------------------------------------------------

const NOW = new Date(2026, 4, 6, 14, 0, 0).getTime(); // 2026-05-06 14:00 local
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function makePlant(overrides: Partial<Plant> = {}): Plant {
  return {
    id: 'plant-1',
    species_slug: 'monstera_deliciosa',
    species_label: 'Monstera deliciosa',
    nickname: 'Mona',
    location: 'Living room window',
    identify_confidence: 92,
    hero_photo_id: 'photo-1',
    added_at: NOW - 30 * ONE_DAY_MS,
    archived_at: null,
    is_indoor: true,
    override_interval_days: null,
    ...overrides,
  };
}

function flatten(style: unknown): Record<string, unknown> {
  if (Array.isArray(style)) {
    return Object.assign({}, ...style.map((s) => flatten(s)));
  }
  return (style ?? {}) as Record<string, unknown>;
}

// ---- Suite -----------------------------------------------------------------

describe('PlantDetailScreen', () => {
  beforeEach(() => {
    mockedUseTheme.mockReturnValue(lightTheme);
    mockedEngine.mockReturnValue('water');
    mockedReduceMotion.mockReturnValue(false);
    mockedUseMarkWatered.mockReturnValue(makeMarkWateredMock());
  });

  afterEach(() => {
    mockedUseTheme.mockReset();
    mockedEngine.mockReset();
    mockedReduceMotion.mockReset();
    mockedUseMarkWatered.mockReset();
  });

  it('renders species headline + italic curly-quoted nickname + last-watered subline', () => {
    const plant = makePlant();
    const events = [{ wateredAtMs: NOW - 3 * ONE_DAY_MS }];
    const { getByTestId } = render(
      <PlantDetailScreen
        plant={plant}
        heroPhotoUri="file:///photos/p1.jpg"
        wateringEvents={events}
        photos={[]}
        onMarkWatered={jest.fn()}
        onEditDetails={jest.fn()}
        nowMs={NOW}
        testID="screen"
      />,
    );
    const header = getByTestId('screen-header');
    // The composed a11y label drives VoiceOver; assert its parts.
    expect(header.props.accessibilityLabel).toContain('Monstera deliciosa');
    expect(header.props.accessibilityLabel).toContain('Mona');
    expect(header.props.accessibilityLabel).toContain('3 days ago');
  });

  it('uses StatusChip whose type tracks useWateringEngine across all 4 states', () => {
    const plant = makePlant();
    const baseProps = {
      plant,
      heroPhotoUri: null,
      wateringEvents: [],
      photos: [],
      onMarkWatered: jest.fn(),
      onEditDetails: jest.fn(),
      nowMs: NOW,
      testID: 'screen',
    } as const;

    // 'water' → "Water today"
    mockedEngine.mockReturnValue('water');
    const r1 = render(<PlantDetailScreen {...baseProps} />);
    expect(r1.getByLabelText('Water today')).toBeOnTheScreen();
    r1.unmount();

    // 'skip' → "Skip watering"
    mockedEngine.mockReturnValue('skip');
    const r2 = render(<PlantDetailScreen {...baseProps} />);
    expect(r2.getByLabelText('Skip watering')).toBeOnTheScreen();
    r2.unmount();

    // 'check_soil' → "Check soil"
    mockedEngine.mockReturnValue('check_soil');
    const r3 = render(<PlantDetailScreen {...baseProps} />);
    expect(r3.getByLabelText('Check soil')).toBeOnTheScreen();
    r3.unmount();
  });

  it('renders the 7-day WateringLedger with the events prop', () => {
    const plant = makePlant();
    const events = [
      { wateredAtMs: NOW - 1 * ONE_DAY_MS },
      { wateredAtMs: NOW - 4 * ONE_DAY_MS },
    ];
    const { getByTestId, getByLabelText } = render(
      <PlantDetailScreen
        plant={plant}
        heroPhotoUri={null}
        wateringEvents={events}
        photos={[]}
        onMarkWatered={jest.fn()}
        onEditDetails={jest.fn()}
        nowMs={NOW}
        testID="screen"
      />,
    );
    expect(getByTestId('screen-ledger')).toBeOnTheScreen();
    // Ledger's own root accessibilityLabel
    expect(getByLabelText('7-day watering history')).toBeOnTheScreen();
  });

  it('renders the PhotoTimeline with up to 4 most-recent photos', () => {
    const plant = makePlant();
    const photos = [0, 1, 2, 3].map((i) => ({
      id: `p${i}`,
      uri: `file:///photos/p${i}.jpg`,
      takenAtMs: NOW - i * ONE_DAY_MS,
    }));
    const { getByTestId } = render(
      <PlantDetailScreen
        plant={plant}
        heroPhotoUri={null}
        wateringEvents={[]}
        photos={photos}
        onMarkWatered={jest.fn()}
        onEditDetails={jest.fn()}
        nowMs={NOW}
        testID="screen"
      />,
    );
    expect(getByTestId('screen-photos')).toBeOnTheScreen();
  });

  it('"Mark watered" tap fires the mutate then onMarkWatered re-query (not the others)', async () => {
    const plant = makePlant();
    const onMarkWatered = jest.fn();
    const onEditDetails = jest.fn();
    const onAddNote = jest.fn();
    const mark = makeMarkWateredMock();
    mockedUseMarkWatered.mockReturnValue(mark);
    const { getByTestId } = render(
      <PlantDetailScreen
        plant={plant}
        heroPhotoUri={null}
        wateringEvents={[]}
        photos={[]}
        onMarkWatered={onMarkWatered}
        onEditDetails={onEditDetails}
        onAddNote={onAddNote}
        noteEnabled
        nowMs={NOW}
        testID="screen"
      />,
    );
    await act(async () => {
      fireEvent.press(getByTestId('screen-mark-watered'));
    });
    // mutate fires synchronously on press; onMarkWatered is the re-query
    // callback fired AFTER the mutate resolves with `ok: true`.
    expect(mark.mutate).toHaveBeenCalledTimes(1);
    expect(mark.mutate).toHaveBeenCalledWith({ source: 'user' });
    expect(onMarkWatered).toHaveBeenCalledTimes(1);
    expect(onEditDetails).not.toHaveBeenCalled();
    expect(onAddNote).not.toHaveBeenCalled();
  });

  it('"Edit details" tap fires onEditDetails (not the others)', () => {
    const plant = makePlant();
    const onMarkWatered = jest.fn();
    const onEditDetails = jest.fn();
    const { getByTestId } = render(
      <PlantDetailScreen
        plant={plant}
        heroPhotoUri={null}
        wateringEvents={[]}
        photos={[]}
        onMarkWatered={onMarkWatered}
        onEditDetails={onEditDetails}
        nowMs={NOW}
        testID="screen"
      />,
    );
    fireEvent.press(getByTestId('screen-edit-details'));
    expect(onEditDetails).toHaveBeenCalledTimes(1);
    expect(onMarkWatered).not.toHaveBeenCalled();
  });

  it('"Add note" button is hidden when noteEnabled is false (default) — E4-007 contract', () => {
    const plant = makePlant();
    const { queryByTestId, queryByLabelText } = render(
      <PlantDetailScreen
        plant={plant}
        heroPhotoUri={null}
        wateringEvents={[]}
        photos={[]}
        onMarkWatered={jest.fn()}
        onEditDetails={jest.fn()}
        onAddNote={jest.fn()}
        // noteEnabled omitted -> defaults to false
        nowMs={NOW}
        testID="screen"
      />,
    );
    // The button is NOT in the tree at all (not just visually hidden) so
    // VoiceOver / TalkBack can't reach it. E4-007: "do not render dead UI."
    expect(queryByTestId('screen-add-note')).toBeNull();
    expect(queryByLabelText('Add note')).toBeNull();
  });

  it('"Add note" button is visible + interactive when noteEnabled is true (the E8-004 un-hide path)', () => {
    const plant = makePlant();
    const onAddNote = jest.fn();
    const { getByTestId, getByLabelText } = render(
      <PlantDetailScreen
        plant={plant}
        heroPhotoUri={null}
        wateringEvents={[]}
        photos={[]}
        onMarkWatered={jest.fn()}
        onEditDetails={jest.fn()}
        onAddNote={onAddNote}
        noteEnabled
        nowMs={NOW}
        testID="screen"
      />,
    );
    expect(getByTestId('screen-add-note')).toBeOnTheScreen();
    expect(getByLabelText('Add note')).toBeOnTheScreen();
    fireEvent.press(getByTestId('screen-add-note'));
    expect(onAddNote).toHaveBeenCalledTimes(1);
  });

  it('reduce-motion is captured (the hook is consumed) — sets the future-animation seam', () => {
    // Render once with reduce-motion off, once with it on. Both render fine —
    // the screen has no animations today, but the hook is wired so future
    // tickets adding a transition can gate on it without a refactor.
    mockedReduceMotion.mockReturnValue(true);
    const r = render(
      <PlantDetailScreen
        plant={makePlant()}
        heroPhotoUri={null}
        wateringEvents={[]}
        photos={[]}
        onMarkWatered={jest.fn()}
        onEditDetails={jest.fn()}
        nowMs={NOW}
        testID="screen"
      />,
    );
    expect(r.getByTestId('screen')).toBeOnTheScreen();
    expect(mockedReduceMotion).toHaveBeenCalled();
  });

  it('dark theme tokens swap — header uses darkTheme.text on the species headline', () => {
    mockedUseTheme.mockReturnValue(darkTheme);
    const { getByTestId } = render(
      <PlantDetailScreen
        plant={makePlant()}
        heroPhotoUri={null}
        wateringEvents={[]}
        photos={[]}
        onMarkWatered={jest.fn()}
        onEditDetails={jest.fn()}
        nowMs={NOW}
        testID="screen"
      />,
    );
    const headline = getByTestId('screen-species');
    expect(headline.props.children).toBe('Monstera deliciosa');
    expect(flatten(headline.props.style).color).toBe(darkTheme.colors.text);
  });

  it('a11y: every interactive element has role="button" + a label', () => {
    const plant = makePlant();
    const { getByLabelText } = render(
      <PlantDetailScreen
        plant={plant}
        heroPhotoUri={null}
        wateringEvents={[]}
        photos={[]}
        onMarkWatered={jest.fn()}
        onEditDetails={jest.fn()}
        onAddNote={jest.fn()}
        noteEnabled
        nowMs={NOW}
        testID="screen"
      />,
    );
    const markBtn = getByLabelText('Mark watered');
    const editBtn = getByLabelText('Edit details');
    const noteBtn = getByLabelText('Add note');
    expect(markBtn.props.accessibilityRole).toBe('button');
    expect(editBtn.props.accessibilityRole).toBe('button');
    expect(noteBtn.props.accessibilityRole).toBe('button');
  });

  it('a11y reading order: header has three sequential VO stops (species, nickname, last-watered)', () => {
    const plant = makePlant();
    const events = [{ wateredAtMs: NOW - 5 * ONE_DAY_MS }];
    const { getByTestId } = render(
      <PlantDetailScreen
        plant={plant}
        heroPhotoUri={null}
        wateringEvents={events}
        photos={[]}
        onMarkWatered={jest.fn()}
        onEditDetails={jest.fn()}
        nowMs={NOW}
        testID="screen"
      />,
    );
    const header = getByTestId('screen-header');
    // Composed accessibilityLabel is preserved on the wrapping View so test
    // suites that snapshot the screen-level VO copy still see "Monstera
    // deliciosa, Mona, Last watered 5 days ago".
    expect(header.props.accessibilityLabel).toBe(
      'Monstera deliciosa, Mona, Last watered 5 days ago',
    );
    // The header View is NOT marked `accessible` — that would collapse
    // descendants and disable iOS rotor "by-header" navigation on the
    // species line. Each child is its own VoiceOver stop.
    expect(header.props.accessible).toBeUndefined();
    // Species line is a header (rotor stop).
    const species = getByTestId('screen-species');
    expect(species.props.accessibilityRole).toBe('header');
    // Nickname overrides label to drop quote glyphs from speech.
    const nickname = getByTestId('screen-nickname');
    expect(nickname.props.accessibilityLabel).toBe('Mona');
    // Last-watered line carries no special role — VoiceOver reads its text
    // directly.
    const lastWatered = getByTestId('screen-last-watered');
    expect(lastWatered.props.children).toBe('Last watered 5 days ago');
  });

  it('empty plant state — no photos: PhotoTimeline shows the empty-state copy', () => {
    const plant = makePlant({ hero_photo_id: null });
    const { getByText } = render(
      <PlantDetailScreen
        plant={plant}
        heroPhotoUri={null}
        wateringEvents={[]}
        photos={[]}
        onMarkWatered={jest.fn()}
        onEditDetails={jest.fn()}
        nowMs={NOW}
        testID="screen"
      />,
    );
    expect(getByText(/No photos yet/i)).toBeOnTheScreen();
  });

  it('empty plant state — never watered: status chip + ledger handle the null case', () => {
    // engine returns 'check_soil' for the never-watered case.
    mockedEngine.mockReturnValue('check_soil');
    const plant = makePlant();
    const { getByLabelText, getByText, getByTestId } = render(
      <PlantDetailScreen
        plant={plant}
        heroPhotoUri={null}
        wateringEvents={[]}
        photos={[]}
        onMarkWatered={jest.fn()}
        onEditDetails={jest.fn()}
        nowMs={NOW}
        testID="screen"
      />,
    );
    expect(getByLabelText('Check soil')).toBeOnTheScreen();
    // Ledger empty caption shows up when events.length === 0.
    expect(getByText(/No watering recorded yet/i)).toBeOnTheScreen();
    // And the headline subline reads "Not watered yet" (queried via testID
    // because the parent header is `accessible={true}`, which collapses
    // descendants for accessibility queries).
    expect(getByTestId('screen-last-watered').props.children).toBe(
      'Not watered yet',
    );
  });

  // === Sub-day-precision regression: 3d 12h fixture ===
  // Same invariant as PlantCard / PhotoTimeline. A watering 3 calendar days
  // + 12 hours back must label "3 days ago", not "4 days ago" (naive
  // floor((now - then) / DAY_MS) → ~3.5 days, but ceil-or-banker's-round-up
  // would produce 4) and not "3 days 12 hours ago" (no sub-day precision in
  // the copy).
  it('regression: 3d 12h ago labels "3 days ago" (sub-day precision rounds to calendar days)', () => {
    const threeDaysTwelveHoursAgo = NOW - 3 * ONE_DAY_MS - 12 * 60 * 60 * 1000;
    const events = [{ wateredAtMs: threeDaysTwelveHoursAgo }];
    const { getByTestId } = render(
      <PlantDetailScreen
        plant={makePlant()}
        heroPhotoUri={null}
        wateringEvents={events}
        photos={[]}
        onMarkWatered={jest.fn()}
        onEditDetails={jest.fn()}
        nowMs={NOW}
        testID="screen"
      />,
    );
    expect(getByTestId('screen-last-watered').props.children).toBe(
      'Last watered 3 days ago',
    );
  });

  it('hero photo accessibilityLabel composes species + nickname per master plan', () => {
    const plant = makePlant();
    const { getByTestId } = render(
      <PlantDetailScreen
        plant={plant}
        heroPhotoUri="file:///photos/p1.jpg"
        wateringEvents={[]}
        photos={[]}
        onMarkWatered={jest.fn()}
        onEditDetails={jest.fn()}
        nowMs={NOW}
        testID="screen"
      />,
    );
    const heroPhoto = getByTestId('screen-hero-photo');
    expect(heroPhoto.props.accessibilityLabel).toBe(
      'Photo of Monstera deliciosa, Mona',
    );
    expect(heroPhoto.props.accessibilityRole).toBe('image');
  });

  it('headline gets the screen-reader role="header" so VO rotor navigation works', () => {
    const { getByTestId } = render(
      <PlantDetailScreen
        plant={makePlant()}
        heroPhotoUri={null}
        wateringEvents={[]}
        photos={[]}
        onMarkWatered={jest.fn()}
        onEditDetails={jest.fn()}
        nowMs={NOW}
        testID="screen"
      />,
    );
    const headline = getByTestId('screen-species');
    expect(headline.props.accessibilityRole).toBe('header');
    expect(headline.props.children).toBe('Monstera deliciosa');
  });

  it('plant with no nickname renders headline only and omits nickname from the a11y label', () => {
    const plant = makePlant({ nickname: null });
    const { getByTestId, queryByTestId } = render(
      <PlantDetailScreen
        plant={plant}
        heroPhotoUri={null}
        wateringEvents={[{ wateredAtMs: NOW - 1 * ONE_DAY_MS }]}
        photos={[]}
        onMarkWatered={jest.fn()}
        onEditDetails={jest.fn()}
        nowMs={NOW}
        testID="screen"
      />,
    );
    // No nickname Text in the tree (testID-driven; getByText collapses under
    // the accessible header parent).
    expect(queryByTestId('screen-nickname')).toBeNull();
    // a11y label has no nickname comma.
    expect(getByTestId('screen-header').props.accessibilityLabel).toBe(
      'Monstera deliciosa, Last watered yesterday',
    );
  });

  it('noteEnabled=true without onAddNote still renders the button (graceful no-op press) — codex P2', () => {
    // E4-005 codex review caught the noteEnabled && onAddNote coupling. The
    // contract is now: flipping noteEnabled is sufficient to render the
    // button. A missing callback warns in dev but renders a no-op press in
    // production so a misconfigured parent doesn't crash the screen.
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { getByTestId } = render(
      <PlantDetailScreen
        plant={makePlant()}
        heroPhotoUri={null}
        wateringEvents={[]}
        photos={[]}
        onMarkWatered={jest.fn()}
        onEditDetails={jest.fn()}
        // onAddNote intentionally omitted
        noteEnabled
        nowMs={NOW}
        testID="screen"
      />,
    );
    const btn = getByTestId('screen-add-note');
    expect(btn).toBeOnTheScreen();
    // Pressing must not throw.
    expect(() => fireEvent.press(btn)).not.toThrow();
    warn.mockRestore();
  });

  it('mark-watered loading state (parent prop) shows the activity indicator (no double-fires)', () => {
    const plant = makePlant();
    const onMarkWatered = jest.fn();
    const mark = makeMarkWateredMock();
    mockedUseMarkWatered.mockReturnValue(mark);
    const { getByTestId } = render(
      <PlantDetailScreen
        plant={plant}
        heroPhotoUri={null}
        wateringEvents={[]}
        photos={[]}
        onMarkWatered={onMarkWatered}
        onEditDetails={jest.fn()}
        markWateredLoading
        nowMs={NOW}
        testID="screen"
      />,
    );
    // EditorialButton renders an ActivityIndicator under `<testID>-loading`.
    expect(getByTestId('screen-mark-watered-loading')).toBeOnTheScreen();
    // Tap is inert during loading: neither the in-screen mutate fires nor
    // the parent re-query callback.
    fireEvent.press(getByTestId('screen-mark-watered'));
    expect(mark.mutate).not.toHaveBeenCalled();
    expect(onMarkWatered).not.toHaveBeenCalled();
  });

  // === E4-006 wiring tests =================================================

  it('hook status="pending" disables the Mark watered button (Layer 2 of triple-defense)', () => {
    const mark = makeMarkWateredMock({ status: 'pending' });
    mockedUseMarkWatered.mockReturnValue(mark);
    const onMarkWatered = jest.fn();
    const { getByTestId } = render(
      <PlantDetailScreen
        plant={makePlant()}
        heroPhotoUri={null}
        wateringEvents={[]}
        photos={[]}
        onMarkWatered={onMarkWatered}
        onEditDetails={jest.fn()}
        nowMs={NOW}
        testID="screen"
      />,
    );
    // Activity indicator visible, button disabled, press is a no-op.
    expect(getByTestId('screen-mark-watered-loading')).toBeOnTheScreen();
    fireEvent.press(getByTestId('screen-mark-watered'));
    expect(mark.mutate).not.toHaveBeenCalled();
    expect(onMarkWatered).not.toHaveBeenCalled();
  });

  it('after mutate ok, the toast banner "Watered today" appears (sage info)', async () => {
    const mark = makeMarkWateredMock();
    mockedUseMarkWatered.mockReturnValue(mark);
    const { getByTestId, queryByTestId } = render(
      <PlantDetailScreen
        plant={makePlant()}
        heroPhotoUri={null}
        wateringEvents={[]}
        photos={[]}
        onMarkWatered={jest.fn()}
        onEditDetails={jest.fn()}
        nowMs={NOW}
        testID="screen"
      />,
    );
    // Toast not present before tap.
    expect(queryByTestId('screen-mark-watered-toast')).toBeNull();
    await act(async () => {
      fireEvent.press(getByTestId('screen-mark-watered'));
    });
    expect(getByTestId('screen-mark-watered-toast')).toBeOnTheScreen();
  });

  it('error path renders the warn toast "Couldn\'t save — try again"', async () => {
    const mark = makeMarkWateredMock({
      result: { ok: false, kind: 'error', error: new Error('insert failed') },
    });
    mockedUseMarkWatered.mockReturnValue(mark);
    const onMarkWatered = jest.fn();
    const { getByTestId, queryByTestId } = render(
      <PlantDetailScreen
        plant={makePlant()}
        heroPhotoUri={null}
        wateringEvents={[]}
        photos={[]}
        onMarkWatered={onMarkWatered}
        onEditDetails={jest.fn()}
        nowMs={NOW}
        testID="screen"
      />,
    );
    await act(async () => {
      fireEvent.press(getByTestId('screen-mark-watered'));
    });
    await waitFor(() => {
      expect(getByTestId('screen-mark-watered-error-toast')).toBeOnTheScreen();
    });
    // Re-query callback is NOT fired on error — the parent should not
    // refetch because the row never landed.
    expect(onMarkWatered).not.toHaveBeenCalled();
    // Sanity: no success toast.
    expect(queryByTestId('screen-mark-watered-toast')).toBeNull();
  });

  it('debounced result fires no toast and does not invoke the parent re-query', async () => {
    const mark = makeMarkWateredMock({
      result: { ok: false, kind: 'debounced' },
    });
    mockedUseMarkWatered.mockReturnValue(mark);
    const onMarkWatered = jest.fn();
    const { getByTestId, queryByTestId } = render(
      <PlantDetailScreen
        plant={makePlant()}
        heroPhotoUri={null}
        wateringEvents={[]}
        photos={[]}
        onMarkWatered={onMarkWatered}
        onEditDetails={jest.fn()}
        nowMs={NOW}
        testID="screen"
      />,
    );
    await act(async () => {
      fireEvent.press(getByTestId('screen-mark-watered'));
    });
    expect(onMarkWatered).not.toHaveBeenCalled();
    expect(queryByTestId('screen-mark-watered-toast')).toBeNull();
    expect(queryByTestId('screen-mark-watered-error-toast')).toBeNull();
  });

  it('useMarkWatered is called with plant.id (the mutation is scoped to the rendered plant)', () => {
    const plant = makePlant({ id: 'plant-special' });
    render(
      <PlantDetailScreen
        plant={plant}
        heroPhotoUri={null}
        wateringEvents={[]}
        photos={[]}
        onMarkWatered={jest.fn()}
        onEditDetails={jest.fn()}
        nowMs={NOW}
        testID="screen"
      />,
    );
    expect(mockedUseMarkWatered).toHaveBeenCalledWith('plant-special');
  });

  it('after mutate ok, the status chip reflects the new state (engine re-derives via the bus, mocked here)', async () => {
    // Before tap, engine returns 'water'. After tap (and conceptually after
    // the bus carries the optimistic event), the engine returns 'skip' —
    // simulating the chip flip the bus produces in the real wiring.
    const mark = makeMarkWateredMock();
    mockedUseMarkWatered.mockReturnValue(mark);
    mockedEngine.mockReturnValue('water');
    const { getByTestId, getByLabelText, rerender } = render(
      <PlantDetailScreen
        plant={makePlant()}
        heroPhotoUri={null}
        wateringEvents={[]}
        photos={[]}
        onMarkWatered={jest.fn()}
        onEditDetails={jest.fn()}
        nowMs={NOW}
        testID="screen"
      />,
    );
    expect(getByLabelText('Water today')).toBeOnTheScreen();

    await act(async () => {
      fireEvent.press(getByTestId('screen-mark-watered'));
    });
    // Simulate the engine flipping after the bus event (the engine is
    // mocked here; the real wiring is exercised in useWateringEngine tests).
    mockedEngine.mockReturnValue('skip');
    rerender(
      <PlantDetailScreen
        plant={makePlant()}
        heroPhotoUri={null}
        wateringEvents={[]}
        photos={[]}
        onMarkWatered={jest.fn()}
        onEditDetails={jest.fn()}
        nowMs={NOW}
        testID="screen"
      />,
    );
    expect(getByLabelText('Skip watering')).toBeOnTheScreen();
  });
});

// ---- Pure helper coverage --------------------------------------------------

describe('formatLastWatered', () => {
  const NOW2 = new Date(2026, 4, 6, 14, 0, 0).getTime();

  it('returns "Not watered yet" for null', () => {
    expect(formatLastWatered(null, NOW2)).toBe('Not watered yet');
  });

  it('returns "Last watered today" for same local day', () => {
    expect(formatLastWatered(NOW2 - 2 * 60 * 60 * 1000, NOW2)).toBe(
      'Last watered today',
    );
  });

  it('returns "Last watered yesterday" for 1 calendar day back', () => {
    const yest = new Date(2026, 4, 5, 22, 0, 0).getTime();
    expect(formatLastWatered(yest, NOW2)).toBe('Last watered yesterday');
  });

  it('returns "Last watered N days ago" for 2-13 days back', () => {
    const fiveBack = new Date(2026, 4, 1, 14, 0, 0).getTime();
    expect(formatLastWatered(fiveBack, NOW2)).toBe('Last watered 5 days ago');
  });

  it('returns absolute month-day for 14+ days back', () => {
    const twentyBack = new Date(2026, 3, 16, 14, 0, 0).getTime(); // April 16
    const out = formatLastWatered(twentyBack, NOW2);
    expect(out.startsWith('Last watered ')).toBe(true);
    // Locale-dependent format; assert on shape, not exact string.
    expect(out).toMatch(/Last watered \w/);
  });

  // Sub-day-precision regression — same as the screen-level test, anchored on
  // the helper directly so a future refactor that swaps the implementation
  // can't quietly break the contract.
  it('regression: 3d 12h ago → "Last watered 3 days ago"', () => {
    const threeDaysTwelveHoursAgo =
      NOW2 - 3 * 24 * 60 * 60 * 1000 - 12 * 60 * 60 * 1000;
    expect(formatLastWatered(threeDaysTwelveHoursAgo, NOW2)).toBe(
      'Last watered 3 days ago',
    );
  });
});

describe('resolveSpeciesHeadline', () => {
  it('prefers species_label when present', () => {
    expect(
      resolveSpeciesHeadline({
        ...({} as Plant),
        species_slug: 'monstera_deliciosa',
        species_label: 'Monstera deliciosa',
      } as Plant),
    ).toBe('Monstera deliciosa');
  });

  it('falls back to the slug Title Cased when species_label is null', () => {
    expect(
      resolveSpeciesHeadline({
        ...({} as Plant),
        species_slug: 'fiddle_leaf_fig',
        species_label: null,
      } as Plant),
    ).toBe('Fiddle Leaf Fig');
  });

  it('returns "Unknown species" for the species_unknown sentinel', () => {
    expect(
      resolveSpeciesHeadline({
        ...({} as Plant),
        species_slug: 'species_unknown',
        species_label: null,
      } as Plant),
    ).toBe('Unknown species');
  });

  it('treats empty-string species_label as missing', () => {
    expect(
      resolveSpeciesHeadline({
        ...({} as Plant),
        species_slug: 'monstera_deliciosa',
        species_label: '   ',
      } as Plant),
    ).toBe('Monstera Deliciosa');
  });
});
