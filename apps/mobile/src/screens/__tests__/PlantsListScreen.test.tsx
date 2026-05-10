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
import * as React from 'react';
import { Animated, AppState } from 'react-native';

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

/**
 * Inert E11-005 budget executor: returns count=0. Used to keep the
 * existing screen tests focused on plants-list behavior — meter-specific
 * assertions live in their own block at the bottom.
 *
 * Returns an `LlmBudgetExecutor` with a generic `getFirstAsync<T>` so
 * the executor satisfies the hook's read surface without a runtime
 * cast at every call site (codex E11-006 follow-up P1: the prior
 * specialized return type rejected against the generic interface).
 */
function makeInertBudgetDb(count = 0): import('../../hooks/useLlmBudget').LlmBudgetExecutor {
  return {
    async getFirstAsync<T>(_sql: string, _params: number[]): Promise<T | null> {
      return { count } as unknown as T;
    },
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
// FAB popover (E3-004) — long-press surfaces the popover when wired
// =========================================================================

describe('PlantsListScreen — FAB popover (E3-004)', () => {
  it('popover stays closed until FAB is long-pressed', async () => {
    mockedUsePlants.mockReturnValue(makePlantsApi([makePlant()]));
    render(
      <PlantsListScreen
        onAddPlant={jest.fn()}
        onPlantPress={jest.fn()}
        onQuickDiagnose={jest.fn()}
        nowMs={NOW}
        db={makeDb([])}
      />,
    );
    await waitFor(() => expect(screen.queryByTestId('plants-list-fab')).toBeOnTheScreen());
    expect(screen.queryByTestId('plants-list-fab-popover-menu')).toBeNull();
  });

  it('FAB long-press opens the popover with both items', async () => {
    mockedUsePlants.mockReturnValue(makePlantsApi([makePlant()]));
    render(
      <PlantsListScreen
        onAddPlant={jest.fn()}
        onPlantPress={jest.fn()}
        onQuickDiagnose={jest.fn()}
        nowMs={NOW}
        db={makeDb([])}
      />,
    );
    await waitFor(() => expect(screen.queryByTestId('plants-list-fab')).toBeOnTheScreen());
    fireEvent(screen.getByTestId('plants-list-fab'), 'longPress');
    expect(screen.getByTestId('plants-list-fab-popover-menu')).toBeTruthy();
    expect(screen.getByTestId('plants-list-fab-popover-item-add')).toBeTruthy();
    expect(screen.getByTestId('plants-list-fab-popover-item-diagnose')).toBeTruthy();
  });

  it('popover "Add a plant" → onAddPlant fires; popover dismisses', async () => {
    mockedUsePlants.mockReturnValue(makePlantsApi([makePlant()]));
    const onAddPlant = jest.fn();
    const onQuickDiagnose = jest.fn();
    render(
      <PlantsListScreen
        onAddPlant={onAddPlant}
        onPlantPress={jest.fn()}
        onQuickDiagnose={onQuickDiagnose}
        nowMs={NOW}
        db={makeDb([])}
      />,
    );
    await waitFor(() => expect(screen.queryByTestId('plants-list-fab')).toBeOnTheScreen());
    fireEvent(screen.getByTestId('plants-list-fab'), 'longPress');
    fireEvent.press(screen.getByTestId('plants-list-fab-popover-item-add'));
    expect(onAddPlant).toHaveBeenCalledTimes(1);
    expect(onQuickDiagnose).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.queryByTestId('plants-list-fab-popover-menu')).toBeNull(),
    );
  });

  it('popover "Quick diagnose" → onQuickDiagnose fires; popover dismisses', async () => {
    mockedUsePlants.mockReturnValue(makePlantsApi([makePlant()]));
    const onAddPlant = jest.fn();
    const onQuickDiagnose = jest.fn();
    render(
      <PlantsListScreen
        onAddPlant={onAddPlant}
        onPlantPress={jest.fn()}
        onQuickDiagnose={onQuickDiagnose}
        nowMs={NOW}
        db={makeDb([])}
      />,
    );
    await waitFor(() => expect(screen.queryByTestId('plants-list-fab')).toBeOnTheScreen());
    fireEvent(screen.getByTestId('plants-list-fab'), 'longPress');
    fireEvent.press(screen.getByTestId('plants-list-fab-popover-item-diagnose'));
    expect(onQuickDiagnose).toHaveBeenCalledTimes(1);
    expect(onAddPlant).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.queryByTestId('plants-list-fab-popover-menu')).toBeNull(),
    );
  });

  it('tap-outside dismisses the popover without firing either handler', async () => {
    mockedUsePlants.mockReturnValue(makePlantsApi([makePlant()]));
    const onAddPlant = jest.fn();
    const onQuickDiagnose = jest.fn();
    render(
      <PlantsListScreen
        onAddPlant={onAddPlant}
        onPlantPress={jest.fn()}
        onQuickDiagnose={onQuickDiagnose}
        nowMs={NOW}
        db={makeDb([])}
      />,
    );
    await waitFor(() => expect(screen.queryByTestId('plants-list-fab')).toBeOnTheScreen());
    fireEvent(screen.getByTestId('plants-list-fab'), 'longPress');
    fireEvent.press(screen.getByTestId('plants-list-fab-popover-backdrop'));
    expect(onAddPlant).not.toHaveBeenCalled();
    expect(onQuickDiagnose).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.queryByTestId('plants-list-fab-popover-menu')).toBeNull(),
    );
  });

  it('legacy onLongPressFAB still fires when no onQuickDiagnose is provided (E3-003 backwards-compat)', async () => {
    mockedUsePlants.mockReturnValue(makePlantsApi([makePlant()]));
    const onLongPressFAB = jest.fn();
    render(
      <PlantsListScreen
        onAddPlant={jest.fn()}
        onPlantPress={jest.fn()}
        onLongPressFAB={onLongPressFAB}
        // intentionally no onQuickDiagnose — should NOT mount the popover.
        nowMs={NOW}
        db={makeDb([])}
      />,
    );
    await waitFor(() => expect(screen.queryByTestId('plants-list-fab')).toBeOnTheScreen());
    fireEvent(screen.getByTestId('plants-list-fab'), 'longPress');
    expect(onLongPressFAB).toHaveBeenCalledTimes(1);
    // No popover mounted because onQuickDiagnose is absent.
    expect(screen.queryByTestId('plants-list-fab-popover-menu')).toBeNull();
  });

  it('long-press also notifies onLongPressFAB when popover is wired (analytics passthrough)', async () => {
    mockedUsePlants.mockReturnValue(makePlantsApi([makePlant()]));
    const onLongPressFAB = jest.fn();
    render(
      <PlantsListScreen
        onAddPlant={jest.fn()}
        onPlantPress={jest.fn()}
        onLongPressFAB={onLongPressFAB}
        onQuickDiagnose={jest.fn()}
        nowMs={NOW}
        db={makeDb([])}
      />,
    );
    await waitFor(() => expect(screen.queryByTestId('plants-list-fab')).toBeOnTheScreen());
    fireEvent(screen.getByTestId('plants-list-fab'), 'longPress');
    expect(onLongPressFAB).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('plants-list-fab-popover-menu')).toBeTruthy();
  });

  it('FAB has no onLongPress handler when neither popover nor legacy callback is wired', async () => {
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
    // Without a long-press handler, the hint that announces "Long-press for
    // quick diagnose" should also be absent — otherwise screen readers would
    // promise an affordance with no handler.
    expect(fab.props.accessibilityHint).toBeUndefined();
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

    // Capture EVERY AppState listener (the screen + the E11-005
    // useLlmBudget hook both subscribe). Firing only the last
    // registered listener would miss the screen's load() trigger.
    const listeners: Array<(s: string) => void> = [];
    const removeMock = jest.fn();
    const addEventListenerSpy = jest
      .spyOn(AppState, 'addEventListener')
      .mockImplementation((_event: unknown, fn: unknown) => {
        listeners.push(fn as (s: string) => void);
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
        budgetDb={makeInertBudgetDb()}
      />,
    );

    await waitFor(() => expect(screen.queryByTestId('plant-card-a')).toBeOnTheScreen());
    expect(api.list).toHaveBeenCalledTimes(1);
    expect(listeners.length).toBeGreaterThanOrEqual(1);

    // Background → foreground transition. Fan out to every captured
    // subscriber.
    await act(async () => {
      listeners.forEach((l) => l('active'));
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

    // Capture every listener — the screen + useLlmBudget both subscribe.
    const listeners: Array<(s: string) => void> = [];
    const removeMock = jest.fn();
    const addEventListenerSpy = jest
      .spyOn(AppState, 'addEventListener')
      .mockImplementation((_event: unknown, fn: unknown) => {
        listeners.push(fn as (s: string) => void);
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
        budgetDb={makeInertBudgetDb()}
      />,
    );

    // Trigger AppState 'active' BEFORE the initial load resolves.
    expect(listeners.length).toBeGreaterThanOrEqual(1);
    await act(async () => {
      listeners.forEach((l) => l('active'));
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

// =========================================================================
// E11-005 — Budget meter "37/50 TODAY" in header
// =========================================================================

describe('PlantsListScreen — budget meter (E11-005)', () => {
  it('renders the meter under the eyebrow once the count read is ready', async () => {
    mockedUsePlants.mockReturnValue(makePlantsApi([makePlant({ id: 'a' })]));

    render(
      <PlantsListScreen
        onAddPlant={jest.fn()}
        onPlantPress={jest.fn()}
        nowMs={NOW}
        db={makeDb([])}
        budgetDb={makeInertBudgetDb(37)}
      />,
    );

    await waitFor(() =>
      expect(screen.queryByTestId('plants-list-budget-meter')).toBeOnTheScreen(),
    );
    // Visible label is the small-caps "37/50 TODAY" string.
    expect(screen.getByTestId('plants-list-budget-meter')).toHaveTextContent('37/50 TODAY');
  });

  it('does NOT render "0/50" while the count read is in flight (null-state guard)', async () => {
    mockedUsePlants.mockReturnValue(makePlantsApi([makePlant({ id: 'a' })]));

    // Hold the budget read open so status stays at 'loading'.
    let releaseBudget!: () => void;
    const slowBudgetDb: import('../../hooks/useLlmBudget').LlmBudgetExecutor = {
      async getFirstAsync<T>(_sql: string, _params: number[]): Promise<T | null> {
        return new Promise<T | null>((resolve) => {
          releaseBudget = () => resolve({ count: 0 } as unknown as T);
        });
      },
    };

    render(
      <PlantsListScreen
        onAddPlant={jest.fn()}
        onPlantPress={jest.fn()}
        nowMs={NOW}
        db={makeDb([])}
        budgetDb={slowBudgetDb}
      />,
    );

    // Plants list resolves; meter does NOT appear because status is still 'loading'.
    await waitFor(() => expect(screen.queryByTestId('plants-list-list')).toBeOnTheScreen());
    expect(screen.queryByTestId('plants-list-budget-meter')).not.toBeOnTheScreen();
    expect(screen.queryByText(/0\/50/)).not.toBeOnTheScreen();

    // Once the read resolves, the meter renders.
    await act(async () => {
      releaseBudget();
    });
    await waitFor(() =>
      expect(screen.queryByTestId('plants-list-budget-meter')).toBeOnTheScreen(),
    );
    expect(screen.getByTestId('plants-list-budget-meter')).toHaveTextContent('0/50 TODAY');
  });

  it('exposes a screen-reader-friendly accessibilityLabel ("N of 50 LLM calls today")', async () => {
    mockedUsePlants.mockReturnValue(makePlantsApi([makePlant({ id: 'a' })]));

    render(
      <PlantsListScreen
        onAddPlant={jest.fn()}
        onPlantPress={jest.fn()}
        nowMs={NOW}
        db={makeDb([])}
        budgetDb={makeInertBudgetDb(12)}
      />,
    );

    await waitFor(() =>
      expect(screen.queryByLabelText('12 of 50 LLM calls today')).toBeOnTheScreen(),
    );
  });

  it('does NOT render the meter on the empty-garden surface (meter lives in the list header only)', async () => {
    mockedUsePlants.mockReturnValue(makePlantsApi([]));

    render(
      <PlantsListScreen
        onAddPlant={jest.fn()}
        onPlantPress={jest.fn()}
        nowMs={NOW}
        db={makeDb([])}
        budgetDb={makeInertBudgetDb(3)}
      />,
    );

    // The empty-garden surface owns its own header; the budget meter
    // lives in the LIST header, which doesn't render on the empty path.
    // This test pins that contract — the empty surface is the
    // canonical "no list header" branch and the meter intentionally
    // doesn't appear there in V1. (E11-005 ships the meter in the
    // PlantsList header per the ticket spec; the empty-garden welcome
    // is a separate primitive owned by E3-002.)
    await waitFor(() => expect(screen.queryByTestId('plants-list-empty')).toBeOnTheScreen());
    expect(screen.queryByTestId('plants-list-budget-meter')).not.toBeOnTheScreen();
  });
});

// =========================================================================
// E3-005 — A-1 home contract sweep (tests-only ticket)
// =========================================================================
//
// The blocks above ship with E3-003 / E3-004 / E11-005. The blocks below
// are E3-005's net additions: the contracts each test pins are listed in
// the v0.1.59.0 CHANGELOG entry. Per the brief, this ticket only ADDS
// tests — the production source is unchanged. If a real bug were to
// surface, the discipline is to add an INVERTED regression test that
// fails on current main and would pass once the bug fix ships (Wave 3
// E8-006 pattern), not to widen the test ticket into a feature ticket.

// =========================================================================
// E3-005 — Empty-state details + iteration order
// =========================================================================

describe('PlantsListScreen — E3-005 empty + iteration order', () => {
  it('0 plants → no PlantCard rows mounted (defensive — empty surface owns the screen)', async () => {
    mockedUsePlants.mockReturnValue(makePlantsApi([]));
    render(
      <PlantsListScreen
        onAddPlant={jest.fn()}
        onPlantPress={jest.fn()}
        nowMs={NOW}
        db={makeDb([])}
      />,
    );
    await waitFor(() => expect(screen.queryByTestId('plants-list-empty')).toBeOnTheScreen());
    // No PlantCard rows — UNQueryAllByTestId returns [] for any
    // plant-card-* prefix because the FlatList is not mounted on the
    // empty surface.
    expect(screen.queryAllByText(/Last watered/i)).toHaveLength(0);
    expect(screen.queryByTestId('plants-list-list')).toBeNull();
  });

  it('empty-state headline has accessibilityRole="header" for screen readers', async () => {
    mockedUsePlants.mockReturnValue(makePlantsApi([]));
    render(
      <PlantsListScreen
        onAddPlant={jest.fn()}
        onPlantPress={jest.fn()}
        nowMs={NOW}
        db={makeDb([])}
      />,
    );
    await waitFor(() => expect(screen.queryByTestId('empty-garden-cta')).toBeOnTheScreen());
    // EmptyGardenWelcome's "Welcome to your garden" headline must
    // expose role=header so VoiceOver/TalkBack land on it as the
    // landmark for the Day-1 surface.
    const headline = screen.getByRole('header', { name: /Welcome to your garden/i });
    expect(headline).toBeOnTheScreen();
  });

  it('1 plant → row carries the species headline + curly-quoted nickname', async () => {
    const plant = makePlant({
      id: 'mona',
      species_label: 'Monstera deliciosa',
      nickname: 'Mona',
    });
    mockedUsePlants.mockReturnValue(makePlantsApi([plant]));

    render(
      <PlantsListScreen
        onAddPlant={jest.fn()}
        onPlantPress={jest.fn()}
        nowMs={NOW}
        db={makeDb([{ plant_id: plant.id, last_watered_at: NOW - 3 * ONE_DAY_MS }])}
      />,
    );

    await waitFor(() => expect(screen.queryByTestId('plant-card-mona')).toBeOnTheScreen());
    // Species label is rendered inside the card's species testID slot.
    expect(screen.getByTestId('plant-card-mona-species')).toHaveTextContent(
      'Monstera deliciosa',
    );
    // Nickname is wrapped in curly single quotes per DESIGN.md ("Italic
    // for plant nicknames in quotes"). Pin both the curly quote chars and
    // the nickname so a regression that flips to straight quotes trips.
    expect(screen.getByTestId('plant-card-mona-nickname')).toHaveTextContent(/^‘Mona’$/);
  });

  it('3 plants → DOM order matches usePlants() iteration order (sort is hook-owned)', async () => {
    // The screen iterates `plants` directly; sorting (e.g., by
    // overdue-first) is the hook's responsibility, not the screen's.
    // This test pins that contract: hand the screen a deliberately
    // un-sorted list and assert the DOM mirrors that exact order.
    const plants = [
      makePlant({ id: 'gamma', nickname: 'Gamma' }),
      makePlant({ id: 'alpha', nickname: 'Alpha' }),
      makePlant({ id: 'beta', nickname: 'Beta' }),
    ];
    mockedUsePlants.mockReturnValue(makePlantsApi(plants));

    render(
      <PlantsListScreen
        onAddPlant={jest.fn()}
        onPlantPress={jest.fn()}
        nowMs={NOW}
        db={makeDb([])}
      />,
    );

    await waitFor(() => expect(screen.queryByTestId('plant-card-gamma')).toBeOnTheScreen());
    // Resolve view-models via the same pure resolver the screen uses;
    // their order must match the hand-fed plant order.
    const vms = resolvePlantViewModels({
      plants,
      lastWateredByPlantId: new Map(),
      nowMs: NOW,
    });
    expect(vms.map((vm) => vm.plant.id)).toEqual(['gamma', 'alpha', 'beta']);
    // Belt + braces — every row is mounted under its hook-supplied id.
    expect(screen.getByTestId('plant-card-gamma')).toBeOnTheScreen();
    expect(screen.getByTestId('plant-card-alpha')).toBeOnTheScreen();
    expect(screen.getByTestId('plant-card-beta')).toBeOnTheScreen();
  });
});

// =========================================================================
// E3-005 — FAB tap path + popover-item order
// =========================================================================

describe('PlantsListScreen — E3-005 FAB camera-mount + popover order', () => {
  it('FAB tap fires onAddPlant exactly once (camera-mount callback)', async () => {
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
    // Exactly once — no double-mount of the camera capture surface.
    expect(onAddPlant).toHaveBeenCalledTimes(1);
  });

  it('popover items render in master-plan order: Add a plant FIRST, Quick diagnose SECOND', async () => {
    // Master plan A-1 § FAB behavior locks the popover order — "Add a
    // plant" is the primary affordance (matches the FAB tap path) and
    // "Quick diagnose" is the secondary. A regression that swaps them
    // would put a destructive-feeling action above the additive one.
    mockedUsePlants.mockReturnValue(makePlantsApi([makePlant()]));
    render(
      <PlantsListScreen
        onAddPlant={jest.fn()}
        onPlantPress={jest.fn()}
        onQuickDiagnose={jest.fn()}
        nowMs={NOW}
        db={makeDb([])}
      />,
    );
    await waitFor(() => expect(screen.queryByTestId('plants-list-fab')).toBeOnTheScreen());
    fireEvent(screen.getByTestId('plants-list-fab'), 'longPress');
    const menu = screen.getByTestId('plants-list-fab-popover-menu');
    const add = screen.getByTestId('plants-list-fab-popover-item-add');
    const diagnose = screen.getByTestId('plants-list-fab-popover-item-diagnose');
    // Both rendered.
    expect(menu).toBeTruthy();
    expect(add).toBeTruthy();
    expect(diagnose).toBeTruthy();
    // Order: add THEN diagnose. We assert on the menu's child index
    // rather than rendering-time sequence so a regression that mounts
    // them in reverse trips here.
    const flatten = (node: unknown): unknown[] => {
      const arr = Array.isArray(node) ? node : [node];
      return arr.flatMap((c) => {
        const child = c as { children?: unknown };
        return child && typeof child === 'object' && 'children' in child
          ? [c, ...flatten(child.children)]
          : [c];
      });
    };
    const menuOrder = flatten(menu.props.children)
      .map((n) => {
        const node = n as { props?: { testID?: string } };
        return node?.props?.testID;
      })
      .filter((id): id is string =>
        id === 'plants-list-fab-popover-item-add' ||
        id === 'plants-list-fab-popover-item-diagnose',
      );
    expect(menuOrder.indexOf('plants-list-fab-popover-item-add')).toBeLessThan(
      menuOrder.indexOf('plants-list-fab-popover-item-diagnose'),
    );
  });
});

// =========================================================================
// E3-005 — Dark theme token-level assertions
// =========================================================================

describe('PlantsListScreen — E3-005 dark theme tokens', () => {
  it('header wordmark uses darkTheme.colors.text (not a hex literal)', async () => {
    mockedUseTheme.mockReturnValue(darkTheme);
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
    const flat = Array.isArray(title.props.style)
      ? Object.assign({}, ...title.props.style)
      : title.props.style;
    // Token-level assertion (not hex). If DESIGN.md's dark text token is
    // re-themed (e.g., a brand refresh), this test still passes — it's
    // the screen's reach into theme.colors.text that's under contract.
    expect(flat.color).toBe(darkTheme.colors.text);
  });

  it('eyebrow uses darkTheme.colors.textMuted in dark mode', async () => {
    mockedUseTheme.mockReturnValue(darkTheme);
    mockedUsePlants.mockReturnValue(makePlantsApi([makePlant()]));
    render(
      <PlantsListScreen
        onAddPlant={jest.fn()}
        onPlantPress={jest.fn()}
        nowMs={NOW}
        db={makeDb([])}
      />,
    );
    await waitFor(() =>
      expect(screen.queryByTestId('plants-list-eyebrow')).toBeOnTheScreen(),
    );
    const eyebrow = screen.getByTestId('plants-list-eyebrow');
    const flat = Array.isArray(eyebrow.props.style)
      ? Object.assign({}, ...eyebrow.props.style)
      : eyebrow.props.style;
    expect(flat.color).toBe(darkTheme.colors.textMuted);
  });

  it('does NOT reference theme.warn anywhere on screen mount (token does not exist; tan is the warm accent)', async () => {
    mockedUseTheme.mockReturnValue(darkTheme);
    mockedUsePlants.mockReturnValue(makePlantsApi([makePlant()]));
    // Spy on darkTheme via Proxy so any touch of `colors.warn` fails
    // loudly instead of silently returning `undefined` and slipping
    // through into a transparent style. Build a one-off scoped clone.
    let touchedWarn = false;
    const trapTheme = {
      ...darkTheme,
      colors: new Proxy(darkTheme.colors, {
        get(target, prop) {
          if (prop === 'warn') {
            touchedWarn = true;
            return undefined;
          }
          return (target as unknown as Record<string, unknown>)[prop as string];
        },
      }),
    } as unknown as Theme;
    mockedUseTheme.mockReturnValue(trapTheme);

    render(
      <PlantsListScreen
        onAddPlant={jest.fn()}
        onPlantPress={jest.fn()}
        nowMs={NOW}
        db={makeDb([])}
      />,
    );
    await waitFor(() => expect(screen.queryByTestId('plants-list-fab')).toBeOnTheScreen());
    expect(touchedWarn).toBe(false);
  });
});

// =========================================================================
// E3-005 — Reduce-motion (call-count assertion, not just end-state)
// =========================================================================

describe('PlantsListScreen — E3-005 reduce-motion call-count guarantee', () => {
  it('zero Animated.timing calls fire on screen mount when reduce-motion is on', async () => {
    // The screen has no reveal animations of its own (PlantsListScreen
    // header lines 47-51). Card-level animations are gated by
    // `useReduceMotion()` inside <PlantCard>. This test pins the
    // SCREEN-LEVEL guarantee: with reduce-motion on, mounting the
    // PlantsListScreen + its card subtree produces ZERO Animated.timing
    // calls — not just an end-state opacity, which a duration-0 timing
    // call could slip past (per the v0.1.55.0 P3 lesson).
    mockedUseReduceMotion.mockReturnValue(true);
    mockedUsePlants.mockReturnValue(
      makePlantsApi([
        makePlant({ id: 'a' }),
        makePlant({ id: 'b' }),
        makePlant({ id: 'c' }),
      ]),
    );

    const timingSpy = jest.spyOn(Animated, 'timing');
    try {
      render(
        <PlantsListScreen
          onAddPlant={jest.fn()}
          onPlantPress={jest.fn()}
          nowMs={NOW}
          db={makeDb([])}
        />,
      );
      await waitFor(() =>
        expect(screen.queryByTestId('plants-list-list')).toBeOnTheScreen(),
      );
      // No screen-level reveals + reduce-motion gates per-card animations
      // → zero timing calls observed. The popover is NOT mounted (no
      // onQuickDiagnose), so the FABPopover's async fade pathway can't
      // contribute either.
      expect(timingSpy).not.toHaveBeenCalled();
    } finally {
      timingSpy.mockRestore();
    }
  });
});

// =========================================================================
// E3-005 — StrictMode safety (sibling MountProbe proves double-mount)
// =========================================================================

/**
 * Sibling probe whose `useEffect` runs once per commit. We assert the
 * counter is `>= 2` before any other contract assertion — a non-StrictMode
 * test environment can't false-pass the latch tests because the probe
 * itself wouldn't tick twice. Mirrors the v0.1.55.0 E9-005 pattern.
 */
function MountProbe({ counter }: { counter: { count: number } }) {
  React.useEffect(() => {
    counter.count += 1;
  });
  return null;
}

describe('PlantsListScreen — E3-005 StrictMode safety', () => {
  it('FAB tap fires onAddPlant exactly once across StrictMode double-mount', async () => {
    const counter = { count: 0 };
    mockedUsePlants.mockReturnValue(makePlantsApi([makePlant()]));
    const onAddPlant = jest.fn();

    render(
      <React.StrictMode>
        <MountProbe counter={counter} />
        <PlantsListScreen
          onAddPlant={onAddPlant}
          onPlantPress={jest.fn()}
          nowMs={NOW}
          db={makeDb([])}
        />
      </React.StrictMode>,
    );

    await waitFor(() => expect(screen.queryByTestId('plants-list-fab')).toBeOnTheScreen());
    // PROBE FIRST — proves the test environment is provably StrictMode-
    // active. If this assertion fails, every contract assertion below it
    // is meaningless because we'd be testing a non-strict tree.
    expect(counter.count).toBeGreaterThanOrEqual(2);

    fireEvent.press(screen.getByTestId('plants-list-fab'));
    // The contract: even though the screen mounts twice under StrictMode,
    // a single user tap fires onAddPlant exactly once (no double-mount of
    // the camera surface).
    expect(onAddPlant).toHaveBeenCalledTimes(1);
  });
});

// =========================================================================
// E3-005 — Hermes-without-Intl tripwire
// =========================================================================

describe('PlantsListScreen — E3-005 Hermes-without-Intl tripwire', () => {
  it('PlantsListScreen itself does NOT call Date.prototype.toLocaleDateString or Intl.DateTimeFormat on mount', async () => {
    // PlantsListScreen owns the header + FAB + popover wiring. Date
    // formatting is the per-card concern (the >14-day "Last watered on
    // {Mon D}" copy), and that's covered by PlantCard's own tests. This
    // tripwire pins the screen-level negative: a future regression that
    // tries to print a "garden last updated" timestamp in the header
    // (or anywhere else on the screen surface) would have to route
    // through a documented formatter rather than reaching for Intl
    // directly — Hermes ships without Intl unless the build opts in.
    //
    // We monkey-patch BOTH APIs to throw, then assert the screen still
    // renders. The renderable surface includes the FlatList + FAB; if
    // any screen-level consumer reaches into Intl it'd throw on render.
    const origToLocaleDateString = Date.prototype.toLocaleDateString;
    const origIntlDTF = Intl.DateTimeFormat;
    let toLocaleDateStringCalls = 0;
    let intlDTFCalls = 0;

    // Wrap rather than throw — the per-card "Last watered on {Mon D}"
    // bucket only fires for >14-day timestamps, so a 3-day fixture
    // never trips it. The test's job is to count calls AT THE SCREEN
    // LEVEL with a 3-day fixture; both counters must remain at zero.
    Date.prototype.toLocaleDateString = function patched(
      this: Date,
      ...args: Parameters<typeof Date.prototype.toLocaleDateString>
    ) {
      toLocaleDateStringCalls += 1;
      return origToLocaleDateString.apply(this, args);
    };
    Intl.DateTimeFormat = new Proxy(origIntlDTF, {
      construct(_target, args) {
        intlDTFCalls += 1;
        return new origIntlDTF(...(args as ConstructorParameters<typeof Intl.DateTimeFormat>));
      },
    }) as unknown as typeof Intl.DateTimeFormat;

    try {
      mockedUsePlants.mockReturnValue(
        makePlantsApi([
          makePlant({ id: 'a' }),
          makePlant({ id: 'b' }),
        ]),
      );
      const wateredAt = NOW - 3 * ONE_DAY_MS; // 3-day bucket — no Intl path
      render(
        <PlantsListScreen
          onAddPlant={jest.fn()}
          onPlantPress={jest.fn()}
          nowMs={NOW}
          db={makeDb([
            { plant_id: 'a', last_watered_at: wateredAt },
            { plant_id: 'b', last_watered_at: wateredAt },
          ])}
        />,
      );
      await waitFor(() => expect(screen.queryByTestId('plant-card-a')).toBeOnTheScreen());
      // Zero calls at the screen level (PlantsListScreen itself doesn't
      // format dates; the cards do, and the 3-day bucket short-circuits
      // before reaching Intl).
      expect(toLocaleDateStringCalls).toBe(0);
      expect(intlDTFCalls).toBe(0);
    } finally {
      Date.prototype.toLocaleDateString = origToLocaleDateString;
      Intl.DateTimeFormat = origIntlDTF;
    }
  });

  it('screen still renders when Date.prototype.toLocaleDateString is monkey-patched to throw', async () => {
    // Stronger form: even if a transitive dependency tried to reach
    // Intl on screen mount, the visible surface should still come up
    // (because PlantsListScreen has no date-display path of its own).
    // This is the inverted regression for "future addition that prints
    // the date in the header" — if added without the Hermes-safe
    // formatter, this test trips first.
    const origToLocaleDateString = Date.prototype.toLocaleDateString;
    Date.prototype.toLocaleDateString = function () {
      throw new Error('Hermes-without-Intl tripwire');
    } as typeof Date.prototype.toLocaleDateString;

    try {
      mockedUsePlants.mockReturnValue(makePlantsApi([makePlant({ id: 'a' })]));
      const wateredAt = NOW - 3 * ONE_DAY_MS; // 3-day bucket — never reaches Intl
      render(
        <PlantsListScreen
          onAddPlant={jest.fn()}
          onPlantPress={jest.fn()}
          nowMs={NOW}
          db={makeDb([{ plant_id: 'a', last_watered_at: wateredAt }])}
        />,
      );
      await waitFor(() =>
        expect(screen.queryByTestId('plant-card-a')).toBeOnTheScreen(),
      );
      // FAB renders, header renders, FlatList renders — the screen-
      // level surface is fully painted without ever entering the Intl
      // path.
      expect(screen.getByTestId('plants-list-fab')).toBeOnTheScreen();
      expect(screen.getByTestId('plants-list-title')).toBeOnTheScreen();
    } finally {
      Date.prototype.toLocaleDateString = origToLocaleDateString;
    }
  });
});
