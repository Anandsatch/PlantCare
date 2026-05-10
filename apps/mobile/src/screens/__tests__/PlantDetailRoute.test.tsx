/**
 * PlantDetailRoute tests (E4-007).
 *
 * The wrapper's whole job is to read `isFeatureEnabled('addNote')` and
 * thread it into `<PlantDetailScreen>` as `noteEnabled`. These tests pin
 * three slices of that contract:
 *   (a) flag default `false` → button NOT in the tree (E4-007 dead-UI rule)
 *   (b) flag flipped to `true` → wrapper threads `noteEnabled=true` and the
 *       button IS in the tree (E8-004 un-hide path, simulated via mock)
 *   (c) wrapper forwards the rest of the props unchanged (no accidental
 *       prop munging at the seam)
 *
 * Mocks: `useTheme`, `useReduceMotion`, `useWateringEngine`, and
 * `useMarkWatered` follow the same convention as `PlantDetailScreen.test.tsx`
 * — UI integration test, not a SQLite test. The flag module itself is
 * mocked per-test so we can exercise both flag values without touching
 * the constant.
 */
import { lightTheme } from '@plantcare/theme';
import { fireEvent, render } from '@testing-library/react-native';

import * as featureFlags from '../../lib/featureFlags';
import { useMarkWatered, type MarkWateredResult } from '../../hooks/useMarkWatered';
import { useReduceMotion } from '../../hooks/useReduceMotion';
import { useTheme } from '../../hooks/useTheme';
import { useWateringEngine } from '../../hooks/useWateringEngine';
import type { WateringStatus } from '../../watering';
import type { Plant } from '../../db/types';

import { PlantDetailRoute } from '../PlantDetailRoute';

jest.mock('../../hooks/useTheme', () => ({ useTheme: jest.fn() }));
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

function makeMarkWateredMock(): ReturnType<typeof useMarkWatered> {
  const result: MarkWateredResult = {
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
    status: 'idle',
    error: null,
  };
}

const NOW = new Date(2026, 4, 6, 14, 0, 0).getTime();
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

describe('PlantDetailRoute', () => {
  let isFeatureEnabledSpy: jest.SpyInstance<boolean, [featureFlags.FeatureFlagKey]>;

  beforeEach(() => {
    mockedUseTheme.mockReturnValue(lightTheme);
    mockedEngine.mockReturnValue('water');
    mockedReduceMotion.mockReturnValue(false);
    mockedUseMarkWatered.mockReturnValue(makeMarkWateredMock());
    isFeatureEnabledSpy = jest.spyOn(featureFlags, 'isFeatureEnabled');
  });

  afterEach(() => {
    isFeatureEnabledSpy.mockRestore();
    mockedUseTheme.mockReset();
    mockedEngine.mockReset();
    mockedReduceMotion.mockReset();
    mockedUseMarkWatered.mockReset();
  });

  it('reads the addNote flag exactly once per render (single source of truth)', () => {
    isFeatureEnabledSpy.mockReturnValue(false);
    render(
      <PlantDetailRoute
        plant={makePlant()}
        heroPhotoUri={null}
        wateringEvents={[]}
        photos={[]}
        onMarkWatered={jest.fn()}
        onEditDetails={jest.fn()}
        nowMs={NOW}
        testID="route"
      />,
    );
    // The wrapper reads the flag itself; the screen does not. If a future
    // refactor accidentally double-reads (e.g. the screen also calls
    // isFeatureEnabled), this assertion trips and forces a decision about
    // which layer owns the read.
    expect(isFeatureEnabledSpy).toHaveBeenCalledTimes(1);
    expect(isFeatureEnabledSpy).toHaveBeenCalledWith('addNote');
  });

  it('flag default is false → Add note button is NOT rendered (E4-007 dead-UI rule)', () => {
    // Real flag value path: don't mock the read, exercise the constant.
    isFeatureEnabledSpy.mockRestore();
    const { queryByTestId, queryByLabelText } = render(
      <PlantDetailRoute
        plant={makePlant()}
        heroPhotoUri={null}
        wateringEvents={[]}
        photos={[]}
        onMarkWatered={jest.fn()}
        onEditDetails={jest.fn()}
        nowMs={NOW}
        testID="route"
      />,
    );
    // E4-007 contract: "do not render dead UI" — the button is not in the
    // tree at all (not just visually hidden). Mirrors the assertion in
    // PlantDetailScreen.test.tsx so the route layer is held to the same
    // standard.
    expect(queryByTestId('route-add-note')).toBeNull();
    expect(queryByLabelText('Add note')).toBeNull();
  });

  it('flag flipped to true → wrapper threads noteEnabled=true and Add note button IS rendered (E8-004 path)', () => {
    isFeatureEnabledSpy.mockReturnValue(true);
    const onAddNote = jest.fn();
    const { getByTestId, getByLabelText } = render(
      <PlantDetailRoute
        plant={makePlant()}
        heroPhotoUri={null}
        wateringEvents={[]}
        photos={[]}
        onMarkWatered={jest.fn()}
        onEditDetails={jest.fn()}
        onAddNote={onAddNote}
        nowMs={NOW}
        testID="route"
      />,
    );
    // The button is in the tree, has its a11y label, and the press wires
    // through to the parent-supplied callback. Locks the E8-004 contract:
    // flip the flag + thread onAddNote at the parent → button works.
    expect(getByTestId('route-add-note')).toBeOnTheScreen();
    expect(getByLabelText('Add note')).toBeOnTheScreen();
    fireEvent.press(getByTestId('route-add-note'));
    expect(onAddNote).toHaveBeenCalledTimes(1);
  });

  it('forwards all non-flag props unchanged (no accidental prop munging at the seam)', () => {
    // Lock the prop-forwarding contract: testID, plant identity, callbacks
    // all flow through to the wrapped screen. This is the test that catches
    // a future edit that accidentally drops or rewrites a prop while
    // adding the flag.
    isFeatureEnabledSpy.mockReturnValue(false);
    const onMarkWatered = jest.fn();
    const onEditDetails = jest.fn();
    const { getByTestId } = render(
      <PlantDetailRoute
        plant={makePlant({ nickname: 'Steve' })}
        heroPhotoUri="file:///photos/steve.jpg"
        wateringEvents={[{ wateredAtMs: NOW - 2 * ONE_DAY_MS }]}
        photos={[]}
        onMarkWatered={onMarkWatered}
        onEditDetails={onEditDetails}
        nowMs={NOW}
        testID="route"
      />,
    );
    // Header carries the forwarded plant + nowMs through the formatting
    // pipeline.
    expect(getByTestId('route-header').props.accessibilityLabel).toContain(
      'Steve',
    );
    expect(getByTestId('route-header').props.accessibilityLabel).toContain(
      '2 days ago',
    );
    // Edit-details callback fires on press.
    fireEvent.press(getByTestId('route-edit-details'));
    expect(onEditDetails).toHaveBeenCalledTimes(1);
  });
});
