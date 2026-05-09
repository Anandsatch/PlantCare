/**
 * <PlantsListScreen> tests — A-1 home (E3-003).
 *
 * Mocks the data hooks (`usePlants`, `useTheme`, `useReduceMotion`) and
 * `openDb` so the screen renders synchronously against in-memory fixtures.
 * The screen-level batch query (`fetchWateringSummary`) and the pure
 * resolver (`resolvePlantViewModels`) are also exercised directly so the
 * batching contract is asserted independent of the React tree.
 */
import { darkTheme, lightTheme, type Theme } from '@plantcare/theme';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { AppState } from 'react-native';

import type { Plant } from '../../db/types';
import {
  PlantsListScreen,
  __resetRefreshHandlesForTests,
  fetchWateringSummary,
  getMostRecentRefresh,
  resolvePlantViewModels,
  type ScreenDb,
} from '../PlantsListScreen';

// ---- Mocks --------------------------------------------------------------

jest.mock('../../hooks/useTheme', () => ({
  useTheme: jest.fn(),
}));
jest.mock('../../hooks/useReduceMotion', () => ({
  useReduceMotion: jest.fn(),
}));
jest.mock('../../hooks/usePlants', () => ({
  usePlants: jest.fn(),
}));
jest.mock('../../db', () => ({
  openDb: jest.fn(),
}));

import { useTheme } from '../../hooks/useTheme';
import { useReduceMotion } from '../../hooks/useReduceMotion';
import { usePlants } from '../../hooks/usePlants';
import { openDb } from '../../db';

const mockedUseTheme = useTheme as jest.MockedFunction<() => Theme>;
const mockedUseReduceMotion = useReduceMotion as unknown as jest.Mock<boolean, []>;
const mockedUsePlants = usePlants as unknown as jest.Mock;
const mockedOpenDb = openDb as unknown as jest.Mock;

// ---- Fixtures -----------------------------------------------------------

const NOW = 1_700_000_000_000; // 2023-11-14T22:13:20Z — fixed for deterministic copy
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function makePlant(overrides: Partial<Plant> = {}): Plant {
  return {
    id: 'plant-1',
    species_slug: 'monstera_deliciosa',
    species_label: 'Monstera deliciosa',
    nickname: 'Mona',
    location: null,
    identify_confidence: 92,
    hero_photo_id: null,
    added_at: NOW - 30 * ONE_DAY_MS,
    archived_at: null,
    is_indoor: true,
    override_interval_days: null,
    ...overrides,
  };
}

function makeDb(rows: Array<{ plant_id: string; last_watered_at: number }>): ScreenDb {
  return {
    getAllAsync: jest.fn(async () => rows as unknown[]) as ScreenDb['getAllAsync'],
  };
}

function makePlantsApi(plants: Plant[]) {
  return {
    list: jest.fn(async () => plants),
    getById: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    archive: jest.fn(),
    unarchive: jest.fn(),
    remove: jest.fn(),
  };
}

// ---- Setup --------------------------------------------------------------

beforeEach(() => {
  mockedUseTheme.mockReturnValue(lightTheme);
  mockedUseReduceMotion.mockReturnValue(false);
  mockedOpenDb.mockResolvedValue(makeDb([]));
});

afterEach(() => {
  mockedUseTheme.mockReset();
  mockedUseReduceMotion.mockReset();
  mockedUsePlants.mockReset();
  mockedOpenDb.mockReset();
  __resetRefreshHandlesForTests();
  jest.clearAllMocks();
});

// =========================================================================
// Empty state
// =========================================================================

describe('PlantsListScreen — empty state', () => {
  it('0 plants → renders <EmptyGardenWelcome>; no FlatList; no FAB', async () => {
    mockedUsePlants.mockReturnValue(makePlantsApi([]));

    render(
      <PlantsListScreen
        onAddPlant={jest.fn()}
        onPlantPress={jest.fn()}
        nowMs={NOW}
        db={makeDb([])}
      />,
    );

    await waitFor(() =>
      expect(screen.queryByTestId('plants-list-loading')).not.toBeOnTheScreen(),
    );
    expect(screen.getByTestId('plants-list-empty')).toBeOnTheScreen();
    expect(screen.queryByTestId('plants-list-list')).not.toBeOnTheScreen();
    expect(screen.queryByTestId('plants-list-fab')).not.toBeOnTheScreen();
  });

  it('0 plants → EmptyGardenWelcome CTA fires onAddPlant', async () => {
    mockedUsePlants.mockReturnValue(makePlantsApi([]));
    const onAddPlant = jest.fn();

    render(
      <PlantsListScreen
        onAddPlant={onAddPlant}
        onPlantPress={jest.fn()}
        nowMs={NOW}
        db={makeDb([])}
      />,
    );

    await waitFor(() => expect(screen.queryByTestId('empty-garden-cta')).toBeOnTheScreen());
    fireEvent.press(screen.getByTestId('empty-garden-cta'));
    expect(onAddPlant).toHaveBeenCalledTimes(1);
  });
});

// =========================================================================
// Populated state
// =========================================================================

describe('PlantsListScreen — populated state', () => {
  it('1 plant → renders FlatList with 1 PlantCard + FAB', async () => {
    const plant = makePlant();
    mockedUsePlants.mockReturnValue(makePlantsApi([plant]));

    render(
      <PlantsListScreen
        onAddPlant={jest.fn()}
        onPlantPress={jest.fn()}
        nowMs={NOW}
        db={makeDb([{ plant_id: plant.id, last_watered_at: NOW - 3 * ONE_DAY_MS }])}
      />,
    );

    await waitFor(() => expect(screen.queryByTestId('plants-list-list')).toBeOnTheScreen());
    expect(screen.getByTestId(`plant-card-${plant.id}`)).toBeOnTheScreen();
    expect(screen.getByTestId('plants-list-fab')).toBeOnTheScreen();
  });

  it('N plants → renders N PlantCards in usePlants order', async () => {
    const p1 = makePlant({ id: 'a', nickname: 'Alpha' });
    const p2 = makePlant({ id: 'b', nickname: 'Bravo' });
    const p3 = makePlant({ id: 'c', nickname: 'Charlie' });
    mockedUsePlants.mockReturnValue(makePlantsApi([p1, p2, p3]));

    render(
      <PlantsListScreen
        onAddPlant={jest.fn()}
        onPlantPress={jest.fn()}
        nowMs={NOW}
        db={makeDb([])}
      />,
    );

    await waitFor(() => expect(screen.queryByTestId('plant-card-a')).toBeOnTheScreen());
    expect(screen.getByTestId('plant-card-a')).toBeOnTheScreen();
    expect(screen.getByTestId('plant-card-b')).toBeOnTheScreen();
    expect(screen.getByTestId('plant-card-c')).toBeOnTheScreen();
  });

  it('header shows "MY GARDEN — N PLANTS" with the right pluralization', async () => {
    mockedUsePlants.mockReturnValue(makePlantsApi([makePlant({ id: 'a' })]));
    render(
      <PlantsListScreen
        onAddPlant={jest.fn()}
        onPlantPress={jest.fn()}
        nowMs={NOW}
        db={makeDb([])}
      />,
    );
    await waitFor(() =>
      expect(screen.queryByText('MY GARDEN — 1 PLANT')).toBeOnTheScreen(),
    );
  });

  it('header pluralizes correctly for >1 plant', async () => {
    mockedUsePlants.mockReturnValue(
      makePlantsApi([makePlant({ id: 'a' }), makePlant({ id: 'b' })]),
    );
    render(
      <PlantsListScreen
        onAddPlant={jest.fn()}
        onPlantPress={jest.fn()}
        nowMs={NOW}
        db={makeDb([])}
      />,
    );
    await waitFor(() =>
      expect(screen.queryByText('MY GARDEN — 2 PLANTS')).toBeOnTheScreen(),
    );
  });

  it('header has accessibilityRole="header" for screen readers', async () => {
    mockedUsePlants.mockReturnValue(makePlantsApi([makePlant()]));
    render(
      <PlantsListScreen
        onAddPlant={jest.fn()}
        onPlantPress={jest.fn()}
        nowMs={NOW}
        db={makeDb([])}
      />,
    );
    await waitFor(() => expect(screen.queryByTestId('plants-list-title')).toBeOnTheScreen());
    const title = screen.getByTestId('plants-list-title');
    expect(title.props.accessibilityRole).toBe('header');
  });
});

// =========================================================================
// Status batching
// =========================================================================

describe('PlantsListScreen — status batching', () => {
  it('makes exactly one watering-summary query for N plants', async () => {
    const plants = [
      makePlant({ id: 'a' }),
      makePlant({ id: 'b' }),
      makePlant({ id: 'c' }),
      makePlant({ id: 'd' }),
    ];
    mockedUsePlants.mockReturnValue(makePlantsApi(plants));
    const db = makeDb([]);

    render(
      <PlantsListScreen
        onAddPlant={jest.fn()}
        onPlantPress={jest.fn()}
        nowMs={NOW}
        db={db}
      />,
    );

    await waitFor(() => expect(screen.queryByTestId('plant-card-a')).toBeOnTheScreen());
    // Single GROUP-BY query, NOT one per plant.
    expect(db.getAllAsync as jest.Mock).toHaveBeenCalledTimes(1);
  });

  it('uses a GROUP BY query (single round-trip; no N+1)', async () => {
    const plants = [makePlant({ id: 'a' }), makePlant({ id: 'b' })];
    mockedUsePlants.mockReturnValue(makePlantsApi(plants));
    const db = makeDb([]);

    render(
      <PlantsListScreen
        onAddPlant={jest.fn()}
        onPlantPress={jest.fn()}
        nowMs={NOW}
        db={db}
      />,
    );

    await waitFor(() => expect(screen.queryByTestId('plant-card-a')).toBeOnTheScreen());
    const sql = (db.getAllAsync as jest.Mock).mock.calls[0]?.[0] as string;
    expect(sql).toMatch(/MAX\(watered_at\)/i);
    expect(sql).toMatch(/GROUP BY plant_id/i);
  });

  it('resolvePlantViewModels emits a status per plant from the batched map', () => {
    const plant = makePlant({ override_interval_days: 7 });
    const lastMap = new Map<string, number>([
      [plant.id, NOW - 10 * ONE_DAY_MS], // overdue → 'water'
    ]);
    const vms = resolvePlantViewModels({
      plants: [plant],
      lastWateredByPlantId: lastMap,
      nowMs: NOW,
    });
    expect(vms[0]?.status).toBe('water');
    expect(vms[0]?.lastWateredAtMs).toBe(NOW - 10 * ONE_DAY_MS);
  });

  it('resolvePlantViewModels routes plants without history to the engine fallback', () => {
    const plant = makePlant({
      species_slug: 'species_unknown',
      override_interval_days: null,
    });
    const vms = resolvePlantViewModels({
      plants: [plant],
      lastWateredByPlantId: new Map(),
      nowMs: NOW,
    });
    // species_unknown w/ no override → engine returns 'check_soil'.
    expect(vms[0]?.status).toBe('check_soil');
    expect(vms[0]?.lastWateredAtMs).toBeNull();
  });

  it('fetchWateringSummary builds a Map keyed by plant_id', async () => {
    const db = makeDb([
      { plant_id: 'a', last_watered_at: 100 },
      { plant_id: 'b', last_watered_at: 200 },
    ]);
    const map = await fetchWateringSummary(db);
    expect(map.get('a')).toBe(100);
    expect(map.get('b')).toBe(200);
    expect(map.size).toBe(2);
  });

  it('fetchWateringSummary skips null-valued rows defensively', async () => {
    // GROUP BY without a HAVING can return null watered_at if no rows match;
    // defensive skip keeps the screen-level Map clean.
    const db = makeDb([
      { plant_id: 'a', last_watered_at: 100 },
      { plant_id: 'b', last_watered_at: null as unknown as number },
    ]);
    const map = await fetchWateringSummary(db);
    expect(map.get('a')).toBe(100);
    expect(map.has('b')).toBe(false);
  });
});

// =========================================================================
// FAB
// =========================================================================

describe('PlantsListScreen — FAB interactions', () => {
  it('FAB tap → onAddPlant fires once', async () => {
    mockedUsePlants.mockReturnValue(makePlantsApi([makePlant()]));
    const onAddPlant = jest.fn();
    render(
      <PlantsListScreen
        onAddPlant={onAddPlant}
        onPlantPress={jest.fn()}
        nowMs={NOW}
        db={makeDb([])}
      />,
    );
    await waitFor(() => expect(screen.queryByTestId('plants-list-fab')).toBeOnTheScreen());
    fireEvent.press(screen.getByTestId('plants-list-fab'));
    expect(onAddPlant).toHaveBeenCalledTimes(1);
  });

  it('FAB long-press → onLongPressFAB fires (E3-004 contract)', async () => {
    mockedUsePlants.mockReturnValue(makePlantsApi([makePlant()]));
    const onAddPlant = jest.fn();
    const onLongPressFAB = jest.fn();
    render(
      <PlantsListScreen
        onAddPlant={onAddPlant}
        onPlantPress={jest.fn()}
        onLongPressFAB={onLongPressFAB}
        nowMs={NOW}
        db={makeDb([])}
      />,
    );
    await waitFor(() => expect(screen.queryByTestId('plants-list-fab')).toBeOnTheScreen());
    const fab = screen.getByTestId('plants-list-fab');
    fireEvent(fab, 'longPress');
    expect(onLongPressFAB).toHaveBeenCalledTimes(1);
    // FAB tap path must remain independent of long-press.
    expect(onAddPlant).not.toHaveBeenCalled();
  });

  it('FAB has accessibilityRole="button" + label', async () => {
    mockedUsePlants.mockReturnValue(makePlantsApi([makePlant()]));
    render(
      <PlantsListScreen
        onAddPlant={jest.fn()}
        onPlantPress={jest.fn()}
        nowMs={NOW}
        db={makeDb([])}
      />,
    );
    await waitFor(() => expect(screen.queryByTestId('plants-list-fab')).toBeOnTheScreen());
    const fab = screen.getByTestId('plants-list-fab');
    expect(fab.props.accessibilityRole).toBe('button');
    expect(fab.props.accessibilityLabel).toBe('Add a plant');
  });
});

// =========================================================================
// Row interactions
// =========================================================================

describe('PlantsListScreen — row interactions', () => {
  it('PlantCard tap emits the plant via onPlantPress', async () => {
    const p1 = makePlant({ id: 'a', nickname: 'Alpha' });
    const p2 = makePlant({ id: 'b', nickname: 'Bravo' });
    mockedUsePlants.mockReturnValue(makePlantsApi([p1, p2]));
    const onPlantPress = jest.fn();

    render(
      <PlantsListScreen
        onAddPlant={jest.fn()}
        onPlantPress={onPlantPress}
        nowMs={NOW}
        db={makeDb([])}
      />,
    );

    await waitFor(() => expect(screen.queryByTestId('plant-card-b')).toBeOnTheScreen());
    fireEvent.press(screen.getByTestId('plant-card-b'));
    expect(onPlantPress).toHaveBeenCalledTimes(1);
    expect(onPlantPress).toHaveBeenCalledWith(p2);
  });
});

// =========================================================================
// Refresh / AppState resume
// =========================================================================

describe('PlantsListScreen — refresh + AppState resume', () => {
  it('exposes a refresh handle that re-runs usePlants().list() + fetchWateringSummary', async () => {
    const plants = [makePlant({ id: 'a' })];
    const api = makePlantsApi(plants);
    mockedUsePlants.mockReturnValue(api);
    const db = makeDb([]);

    render(
      <PlantsListScreen
        onAddPlant={jest.fn()}
        onPlantPress={jest.fn()}
        nowMs={NOW}
        db={db}
      />,
    );

    await waitFor(() => expect(screen.queryByTestId('plant-card-a')).toBeOnTheScreen());
    expect(api.list).toHaveBeenCalledTimes(1);
    expect(db.getAllAsync as jest.Mock).toHaveBeenCalledTimes(1);

    const refresh = getMostRecentRefresh();
    expect(refresh).toBeDefined();
    await act(async () => {
      await refresh!();
    });
    expect(api.list).toHaveBeenCalledTimes(2);
    expect(db.getAllAsync as jest.Mock).toHaveBeenCalledTimes(2);
  });

  it('AppState change to "active" re-fetches plants', async () => {
    const plants = [makePlant({ id: 'a' })];
    const api = makePlantsApi(plants);
    mockedUsePlants.mockReturnValue(api);
    const db = makeDb([]);

    // Capture the AppState listener so we can fire it manually.
    let listener: ((s: string) => void) | null = null;
    const removeMock = jest.fn();
    const addEventListenerSpy = jest
      .spyOn(AppState, 'addEventListener')
      .mockImplementation((_event: unknown, fn: unknown) => {
        listener = fn as (s: string) => void;
        return { remove: removeMock } as unknown as ReturnType<
          typeof AppState.addEventListener
        >;
      });

    render(
      <PlantsListScreen
        onAddPlant={jest.fn()}
        onPlantPress={jest.fn()}
        nowMs={NOW}
        db={db}
      />,
    );

    await waitFor(() => expect(screen.queryByTestId('plant-card-a')).toBeOnTheScreen());
    expect(api.list).toHaveBeenCalledTimes(1);
    expect(listener).not.toBeNull();

    // Background → foreground transition.
    await act(async () => {
      listener!('active');
    });
    await waitFor(() => expect(api.list).toHaveBeenCalledTimes(2));

    addEventListenerSpy.mockRestore();
  });
});

// =========================================================================
// Resume-race regression (codex P2)
// =========================================================================

describe('PlantsListScreen — resume race', () => {
  it('a stale pre-resume load that resolves AFTER a resume load does not clobber state', async () => {
    // Initial load returns a "stale" world (1 plant). Resume load returns
    // a "fresh" world (2 plants). We force the initial load to resolve
    // LAST. The screen must show the fresh state, not the stale.
    const stalePlants = [makePlant({ id: 'stale-1', nickname: 'Stale' })];
    const freshPlants = [
      makePlant({ id: 'fresh-1', nickname: 'Fresh1' }),
      makePlant({ id: 'fresh-2', nickname: 'Fresh2' }),
    ];

    let resolveStale: ((plants: Plant[]) => void) | null = null;
    let resolveFresh: ((plants: Plant[]) => void) | null = null;
    const api = {
      list: jest
        .fn()
        // First call: returns the stale promise (won't resolve until we say).
        .mockImplementationOnce(
          () =>
            new Promise<Plant[]>((resolve) => {
              resolveStale = resolve;
            }),
        )
        // Second call: returns the fresh promise.
        .mockImplementationOnce(
          () =>
            new Promise<Plant[]>((resolve) => {
              resolveFresh = resolve;
            }),
        ),
      getById: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      archive: jest.fn(),
      unarchive: jest.fn(),
      remove: jest.fn(),
    };
    mockedUsePlants.mockReturnValue(api);

    let listener: ((s: string) => void) | null = null;
    const removeMock = jest.fn();
    const addEventListenerSpy = jest
      .spyOn(AppState, 'addEventListener')
      .mockImplementation((_event: unknown, fn: unknown) => {
        listener = fn as (s: string) => void;
        return { remove: removeMock } as unknown as ReturnType<
          typeof AppState.addEventListener
        >;
      });

    render(
      <PlantsListScreen
        onAddPlant={jest.fn()}
        onPlantPress={jest.fn()}
        nowMs={NOW}
        db={makeDb([])}
      />,
    );

    // Trigger AppState 'active' BEFORE the initial load resolves.
    expect(listener).not.toBeNull();
    await act(async () => {
      listener!('active');
    });

    // Resolve the FRESH load first.
    await act(async () => {
      resolveFresh!(freshPlants);
    });
    await waitFor(() => expect(screen.queryByTestId('plant-card-fresh-1')).toBeOnTheScreen());

    // Now resolve the STALE load. The generation guard MUST drop the result.
    await act(async () => {
      resolveStale!(stalePlants);
    });

    // Fresh state should still be on screen; stale plant should NOT appear.
    expect(screen.getByTestId('plant-card-fresh-1')).toBeOnTheScreen();
    expect(screen.getByTestId('plant-card-fresh-2')).toBeOnTheScreen();
    expect(screen.queryByTestId('plant-card-stale-1')).not.toBeOnTheScreen();

    addEventListenerSpy.mockRestore();
  });
});

// =========================================================================
// Refresh handle leak guard (codex P3)
// =========================================================================

describe('PlantsListScreen — refresh handle hygiene', () => {
  it('clears the refresh handle on unmount (no leak across tests)', async () => {
    const api = makePlantsApi([makePlant()]);
    mockedUsePlants.mockReturnValue(api);

    const { unmount } = render(
      <PlantsListScreen
        onAddPlant={jest.fn()}
        onPlantPress={jest.fn()}
        nowMs={NOW}
        db={makeDb([])}
      />,
    );
    await waitFor(() => expect(getMostRecentRefresh()).toBeDefined());

    unmount();
    expect(getMostRecentRefresh()).toBeUndefined();
  });
});

// =========================================================================
// Loading state
// =========================================================================

describe('PlantsListScreen — loading state', () => {
  it('renders the cream skeleton frame before usePlants resolves', () => {
    // usePlants.list() returns a promise that never resolves in this test.
    const api = {
      list: jest.fn(() => new Promise(() => {})),
      getById: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      archive: jest.fn(),
      unarchive: jest.fn(),
      remove: jest.fn(),
    };
    mockedUsePlants.mockReturnValue(api);

    render(
      <PlantsListScreen
        onAddPlant={jest.fn()}
        onPlantPress={jest.fn()}
        nowMs={NOW}
        db={makeDb([])}
      />,
    );

    expect(screen.getByTestId('plants-list-loading')).toBeOnTheScreen();
    // No FAB, no list, no empty card during the skeleton window.
    expect(screen.queryByTestId('plants-list-fab')).not.toBeOnTheScreen();
    expect(screen.queryByTestId('plants-list-list')).not.toBeOnTheScreen();
    expect(screen.queryByTestId('plants-list-empty')).not.toBeOnTheScreen();
  });

  it('skeleton has accessibilityLabel "Loading your garden"', () => {
    const api = {
      list: jest.fn(() => new Promise(() => {})),
      getById: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      archive: jest.fn(),
      unarchive: jest.fn(),
      remove: jest.fn(),
    };
    mockedUsePlants.mockReturnValue(api);

    render(
      <PlantsListScreen
        onAddPlant={jest.fn()}
        onPlantPress={jest.fn()}
        nowMs={NOW}
        db={makeDb([])}
      />,
    );

    expect(screen.getByTestId('plants-list-loading').props.accessibilityLabel).toBe(
      'Loading your garden',
    );
  });

  it('DB read failure → renders empty state (defensive fallthrough)', async () => {
    const api = {
      list: jest.fn(async () => {
        throw new Error('SQLite read failed');
      }),
      getById: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      archive: jest.fn(),
      unarchive: jest.fn(),
      remove: jest.fn(),
    };
    mockedUsePlants.mockReturnValue(api);

    render(
      <PlantsListScreen
        onAddPlant={jest.fn()}
        onPlantPress={jest.fn()}
        nowMs={NOW}
        db={makeDb([])}
      />,
    );

    await waitFor(() =>
      expect(screen.queryByTestId('plants-list-loading')).not.toBeOnTheScreen(),
    );
    expect(screen.getByTestId('plants-list-empty')).toBeOnTheScreen();
  });
});

// =========================================================================
// Reduce-motion + dark theme + a11y
// =========================================================================

describe('PlantsListScreen — accessibility / theming', () => {
  it('reduce-motion is respected via per-card useReduceMotion (no screen-level animations)', async () => {
    mockedUseReduceMotion.mockReturnValue(true);
    mockedUsePlants.mockReturnValue(makePlantsApi([makePlant()]));
    render(
      <PlantsListScreen
        onAddPlant={jest.fn()}
        onPlantPress={jest.fn()}
        nowMs={NOW}
        db={makeDb([])}
      />,
    );
    // Render survives reduce-motion=true without errors. The screen has no
    // mount-reveal or pulse animation; PlantCard's pressed-scale gate is
    // covered in PlantCard.test.tsx. This is the screen-level guarantee:
    // it composes the reduce-motion-aware children without adding any
    // un-gated motion of its own.
    await waitFor(() => expect(screen.queryByTestId('plants-list-list')).toBeOnTheScreen());
    expect(screen.getByTestId('plants-list-list')).toBeOnTheScreen();
  });

  it('dark theme tokens apply to the screen background', async () => {
    mockedUseTheme.mockReturnValue(darkTheme);
    mockedUsePlants.mockReturnValue(makePlantsApi([makePlant()]));
    render(
      <PlantsListScreen
        onAddPlant={jest.fn()}
        onPlantPress={jest.fn()}
        nowMs={NOW}
        db={makeDb([])}
        testID="screen"
      />,
    );
    await waitFor(() => expect(screen.queryByTestId('screen')).toBeOnTheScreen());
    const root = screen.getByTestId('screen');
    const flatStyle = Array.isArray(root.props.style)
      ? Object.assign({}, ...root.props.style)
      : root.props.style;
    expect(flatStyle.backgroundColor).toBe(darkTheme.colors.bg);
  });

  it('eyebrow has uppercase label rendered as caps in copy', async () => {
    mockedUsePlants.mockReturnValue(makePlantsApi([makePlant()]));
    render(
      <PlantsListScreen
        onAddPlant={jest.fn()}
        onPlantPress={jest.fn()}
        nowMs={NOW}
        db={makeDb([])}
      />,
    );
    await waitFor(() => expect(screen.queryByTestId('plants-list-eyebrow')).toBeOnTheScreen());
    const eyebrow = screen.getByTestId('plants-list-eyebrow');
    // Both the literal copy and the textTransform contract are uppercased.
    expect(eyebrow.props.children).toBe('MY GARDEN — 1 PLANT');
  });
});

// =========================================================================
// nowMs forwarding (DST/IDL math regression contract)
// =========================================================================

describe('PlantsListScreen — nowMs forwarding (DST/IDL invariant)', () => {
  it('forwards a single per-render nowMs to every PlantCard', async () => {
    // Fix nowMs at a deterministic point and assert each PlantCard's
    // last-watered copy reflects that exact reference.
    const fixedNow = new Date(2026, 4, 8, 9, 0, 0).getTime(); // 9am local
    const wateredAt = fixedNow - 3 * ONE_DAY_MS; // exactly 3 calendar days back
    const p1 = makePlant({ id: 'a', nickname: 'Alpha' });
    const p2 = makePlant({ id: 'b', nickname: 'Bravo' });
    mockedUsePlants.mockReturnValue(makePlantsApi([p1, p2]));

    render(
      <PlantsListScreen
        onAddPlant={jest.fn()}
        onPlantPress={jest.fn()}
        nowMs={fixedNow}
        db={makeDb([
          { plant_id: 'a', last_watered_at: wateredAt },
          { plant_id: 'b', last_watered_at: wateredAt },
        ])}
      />,
    );

    await waitFor(() => expect(screen.queryByTestId('plant-card-a')).toBeOnTheScreen());
    // Both rows agree because both saw the same nowMs reference.
    expect(screen.getByTestId('plant-card-a-last-watered').props.children).toBe(
      'Last watered 3 days ago',
    );
    expect(screen.getByTestId('plant-card-b-last-watered').props.children).toBe(
      'Last watered 3 days ago',
    );
  });

  it('captures Date.now() once per render when nowMs is omitted (no per-row drift)', async () => {
    const p1 = makePlant({ id: 'a' });
    const p2 = makePlant({ id: 'b' });
    mockedUsePlants.mockReturnValue(makePlantsApi([p1, p2]));

    // Don't inject nowMs — let Date.now() fire. Both rows must report the
    // same relative copy because the screen captured one snapshot. The
    // anti-pattern would be calling Date.now() inside each <PlantCard>'s
    // render, which could drift by a millisecond and read different
    // calendar days.
    const wateredAt = Date.now() - 3 * ONE_DAY_MS;
    render(
      <PlantsListScreen
        onAddPlant={jest.fn()}
        onPlantPress={jest.fn()}
        db={makeDb([
          { plant_id: 'a', last_watered_at: wateredAt },
          { plant_id: 'b', last_watered_at: wateredAt },
        ])}
      />,
    );

    await waitFor(() => expect(screen.queryByTestId('plant-card-a')).toBeOnTheScreen());
    const a = screen.getByTestId('plant-card-a-last-watered').props.children as string;
    const b = screen.getByTestId('plant-card-b-last-watered').props.children as string;
    expect(a).toBe(b);
  });
});

// =========================================================================
// Unmount safety / Strict-mode double-mount
// =========================================================================

describe('PlantsListScreen — unmount safety', () => {
  it('cancels in-flight load on unmount (no setState-after-unmount)', async () => {
    let resolveList: ((plants: Plant[]) => void) | null = null;
    const api = {
      list: jest.fn(
        () =>
          new Promise<Plant[]>((resolve) => {
            resolveList = resolve;
          }),
      ),
      getById: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      archive: jest.fn(),
      unarchive: jest.fn(),
      remove: jest.fn(),
    };
    mockedUsePlants.mockReturnValue(api);

    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const { unmount } = render(
      <PlantsListScreen
        onAddPlant={jest.fn()}
        onPlantPress={jest.fn()}
        nowMs={NOW}
        db={makeDb([])}
      />,
    );

    unmount();

    // Now resolve the in-flight promise. The cancelled flag should suppress
    // any setState; React would warn if not.
    await act(async () => {
      resolveList!([makePlant()]);
    });

    expect(errorSpy).not.toHaveBeenCalledWith(
      expect.stringMatching(/Can't perform a React state update on an unmounted component/),
    );
    errorSpy.mockRestore();
  });
});
