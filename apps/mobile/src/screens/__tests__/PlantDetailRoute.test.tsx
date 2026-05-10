/**
 * PlantDetailRoute tests (E8-004).
 *
 * The wrapper used to (E4-007) just thread `noteEnabled = isFeatureEnabled
 * ('addNote')` into `<PlantDetailScreen>`. E8-004 promotes the wrapper into
 * the call site that owns the AddNoteSheet wiring: `noteEnabled = true` is
 * threaded directly (route-layer flip seam — `FEATURE_FLAGS.addNote` constant
 * stays `false`), the "Add note" button mounts the sheet, and onSave persists
 * via `usePersistNote(plantId)`.
 *
 * Coverage targets:
 *   (a) Route layer threads `noteEnabled = true` regardless of
 *       FEATURE_FLAGS — the constant stays `false` (locked by
 *       featureFlags.test.ts), the button is in the tree.
 *   (b) Tap "Add note" → AddNoteSheet mounts; before that, sheet is NOT in
 *       the tree (conditional render — Modal portal isn't mounted while
 *       closed).
 *   (c) Sheet onCancel → sheet closes, no persist write.
 *   (d) Sheet onSave (kind='ok' recommendation Done) → persist fires with
 *       the right discriminated input shape; sheet closes.
 *   (e) Sheet onSave (kind='queued') → persist fires with `kind: 'queued'`
 *       and `llmResponse: null`; sheet closes.
 *   (f) Strict-mode double-mount: only one sheet in the tree, only one
 *       persist call per user click on Save & analyze.
 *   (g) Dark mode: AddNoteSheet mounts under the dark theme through the
 *       wrapper without losing dark tokens.
 *   (h) Reduce-motion ON: AddNoteSheet's slide-in animation is gated; no
 *       `Animated.timing` fires on open.
 *   (i) Forward all non-flag, non-AddNote props unchanged.
 *
 * Mocks: `usePersistNote` is mocked at the module level so we can verify
 * the persist call shape without spinning up SQLite (the unit suite at
 * usePersistNote.test.tsx covers real SQL via better-sqlite3, and the
 * E8-006 integration suite covers the sheet → persist → SQLite chain
 * end-to-end). The screen-level hooks follow the same convention as
 * PlantDetailScreen.test.tsx.
 *
 * Callback access: we drive `onSave` / `onCancel` by reaching into the
 * mounted AddNoteSheet's props via `UNSAFE_root.findByType` (RNTL exposes
 * the react-test-renderer API). This sidesteps the inner consult round-
 * trip, which is covered exhaustively in AddNoteSheet.test.tsx and
 * addNoteFlow.integration.test.tsx — the wrapper's contract here is the
 * onSave → persist mapping, not the LLM round-trip.
 */
import { darkTheme, lightTheme } from '@plantcare/theme';
import { act, fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import { Animated } from 'react-native';

import type { ApiClient } from '../../api';
import { AddNoteSheet, type AddNoteSavedPayload } from '../../components/AddNoteSheet';
import { useMarkWatered, type MarkWateredResult } from '../../hooks/useMarkWatered';
import { useReduceMotion } from '../../hooks/useReduceMotion';
import { useTheme } from '../../hooks/useTheme';
import { useWateringEngine } from '../../hooks/useWateringEngine';
import * as persistModule from '../../hooks/usePersistNote';
import type { PersistNoteInput, PersistNoteResult } from '../../hooks/usePersistNote';
import type { WateringStatus } from '../../watering';
import type { Plant } from '../../db/types';

import { PlantDetailRoute } from '../PlantDetailRoute';

// ─── Mocks ──────────────────────────────────────────────────────────────

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

jest.mock('react-native/Libraries/Utilities/useColorScheme', () => ({
  __esModule: true,
  default: jest.fn(() => 'light'),
}));

// AddNoteSheet's underlying EditorialBottomSheet reads
// AccessibilityInfo.isReduceMotionEnabled directly. Mirror the mock pattern
// from AddNoteSheet.test.tsx so the primitive resolves without hitting the
// native bridge.
const mockReduceMotionListeners: Array<(value: boolean) => void> = [];
const mockState = { reduceMotion: false };

jest.mock(
  'react-native/Libraries/Components/AccessibilityInfo/AccessibilityInfo',
  () => ({
    __esModule: true,
    default: {
      isReduceMotionEnabled: jest.fn(() =>
        Promise.resolve(mockState.reduceMotion),
      ),
      addEventListener: jest.fn((event: string, listener: (v: boolean) => void) => {
        if (event === 'reduceMotionChanged') {
          mockReduceMotionListeners.push(listener);
        }
        return {
          remove: () => {
            const idx = mockReduceMotionListeners.indexOf(listener);
            if (idx >= 0) mockReduceMotionListeners.splice(idx, 1);
          },
        };
      }),
    },
  }),
);

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

// eslint-disable-next-line @typescript-eslint/no-require-imports
const useColorSchemeMock = require('react-native/Libraries/Utilities/useColorScheme')
  .default as jest.Mock<'light' | 'dark' | null | undefined, []>;

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

function makeApiClient(): ApiClient {
  return {
    identify: jest.fn() as never,
    diagnose: jest.fn() as never,
    consult: jest.fn() as never,
    review: jest.fn() as never,
    weather: jest.fn() as never,
  };
}

type PersistSpy = jest.Mock<Promise<PersistNoteResult>, [PersistNoteInput]>;

function setupPersistMock(): {
  persistSpy: PersistSpy;
  usePersistNoteSpy: jest.SpyInstance<
    ReturnType<typeof persistModule.usePersistNote>,
    Parameters<typeof persistModule.usePersistNote>
  >;
} {
  const persistSpy = jest.fn(
    async (_input: PersistNoteInput): Promise<PersistNoteResult> => ({
      ok: true,
      note: {
        id: 'note-1',
        plant_id: 'plant-1',
        written_at: NOW,
        user_text: 'placeholder',
        llm_response: null,
        consult_status: 'ok',
      },
    }),
  ) as PersistSpy;
  const usePersistNoteSpy = jest
    .spyOn(persistModule, 'usePersistNote')
    .mockImplementation(() => ({
      persist: persistSpy,
      status: 'idle',
      error: null,
    }));
  return { persistSpy, usePersistNoteSpy };
}

async function flushMicrotasks() {
  await act(async () => {
    await new Promise((resolve) => setImmediate(resolve));
  });
}

/**
 * Locate the mounted AddNoteSheet and return its onSave / onCancel props.
 * Uses RNTL's `UNSAFE_root.findByType` (the underlying react-test-renderer
 * API) to find the AddNoteSheet element directly rather than walking the
 * rendered host-component tree.
 */
function getSheetProps(
  root: ReturnType<typeof render>['UNSAFE_root'],
): {
  onSave: (payload: AddNoteSavedPayload) => Promise<void> | void;
  onCancel: () => void;
} {
  const instance = root.findByType(AddNoteSheet);
  return instance.props as {
    onSave: (payload: AddNoteSavedPayload) => Promise<void> | void;
    onCancel: () => void;
  };
}

function queryAllSheets(
  root: ReturnType<typeof render>['UNSAFE_root'],
) {
  return root.findAllByType(AddNoteSheet);
}

// ─── Tests ─────────────────────────────────────────────────────────────

describe('PlantDetailRoute (E8-004)', () => {
  let persistSpy: PersistSpy;
  let usePersistNoteSpy: jest.SpyInstance<
    ReturnType<typeof persistModule.usePersistNote>,
    Parameters<typeof persistModule.usePersistNote>
  >;

  beforeEach(() => {
    mockedUseTheme.mockReturnValue(lightTheme);
    mockedEngine.mockReturnValue('water');
    mockedReduceMotion.mockReturnValue(false);
    mockedUseMarkWatered.mockReturnValue(makeMarkWateredMock());
    useColorSchemeMock.mockReturnValue('light');
    mockState.reduceMotion = false;
    mockReduceMotionListeners.length = 0;
    ({ persistSpy, usePersistNoteSpy } = setupPersistMock());
  });

  afterEach(async () => {
    await flushMicrotasks();
    jest.restoreAllMocks();
    mockedUseTheme.mockReset();
    mockedEngine.mockReset();
    mockedReduceMotion.mockReset();
    mockedUseMarkWatered.mockReset();
  });

  it('threads noteEnabled=true regardless of FEATURE_FLAGS — Add note button is in the tree', () => {
    // FEATURE_FLAGS.addNote stays `false` (locked by featureFlags.test.ts).
    // The route flips at the thread, not the constant.
    const { getByTestId, getByLabelText } = render(
      <PlantDetailRoute
        plant={makePlant()}
        heroPhotoUri={null}
        wateringEvents={[]}
        photos={[]}
        onMarkWatered={jest.fn()}
        onEditDetails={jest.fn()}
        nowMs={NOW}
        apiClient={makeApiClient()}
        testID="route"
      />,
    );
    expect(getByTestId('route-add-note')).toBeOnTheScreen();
    expect(getByLabelText('Add note')).toBeOnTheScreen();
  });

  it('AddNoteSheet is NOT mounted before the user taps Add note (Modal portal not in the tree while closed)', () => {
    const { UNSAFE_root } = render(
      <PlantDetailRoute
        plant={makePlant()}
        heroPhotoUri={null}
        wateringEvents={[]}
        photos={[]}
        onMarkWatered={jest.fn()}
        onEditDetails={jest.fn()}
        nowMs={NOW}
        apiClient={makeApiClient()}
        testID="route"
      />,
    );
    expect(queryAllSheets(UNSAFE_root)).toHaveLength(0);
  });

  it('tap "Add note" button → AddNoteSheet mounts', () => {
    const { getByTestId, UNSAFE_root } = render(
      <PlantDetailRoute
        plant={makePlant()}
        heroPhotoUri={null}
        wateringEvents={[]}
        photos={[]}
        onMarkWatered={jest.fn()}
        onEditDetails={jest.fn()}
        nowMs={NOW}
        apiClient={makeApiClient()}
        testID="route"
      />,
    );
    expect(queryAllSheets(UNSAFE_root)).toHaveLength(0);
    fireEvent.press(getByTestId('route-add-note'));
    expect(queryAllSheets(UNSAFE_root)).toHaveLength(1);
  });

  it('sheet onCancel → sheet closes (unmounted), no persist write fires', async () => {
    const { getByTestId, UNSAFE_root } = render(
      <PlantDetailRoute
        plant={makePlant()}
        heroPhotoUri={null}
        wateringEvents={[]}
        photos={[]}
        onMarkWatered={jest.fn()}
        onEditDetails={jest.fn()}
        nowMs={NOW}
        apiClient={makeApiClient()}
        testID="route"
      />,
    );
    fireEvent.press(getByTestId('route-add-note'));
    const { onCancel } = getSheetProps(UNSAFE_root);
    await act(async () => {
      onCancel();
    });
    expect(queryAllSheets(UNSAFE_root)).toHaveLength(0);
    expect(persistSpy).not.toHaveBeenCalled();
  });

  it('sheet onSave (ok recommendation) → persist fires once with the discriminated kind="ok" shape; sheet closes', async () => {
    const okPayload: AddNoteSavedPayload = {
      note: 'Leaves yellow at the edge.',
      llmResponse: {
        kind: 'recommendation',
        revised_interval_days: 9,
        reasoning: 'Wait three more days.',
        confidence: 86,
        source: 'paid_escalated',
        latency_ms: 1234,
      },
      timestamp: NOW,
      status: 'ok',
    };
    const { getByTestId, UNSAFE_root } = render(
      <PlantDetailRoute
        plant={makePlant()}
        heroPhotoUri={null}
        wateringEvents={[]}
        photos={[]}
        onMarkWatered={jest.fn()}
        onEditDetails={jest.fn()}
        nowMs={NOW}
        apiClient={makeApiClient()}
        testID="route"
      />,
    );
    fireEvent.press(getByTestId('route-add-note'));
    const { onSave } = getSheetProps(UNSAFE_root);
    await act(async () => {
      await onSave(okPayload);
    });
    expect(persistSpy).toHaveBeenCalledTimes(1);
    expect(persistSpy).toHaveBeenCalledWith({
      note: okPayload.note,
      llmResponse: okPayload.llmResponse,
      kind: 'ok',
      timestamp: NOW,
    });
    expect(queryAllSheets(UNSAFE_root)).toHaveLength(0);
  });

  it('sheet onSave (queued) → persist fires with kind="queued" and llmResponse=null; sheet closes', async () => {
    const queuedPayload: AddNoteSavedPayload = {
      note: 'Browning lower leaves, only one watering this week.',
      llmResponse: null,
      timestamp: NOW + 7,
      status: 'queued',
    };
    const { getByTestId, UNSAFE_root } = render(
      <PlantDetailRoute
        plant={makePlant()}
        heroPhotoUri={null}
        wateringEvents={[]}
        photos={[]}
        onMarkWatered={jest.fn()}
        onEditDetails={jest.fn()}
        nowMs={NOW}
        apiClient={makeApiClient()}
        testID="route"
      />,
    );
    fireEvent.press(getByTestId('route-add-note'));
    const { onSave } = getSheetProps(UNSAFE_root);
    await act(async () => {
      await onSave(queuedPayload);
    });
    expect(persistSpy).toHaveBeenCalledTimes(1);
    expect(persistSpy).toHaveBeenCalledWith({
      note: queuedPayload.note,
      llmResponse: null,
      kind: 'queued',
      timestamp: queuedPayload.timestamp,
    });
    expect(queryAllSheets(UNSAFE_root)).toHaveLength(0);
  });

  it('usePersistNote is bound to the plant the user opened (plant.id captured at the route layer)', () => {
    render(
      <PlantDetailRoute
        plant={makePlant({ id: 'plant-xyz' })}
        heroPhotoUri={null}
        wateringEvents={[]}
        photos={[]}
        onMarkWatered={jest.fn()}
        onEditDetails={jest.fn()}
        nowMs={NOW}
        apiClient={makeApiClient()}
        testID="route"
      />,
    );
    // The hook is invoked with the plant id from props on every render.
    // Asserting the latest call (covers StrictMode double-renders).
    const calls = usePersistNoteSpy.mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls[calls.length - 1]?.[0]).toBe('plant-xyz');
  });

  it('Strict-mode + double onSave: only one persist call fires per user-perceived save (handleSave session-id latch)', async () => {
    // Codex P3 fix: the original strict-mode test only invoked onSave
    // once, so it would pass even without the wrapper's double-save
    // guard. This test fires onSave TWICE within the same act() — only
    // the first should reach `persist`, because the wrapper's
    // session-id ref (sessionPlantIdRef) clears synchronously on the
    // first call and the second invocation hits the `sessionId !==
    // plant.id` early-return.
    const okPayload: AddNoteSavedPayload = {
      note: 'Double-save guard test note.',
      llmResponse: {
        kind: 'recommendation',
        revised_interval_days: 7,
        reasoning: 'fine',
        confidence: 80,
        source: 'free',
        latency_ms: 100,
      },
      timestamp: NOW,
      status: 'ok',
    };
    const { getByTestId, UNSAFE_root } = render(
      <React.StrictMode>
        <PlantDetailRoute
          plant={makePlant()}
          heroPhotoUri={null}
          wateringEvents={[]}
          photos={[]}
          onMarkWatered={jest.fn()}
          onEditDetails={jest.fn()}
          nowMs={NOW}
          apiClient={makeApiClient()}
          testID="route"
        />
      </React.StrictMode>,
    );
    fireEvent.press(getByTestId('route-add-note'));
    const { onSave } = getSheetProps(UNSAFE_root);
    await act(async () => {
      // Two synchronous onSave calls in the same tick. The wrapper must
      // collapse them to a single persist.
      await Promise.all([onSave(okPayload), onSave(okPayload)]);
    });
    expect(persistSpy).toHaveBeenCalledTimes(1);
  });

  it('Strict-mode double-mount: only one AddNoteSheet in the tree, only one persist call per save', async () => {
    const okPayload: AddNoteSavedPayload = {
      note: 'Strict-mode test note.',
      llmResponse: {
        kind: 'recommendation',
        revised_interval_days: 7,
        reasoning: 'fine',
        confidence: 80,
        source: 'free',
        latency_ms: 100,
      },
      timestamp: NOW,
      status: 'ok',
    };
    const { getByTestId, UNSAFE_root } = render(
      <React.StrictMode>
        <PlantDetailRoute
          plant={makePlant()}
          heroPhotoUri={null}
          wateringEvents={[]}
          photos={[]}
          onMarkWatered={jest.fn()}
          onEditDetails={jest.fn()}
          nowMs={NOW}
          apiClient={makeApiClient()}
          testID="route"
        />
      </React.StrictMode>,
    );
    fireEvent.press(getByTestId('route-add-note'));
    // Even under StrictMode, exactly one AddNoteSheet element is in the
    // tree (single state, single Modal portal).
    expect(queryAllSheets(UNSAFE_root)).toHaveLength(1);
    const { onSave } = getSheetProps(UNSAFE_root);
    await act(async () => {
      await onSave(okPayload);
    });
    expect(persistSpy).toHaveBeenCalledTimes(1);
  });

  it('dark mode: route mounts AddNoteSheet under the dark theme without stripping tokens', () => {
    mockedUseTheme.mockReturnValue(darkTheme);
    useColorSchemeMock.mockReturnValue('dark');
    const { getByTestId, UNSAFE_root } = render(
      <PlantDetailRoute
        plant={makePlant()}
        heroPhotoUri={null}
        wateringEvents={[]}
        photos={[]}
        onMarkWatered={jest.fn()}
        onEditDetails={jest.fn()}
        nowMs={NOW}
        apiClient={makeApiClient()}
        testID="route"
      />,
    );
    fireEvent.press(getByTestId('route-add-note'));
    // Sheet mounted under dark theme. The token verification (scrim,
    // surface, text) lives in EditorialBottomSheet.dark.test.tsx and the
    // ComponentGardenScreen.dark suite (E10-001 manifest parity); the
    // wrapper's contract is "compose path doesn't strip the theme",
    // verified by mounting and confirming the sheet is present.
    const sheets = queryAllSheets(UNSAFE_root);
    expect(sheets).toHaveLength(1);
  });

  it('reduce-motion ON: AddNoteSheet open does not fire Animated.timing for entry transition', async () => {
    mockedReduceMotion.mockReturnValue(true);
    mockState.reduceMotion = true;
    const timingSpy = jest.spyOn(Animated, 'timing');
    const { getByTestId } = render(
      <PlantDetailRoute
        plant={makePlant()}
        heroPhotoUri={null}
        wateringEvents={[]}
        photos={[]}
        onMarkWatered={jest.fn()}
        onEditDetails={jest.fn()}
        nowMs={NOW}
        apiClient={makeApiClient()}
        testID="route"
      />,
    );
    timingSpy.mockClear();
    fireEvent.press(getByTestId('route-add-note'));
    await flushMicrotasks();
    // Under reduce-motion, EditorialBottomSheet flips Modal's
    // `animationType` to 'none' (E2-011 contract) and skips the slide-in
    // Animated.timing. Per-primitive coverage lives in
    // EditorialBottomSheet.test.tsx; this assertion locks the wrapper's
    // compose path doesn't accidentally bypass that gate.
    expect(timingSpy).not.toHaveBeenCalled();
  });

  it('codex P2 — wrapper unmount before onSave resolves does NOT issue a zombie persist (mountedRef guard)', async () => {
    const okPayload: AddNoteSavedPayload = {
      note: 'Unmount guard test.',
      llmResponse: {
        kind: 'recommendation',
        revised_interval_days: 7,
        reasoning: 'fine',
        confidence: 80,
        source: 'free',
        latency_ms: 100,
      },
      timestamp: NOW,
      status: 'ok',
    };
    const { getByTestId, UNSAFE_root, unmount } = render(
      <PlantDetailRoute
        plant={makePlant()}
        heroPhotoUri={null}
        wateringEvents={[]}
        photos={[]}
        onMarkWatered={jest.fn()}
        onEditDetails={jest.fn()}
        nowMs={NOW}
        apiClient={makeApiClient()}
        testID="route"
      />,
    );
    fireEvent.press(getByTestId('route-add-note'));
    const { onSave } = getSheetProps(UNSAFE_root);
    // Tear down the route BEFORE onSave fires (simulates the user
    // navigating back from the detail screen while the offline / queued
    // consult is still in flight).
    unmount();
    await act(async () => {
      // Sheet's queued path resolves AFTER unmount and fires onSave from
      // its post-await branch. The wrapper's mountedRef guard skips the
      // persist — no zombie row.
      await onSave(okPayload);
    });
    expect(persistSpy).not.toHaveBeenCalled();
  });

  it('codex P2 — plant id swap mid-flow refuses persist (sessionPlantIdRef guard)', async () => {
    const okPayload: AddNoteSavedPayload = {
      note: 'A note about plant A.',
      llmResponse: {
        kind: 'recommendation',
        revised_interval_days: 7,
        reasoning: 'fine',
        confidence: 80,
        source: 'free',
        latency_ms: 100,
      },
      timestamp: NOW,
      status: 'ok',
    };
    // Mount with plant A; open the sheet; then re-render the SAME route
    // with a different plant id (a future detail-pager that swaps
    // siblings without remount). Without the session-id guard, the
    // wrapper's persist would target plant B's row even though the note
    // was composed for plant A.
    const { getByTestId, UNSAFE_root, rerender } = render(
      <PlantDetailRoute
        plant={makePlant({ id: 'plant-a' })}
        heroPhotoUri={null}
        wateringEvents={[]}
        photos={[]}
        onMarkWatered={jest.fn()}
        onEditDetails={jest.fn()}
        nowMs={NOW}
        apiClient={makeApiClient()}
        testID="route"
      />,
    );
    fireEvent.press(getByTestId('route-add-note'));
    rerender(
      <PlantDetailRoute
        plant={makePlant({ id: 'plant-b' })}
        heroPhotoUri={null}
        wateringEvents={[]}
        photos={[]}
        onMarkWatered={jest.fn()}
        onEditDetails={jest.fn()}
        nowMs={NOW}
        apiClient={makeApiClient()}
        testID="route"
      />,
    );
    const { onSave } = getSheetProps(UNSAFE_root);
    await act(async () => {
      await onSave(okPayload);
    });
    // Persist was REFUSED — sessionId captured at open was 'plant-a',
    // current plant.id at save is 'plant-b'. Refusal is the safe default;
    // a write to the wrong plant is the worse failure mode.
    expect(persistSpy).not.toHaveBeenCalled();
  });

  it('forwards all non-flag, non-AddNote props unchanged (no accidental prop munging at the seam)', () => {
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
        apiClient={makeApiClient()}
        testID="route"
      />,
    );
    expect(getByTestId('route-header').props.accessibilityLabel).toContain(
      'Steve',
    );
    expect(getByTestId('route-header').props.accessibilityLabel).toContain(
      '2 days ago',
    );
    fireEvent.press(getByTestId('route-edit-details'));
    expect(onEditDetails).toHaveBeenCalledTimes(1);
  });
});
