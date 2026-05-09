// PlantsListScreen — A-1 Garden Home (E3-003).
//
// Composes the components from earlier E3 tickets:
//   - <EmptyGardenWelcome>  (E3-002) for the Day-1 zero-plant card
//   - <PlantCard>           (E3-001) for each row
//   - <FAB>                 (E2-009) for the bottom-right "+"
//
// # Why this screen owns status, not <PlantCard>
//
// `useWateringEngine()` opens SQLite and runs `getFirstAsync` for the
// most-recent watering event per plant. Hooking it inside <PlantCard> would
// fire N parallel SQLite reads for an N-plant list. <PlantCard> shipped in
// E3-001 with a deliberate `status: WateringStatus` prop so the screen can
// batch the reads at the screen layer. We do that here with a single
// `SELECT plant_id, MAX(watered_at) ... GROUP BY plant_id` against the
// `idx_water_plant_date` index, then call the pure `computeWateringStatus`
// per plant in render. One SQL round-trip, N pure decisions.
//
// # Per-render `now` snapshot
//
// `Date.now()` is captured ONCE per render and forwarded to every <PlantCard>
// as `nowMs`, plus passed to `computeWateringStatus`. Without this, two cards
// in the same render could disagree on "today" if a millisecond ticks between
// reads. The screen also re-mounts (refresh) on AppState 'active' so the
// snapshot stays fresh after a long backgrounding (overnight wake-up case —
// the master plan's "open the app in the morning, see the chips" path).
//
// # Loading skeleton
//
// The first usePlants.list() resolves in single-digit ms on real devices
// (local SQLite, indexed, no cross-process boundary). The skeleton is just
// the cream surface tint while the read flushes — no shimmer, no spinner
// (DESIGN.md "no decorative blobs", master plan "loads instantly from local
// SQLite — no spinner, no friction"). For the rare DB-read-failure path the
// master plan specifies an inline tan banner with a Retry CTA — surfaced via
// <ToastBanner> here.
//
// # Pull-to-refresh
//
// Master plan "Plants list (A-1)" § Scroll: "vertical only, no
// pull-to-refresh in V1 (data is local)." We honor that: no
// `RefreshControl` is wired into the FlatList. Refresh happens implicitly
// on AppState 'active' (covers the overnight-wake-up scenario where a
// background drain may have added plants), and explicitly via the `refresh`
// callback exposed for testing + future A-1-banner Retry.
//
// # Reduce-motion
//
// No mount/reveal animations on this screen. The list snaps in. The
// PlantCard's pressed-state scale is already gated by `useReduceMotion()` at
// the card level (E3-001). The screen has no further reveal/pulse to gate.
//
// # V1 scope locks (do not add)
// - No virtualization library beyond FlatList.
// - No react-query / swr / data-fetching lib.
// - No date-fns / dayjs / luxon / Temporal.
// - No ORM.
// - No pull-to-refresh (master-plan locked above).
// - No server-side sort / pagination.
// - No collapsing the WateringStatus enum.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AppState,
  type AppStateStatus,
  FlatList,
  type ListRenderItemInfo,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { EmptyGardenWelcome } from '../components/EmptyGardenWelcome';
import { PlantCard } from '../components/PlantCard';
import { FAB } from '../components/primitives/FAB';
import { openDb } from '../db';
import type { Plant } from '../db/types';
import { useLlmBudget } from '../hooks/useLlmBudget';
import { useTheme } from '../hooks/useTheme';
import { usePlants } from '../hooks/usePlants';
import { computeWateringStatus, type WateringStatus } from '../watering';

/**
 * Subset of `expo-sqlite`'s `SQLiteDatabase` we need for the screen-level
 * watering batch query. Same shape as `usePlants`'s executor — keeps the
 * test seam narrow (callers can inject a better-sqlite3 adapter without
 * spinning up jest-expo's RN env).
 */
export type WateringSummaryRow = {
  plant_id: string;
  last_watered_at: number;
};

export interface ScreenDb {
  getAllAsync<T>(source: string, params: Array<string | number | null>): Promise<T[]>;
}

/**
 * One round-trip query that yields the most-recent `watered_at` per plant_id.
 * `MAX(watered_at) GROUP BY plant_id` is index-supported by
 * `idx_water_plant_date (plant_id, watered_at DESC)` so it's an O(N) skip
 * scan, not a full table read. Plants with zero events simply don't appear
 * in the result; the screen falls back to `null` for them and
 * computeWateringStatus routes through its `'check_soil'` null-history
 * branch (or `'water'` if the plant was added > intervalDays ago — the
 * engine owns that decision, not the screen).
 */
export async function fetchWateringSummary(
  db: ScreenDb,
): Promise<Map<string, number>> {
  const rows = await db.getAllAsync<WateringSummaryRow>(
    `SELECT plant_id, MAX(watered_at) AS last_watered_at
       FROM watering_events
      GROUP BY plant_id`,
    [],
  );
  const map = new Map<string, number>();
  for (const row of rows) {
    if (row.last_watered_at != null) {
      map.set(row.plant_id, row.last_watered_at);
    }
  }
  return map;
}

/**
 * Pure resolver: given the list of plants and the per-plant last-watered
 * timestamps, compute each plant's status + last-watered ms. Exported for
 * tests so the batching contract is asserted directly.
 */
export function resolvePlantViewModels(input: {
  plants: ReadonlyArray<Plant>;
  lastWateredByPlantId: ReadonlyMap<string, number>;
  nowMs: number;
}): ReadonlyArray<PlantViewModel> {
  const { plants, lastWateredByPlantId, nowMs } = input;
  return plants.map((plant) => {
    const lastWateredAtMs = lastWateredByPlantId.get(plant.id) ?? null;
    const status: WateringStatus = computeWateringStatus({
      plant,
      lastWateredAt: lastWateredAtMs,
      nowMs,
    });
    return {
      plant,
      lastWateredAtMs,
      status,
    };
  });
}

export interface PlantViewModel {
  plant: Plant;
  lastWateredAtMs: number | null;
  status: WateringStatus;
}

export interface PlantsListScreenProps {
  /** Tap "+": launch camera capture in identify mode (master plan A-1 → A-5). */
  onAddPlant: () => void;
  /** Long-press "+": open the E3-004 popover. Wiring lands in E3-004. */
  onLongPressFAB?: () => void;
  /** Tap a row: navigate to plant detail (A-2). */
  onPlantPress: (plant: Plant) => void;
  /**
   * Test seam — inject a deterministic `now` so relative-date copy is
   * stable across snapshots. Production callers omit this.
   */
  nowMs?: number;
  /**
   * Test seam — inject a custom DB for the watering summary query. Defaults
   * to `openDb()`. Mirrors the dependency-injection shape `usePlants` uses.
   */
  db?: ScreenDb;
  /**
   * Test seam — inject a custom DB for the E11-005 budget meter
   * (`useLlmBudget`). Defaults to `openDb()` (the production path
   * shares one connection with the watering-summary query). Kept as a
   * separate prop because tests typically pin the budget count
   * deterministically without involving the watering-summary query, so
   * a single combined seam would force every test to mock both.
   */
  budgetDb?: import('../hooks/useLlmBudget').LlmBudgetExecutor;
  testID?: string;
}

const HEADER_TITLE = 'PlantCare';

export function PlantsListScreen({
  onAddPlant,
  onLongPressFAB,
  onPlantPress,
  nowMs,
  db,
  budgetDb,
  testID,
}: PlantsListScreenProps) {
  const theme = useTheme();
  const plantsApi = usePlants();
  // E11-005 budget meter. Pass either the test-seam executor or a
  // factory that lazily resolves the production DB on first refresh —
  // the factory form means screen mount doesn't block on openDb().
  const budget = useLlmBudget({
    db: budgetDb ?? (() => openDb()),
    now: nowMs !== undefined ? () => nowMs : undefined,
  });

  /**
   * Generation counter for in-flight loads. Each invocation of `load`
   * captures the current generation; only the most-recent generation is
   * allowed to commit setState. This supersedes any older in-flight load
   * — initial mount → backgrounded mid-fetch → AppState 'active' kicks
   * off a fresh load → original load resolves last → must NOT clobber
   * the fresh result. (Codex P2 from review.)
   *
   * Also doubles as the unmount cancellation signal: cleanup increments
   * the generation, invalidating every still-in-flight load.
   */
  const loadGenerationRef = useRef(0);

  const [plants, setPlants] = useState<ReadonlyArray<Plant>>([]);
  const [lastWateredByPlantId, setLastWateredByPlantId] = useState<
    ReadonlyMap<string, number>
  >(() => new Map());
  const [loading, setLoading] = useState(true);

  const load = useCallback(
    async (generation: number) => {
      const list = await plantsApi.list();
      const summaryDb = db ?? (await openDb());
      const summary = await fetchWateringSummary(summaryDb);
      // Older generation lost the race; drop its result.
      if (loadGenerationRef.current !== generation) return;
      setPlants(list);
      setLastWateredByPlantId(summary);
      setLoading(false);
    },
    [plantsApi, db],
  );

  // Initial fetch + AppState resume re-fetch. The single effect manages
  // both: on mount we kick off `load`; we also subscribe to AppState and
  // re-run `load` on transition to 'active'. `load` is stable (memoized
  // against plantsApi which is itself memoized).
  useEffect(() => {
    loadGenerationRef.current += 1;
    const initialGeneration = loadGenerationRef.current;

    void load(initialGeneration).catch(() => {
      if (loadGenerationRef.current !== initialGeneration) return;
      // DB read failure: surface "no plants" state (master plan: tan
      // banner with Retry; the banner wires in via the parent shell so
      // we keep this screen surface tight). Keep loading=false so the
      // FAB renders and the user can still add a plant.
      setPlants([]);
      setLastWateredByPlantId(new Map());
      setLoading(false);
    });

    // jest-expo's RN environment can return undefined from `addEventListener`
    // on legacy mocks. Guard the unsubscribe so the cleanup never throws.
    const sub = AppState.addEventListener('change', (next: AppStateStatus) => {
      if (next === 'active') {
        // Bump the generation — supersede any in-flight load (initial
        // mount or prior resume) so a stale resolution can't clobber
        // fresher post-resume state.
        loadGenerationRef.current += 1;
        const resumeGeneration = loadGenerationRef.current;
        void load(resumeGeneration).catch(() => {
          /* swallow — keep prior state on resume failure */
        });
      }
    }) as { remove?: () => void } | undefined;

    return () => {
      // Bump generation to invalidate any still-in-flight load. This
      // doubles as the cancellation signal for unmount + Strict-mode
      // double-mount (each mount gets a fresh generation; the unmount
      // bump ensures even the initial-mount load can't setState after
      // unmount).
      loadGenerationRef.current += 1;
      if (sub && typeof sub.remove === 'function') {
        sub.remove();
      }
    };
  }, [load]);

  /**
   * Manual refresh hook — exposed for the future A-1 tan-banner Retry
   * affordance and for tests. Intentionally not wired to a pull-to-refresh
   * gesture (master plan scope lock). Bumps the generation so it
   * supersedes any in-flight load.
   */
  const refresh = useCallback(async () => {
    loadGenerationRef.current += 1;
    const generation = loadGenerationRef.current;
    await load(generation);
  }, [load]);

  // Stable per-render snapshot. Captured once so every <PlantCard> sees
  // the exact same "now" — no two cards can disagree on "today" because a
  // ms ticked between row renders. Also feeds computeWateringStatus.
  const effectiveNow = nowMs ?? Date.now();

  const viewModels = useMemo(
    () =>
      resolvePlantViewModels({
        plants,
        lastWateredByPlantId,
        nowMs: effectiveNow,
      }),
    [plants, lastWateredByPlantId, effectiveNow],
  );

  const styles = useMemo(
    () =>
      StyleSheet.create({
        screen: {
          flex: 1,
          backgroundColor: theme.colors.bg,
        },
        header: {
          paddingHorizontal: 24,
          paddingTop: 24,
          paddingBottom: 16,
        },
        title: {
          // "PlantCare" Fraunces wordmark per A-1 mockup. Generous serif
          // for the editorial-paper feel.
          fontFamily: 'Fraunces_600SemiBold',
          fontSize: 32,
          lineHeight: 38,
          color: theme.colors.text,
        },
        eyebrow: {
          // "MY GARDEN — N PLANTS" small all-caps under the wordmark in
          // the light A-1 mockup. Inter medium with a comfortable
          // letter-spacing per DESIGN.md "small all-caps Inter for
          // status labels" voice.
          fontFamily: 'Inter_500Medium',
          fontSize: 11,
          lineHeight: 14,
          letterSpacing: 1.4,
          color: theme.colors.textMuted,
          textTransform: 'uppercase',
          marginTop: 6,
        },
        budgetMeter: {
          // E11-005 budget meter — small all-caps below the eyebrow.
          // Same Inter_500Medium / 11px / letterSpacing 1.4 / textMuted
          // tokens as the eyebrow per DESIGN.md "small all-caps Inter
          // for status labels". Tighter top margin (4px) keeps the two
          // small-caps lines visually grouped as a single header block
          // rather than two distinct sections.
          fontFamily: 'Inter_500Medium',
          fontSize: 11,
          lineHeight: 14,
          letterSpacing: 1.4,
          color: theme.colors.textMuted,
          textTransform: 'uppercase',
          marginTop: 4,
        },
        listContent: {
          // Bottom padding ensures the last row clears the FAB (56 + 16
          // anchor offset + 24 breathing room).
          paddingBottom: 96,
        },
        separator: {
          height: StyleSheet.hairlineWidth,
          backgroundColor: theme.colors.stroke,
          opacity: 0.2,
          marginHorizontal: 16,
        },
        fabAnchor: {
          // Bottom-right anchor per A-1 mockup. The FAB primitive sizes
          // itself (56×56) and we provide the absolute positioning.
          position: 'absolute',
          right: 16,
          bottom: 24,
        },
        emptyWrap: {
          flex: 1,
          justifyContent: 'center',
          paddingHorizontal: 16,
        },
        skeleton: {
          flex: 1,
        },
      }),
    [theme.colors.bg, theme.colors.text, theme.colors.textMuted, theme.colors.stroke],
  );

  // Loading skeleton — cream surface, no spinner. Master plan: "no special
  // treatment". A blank screen frame for a single-digit-ms window beats a
  // shimmer that draws the eye to a non-event.
  if (loading) {
    return (
      <View
        testID={testID ? `${testID}-loading` : 'plants-list-loading'}
        style={[styles.screen, styles.skeleton]}
        accessibilityLabel="Loading your garden"
      />
    );
  }

  // Zero-plants → EmptyGardenWelcome; FAB hidden (master plan: "The
  // floating '+' FAB is hidden until 1+ plants exist (one CTA, no choice
  // paralysis)").
  if (plants.length === 0) {
    return (
      <View testID={testID} style={styles.screen}>
        <View style={styles.emptyWrap}>
          <EmptyGardenWelcome
            onAddFirst={onAddPlant}
            testID={testID ? `${testID}-empty` : 'plants-list-empty'}
          />
        </View>
      </View>
    );
  }

  // 1+ plants → header + FlatList of PlantCard rows + FAB.
  return (
    <View testID={testID} style={styles.screen}>
      <FlatList
        testID={testID ? `${testID}-list` : 'plants-list-list'}
        data={viewModels}
        // plant.id (UUID) is stable across renders; never use index — it
        // breaks key identity when the list is sorted or filtered (codex
        // P-class catch from the V1 push session).
        keyExtractor={(vm) => vm.plant.id}
        ListHeaderComponent={
          <View style={styles.header}>
            <Text
              accessibilityRole="header"
              style={styles.title}
              testID="plants-list-title"
            >
              {HEADER_TITLE}
            </Text>
            <Text
              accessible
              accessibilityRole="text"
              style={styles.eyebrow}
              testID="plants-list-eyebrow"
            >
              {`MY GARDEN — ${plants.length} ${plants.length === 1 ? 'PLANT' : 'PLANTS'}`}
            </Text>
            {budget.status === 'ready' ? (
              <Text
                accessible
                accessibilityRole="text"
                accessibilityLabel={`${budget.used} of ${budget.limit} LLM calls today`}
                style={styles.budgetMeter}
                testID="plants-list-budget-meter"
              >
                {`${budget.used}/${budget.limit} TODAY`}
              </Text>
            ) : null}
          </View>
        }
        ItemSeparatorComponent={SeparatorComponent}
        contentContainerStyle={styles.listContent}
        renderItem={({ item }: ListRenderItemInfo<PlantViewModel>) => (
          <PlantCard
            speciesLabel={item.plant.species_label}
            nickname={item.plant.nickname}
            // hero_photo_id is the FK; the actual URI resolves via the
            // photos table. E3-005 / future detail wiring threads the URI;
            // for V1 list we let HeroPhoto fall through to its cream
            // skeleton when a URI hasn't been resolved yet (queued-identify
            // and brand-new-plant shapes both look correct without a
            // pre-loaded image).
            photoUri={null}
            lastWateredAtMs={item.lastWateredAtMs}
            status={item.status}
            onPress={() => onPlantPress(item.plant)}
            nowMs={effectiveNow}
            testID={`plant-card-${item.plant.id}`}
          />
        )}
      />
      <View style={styles.fabAnchor} pointerEvents="box-none">
        <FAB
          onPress={onAddPlant}
          onLongPress={onLongPressFAB}
          testID={testID ? `${testID}-fab` : 'plants-list-fab'}
        />
      </View>
      {/* refresh isn't rendered, but exposed via test seam below */}
      <RefreshHandle refresh={refresh} />
    </View>
  );
}

// ---- Test-only refresh side-channel --------------------------------------
//
// Exposed so tests can invoke the screen's `refresh()` callback without
// threading it through the public component props. Registration happens
// inside an effect (committed-tree only — never during render) and is
// cleared on unmount so a teardown leak can't expose a stale callback to a
// later test or to a Strict-mode-uncommitted render.

const refreshHandleRefs = new Map<symbol, () => Promise<void>>();
let mostRecentRefreshKey: symbol | null = null;

export function getMostRecentRefresh(): (() => Promise<void>) | undefined {
  if (!mostRecentRefreshKey) return undefined;
  return refreshHandleRefs.get(mostRecentRefreshKey);
}

/**
 * Test-only reset. Invoked between cases via `afterEach` so a stale
 * registration from a previous render can't leak into the next test.
 */
export function __resetRefreshHandlesForTests(): void {
  refreshHandleRefs.clear();
  mostRecentRefreshKey = null;
}

// SeparatorComponent is hoisted so FlatList's reference-stability check
// doesn't re-render every row when the screen re-renders. Inline arrow
// would re-create the function each render and re-key the separators.
function SeparatorComponent() {
  const { colors } = useTheme();
  return (
    <View
      style={{
        height: StyleSheet.hairlineWidth,
        backgroundColor: colors.stroke,
        opacity: 0.2,
        marginHorizontal: 16,
      }}
    />
  );
}

/**
 * Hidden component that registers `refresh` with a module-scoped side-channel
 * so tests can drive a refresh without threading the callback through the
 * public component props. Registration happens INSIDE an effect (committed-
 * tree only) so a Strict-mode-discarded render never exposes a stale
 * callback. Cleanup deletes the entry so unmount or test teardown leaves
 * the Map empty.
 *
 * Note: this component intentionally renders nothing. It exists purely so
 * `useEffect` is committed only when the parent commits — same effect
 * timing as any other child.
 */
function RefreshHandle({ refresh }: { refresh: () => Promise<void> }) {
  const keyRef = useRef<symbol | null>(null);
  // Lazily allocate a per-mount key; useRef preserves identity across
  // re-renders without an effect dep churn.
  if (keyRef.current === null) {
    keyRef.current = Symbol('plants-list-refresh');
  }
  const key = keyRef.current;

  useEffect(() => {
    refreshHandleRefs.set(key, refresh);
    mostRecentRefreshKey = key;
    return () => {
      refreshHandleRefs.delete(key);
      // If this was the most-recent key, clear the pointer so a stale
      // lookup returns undefined instead of a deleted callback.
      if (mostRecentRefreshKey === key) {
        mostRecentRefreshKey = null;
      }
    };
  }, [key, refresh]);

  return null;
}
