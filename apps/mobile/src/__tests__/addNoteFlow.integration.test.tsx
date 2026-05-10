/**
 * E8-006 — Add-note flow integration tests.
 *
 * Exercises the real composition of AddNoteSheet (E8-003) →
 * AddNoteSavedPayload → usePersistNote (E8-005) → SQLite notes table
 * end-to-end. Mocks live at the module-boundary level only — the api client
 * (consult fn), useColorScheme, and the in-process AccessibilityInfo bridge
 * that backs useReduceMotion. The components themselves are real, so every
 * flow walks the actual render tree, the useConsultRequest hook, the
 * EditorialBottomSheet primitive, the payloadToPersistInput mapper, and the
 * real createNotesApi SQL writer.
 *
 * This is NOT a unit-test sweep of either surface (those live next to their
 * sources at components/__tests__/AddNoteSheet.test.tsx and
 * hooks/__tests__/usePersistNote.test.tsx). Those existing tests assert
 * per-component contract; this file asserts the wiring across the sheet →
 * persist boundary — payload shape match, the locked Done-after-recommendation
 * persistence gate (codex P2 catch from E8-003), the discriminated-union
 * sweep with every kind preserved end-to-end, the Strict-mode + reduce-motion
 * + cancel reliability locks established by E5-012 / E9-004 / E9-003, and
 * the in-memory SQLite write verification (mirrors the convention in
 * apps/mobile/src/sync/__tests__/queueCrud.test.ts).
 *
 * Scope (V1 lock):
 *   - No new test runner / library — jest + RTL + jest-expo + better-sqlite3.
 *   - No deletion or compression of existing tests in
 *     AddNoteSheet.test.tsx or usePersistNote.test.tsx.
 *   - The discriminated union ApiResult<ConsultResponse> is NEVER collapsed
 *     in any assertion — every locked kind from API_ERROR_KINDS (network,
 *     timeout, server, layer1_reject, low_confidence, parse_error, queued)
 *     renders a distinct UI surface with its own testID. The success path
 *     adds an 8th case so a future kind addition that accidentally
 *     collapses surfaces fails this test.
 *   - The network kind is hook-coerced to queued for V1 offline UX (master
 *     plan, line 346 — useConsultRequest:216-219). The kind survives on
 *     the union; the integration assertion is that an api-client network
 *     result surfaces as the queued UI, not as a separate network card.
 *     The network testID NEVER renders today — a future de-coercion would
 *     surface it; the discriminated-union sweep pins both branches.
 *   - No date-fns / dayjs / luxon. UTC ms only.
 *   - No reaching into the api-client internals — only its module export
 *     is mocked.
 *
 * Test file location: apps/mobile/src/__tests__/addNoteFlow.integration.test.tsx
 * (mirrors the cameraFlow.integration.test.tsx naming convention from
 * E5-012). Cross-component integration coverage in a top-level __tests__/
 * — not under any single component's __tests__/ folder — because it spans
 * the AddNoteSheet composite + EditorialBottomSheet primitive +
 * useConsultRequest hook + usePersistNote hook + the real createNotesApi
 * SQL writer.
 */

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import Database from 'better-sqlite3';
import React from 'react';
import { Animated } from 'react-native';

import type { ApiClient, ApiResult, ConsultResponse } from '../api';
import { AddNoteSheet, type AddNoteSavedPayload } from '../components/AddNoteSheet';
import { runMigrations } from '../db/migrations';
import { createNotesApi, type NotesApi } from '../db/notes';
import {
  _resetNoteListenersForTests,
  payloadToPersistInput,
  subscribeToNoteEvents,
  usePersistNote,
} from '../hooks/usePersistNote';
import type { PlantsExecutor, SqlBindValue } from '../hooks/usePlants';
import type { Note } from '../db/types';

// Module mocks --------------------------------------------------------

jest.mock('react-native/Libraries/Utilities/useColorScheme', () => ({
  __esModule: true,
  default: jest.fn(() => 'light'),
}));

const mockReduceMotionListeners: Array<(value: boolean) => void> = [];
const mockState = { reduceMotion: false };

jest.mock('react-native/Libraries/Components/AccessibilityInfo/AccessibilityInfo', () => ({
  __esModule: true,
  default: {
    isReduceMotionEnabled: jest.fn(() => Promise.resolve(mockState.reduceMotion)),
    addEventListener: jest.fn((event: string, listener: (v: boolean) => void) => {
      if (event === 'reduceMotionChanged') mockReduceMotionListeners.push(listener);
      return {
        remove: () => {
          const idx = mockReduceMotionListeners.indexOf(listener);
          if (idx >= 0) mockReduceMotionListeners.splice(idx, 1);
        },
      };
    }),
  },
}));

// Helpers ------------------------------------------------------------

const RECOMMENDATION: ConsultResponse = {
  kind: 'recommendation',
  revised_interval_days: 9,
  reasoning: 'Hold off another 3 days — the soil is still wet from last week.',
  confidence: 86,
  source: 'paid_escalated',
  latency_ms: 1234,
};

function makeClient(
  consultImpl: () => Promise<ApiResult<ConsultResponse>>,
): { client: ApiClient; consultSpy: jest.Mock } {
  const consultSpy = jest.fn(consultImpl as never);
  const client: ApiClient = {
    identify: jest.fn() as never,
    diagnose: jest.fn() as never,
    consult: consultSpy as never,
    review: jest.fn() as never,
    weather: jest.fn() as never,
  };
  return { client, consultSpy };
}

function makeAdapter(db: Database.Database): PlantsExecutor {
  return {
    async runAsync(source: string, params: SqlBindValue[]) {
      db.prepare(source).run(...params);
    },
    async getFirstAsync<T>(source: string, params: SqlBindValue[]): Promise<T | null> {
      const row = db.prepare(source).get(...params) as T | undefined;
      return row ?? null;
    },
    async getAllAsync<T>(source: string, params: SqlBindValue[]): Promise<T[]> {
      return db.prepare(source).all(...params) as T[];
    },
  };
}

function makeMigrationAdapter(db: Database.Database) {
  return {
    async execAsync(source: string) {
      db.exec(source);
    },
    async getFirstAsync<T>(source: string): Promise<T | null> {
      const row = db.prepare(source).get() as T | undefined;
      return row ?? null;
    },
    async withTransactionAsync(task: () => Promise<void>) {
      db.exec('BEGIN');
      try {
        await task();
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
  };
}

type Harness = {
  raw: Database.Database;
  notesApi: NotesApi;
  txWrap: (task: () => Promise<void>) => Promise<void>;
  plantId: string;
};

async function setupHarness(): Promise<Harness> {
  const raw = new Database(':memory:');
  raw.exec('PRAGMA foreign_keys = ON');
  await runMigrations(makeMigrationAdapter(raw));
  const plantId = 'plant-1';
  raw
    .prepare(
      "INSERT INTO plants (id, species_slug, added_at, is_indoor) VALUES (?, 'pothos', 1000, 1)",
    )
    .run(plantId);
  const notesApi = createNotesApi(makeAdapter(raw));
  const txWrap = async (task: () => Promise<void>) => {
    raw.exec('BEGIN');
    try {
      await task();
      raw.exec('COMMIT');
    } catch (err) {
      raw.exec('ROLLBACK');
      throw err;
    }
  };
  return { raw, notesApi, txWrap, plantId };
}

async function flushMicrotasks() {
  await act(async () => {
    await new Promise((resolve) => setImmediate(resolve));
  });
}

/**
 * Tiny host that wires AddNoteSheet → usePersistNote the way the
 * production PlantDetailScreen will (E8-004). State machine: the sheet is
 * always mounted while open=true; on onSave, the host invokes
 * persist(payloadToPersistInput(payload)) and records the result. After
 * a successful persist, the host flips open=false, mirroring the
 * "parent decides what to do" contract from the AddNoteSheet header.
 *
 * Records every emitted persist outcome so tests can assert SQLite writes
 * happened (or didn't), without reaching into the hook's internals.
 */
type FlowProps = {
  apiClient: ApiClient;
  harness: Harness;
  netInfo?: { isConnected: () => boolean | Promise<boolean> };
  initialOpen?: boolean;
  onPersisted?: (note: Note | null) => void;
  /**
   * When true, the host KEEPS the sheet open after onSave (instead of
   * mirroring the production close-after-save contract). The
   * discriminated-union sweep needs the sheet to stay mounted across the
   * queued / network-coerced kinds so the queued UI surface is observable.
   * Production hosts (PlantDetailScreen / E8-004) close on save; tests that
   * only need to observe the inflight UI flip this off.
   */
  keepOpenAfterSave?: boolean;
};

function NoteFlow({
  apiClient,
  harness,
  netInfo = { isConnected: () => true },
  initialOpen = true,
  onPersisted,
  keepOpenAfterSave = false,
}: FlowProps): React.ReactElement {
  const [open, setOpen] = React.useState(initialOpen);

  const { persist } = usePersistNote(harness.plantId, {
    notesApi: harness.notesApi,
    txWrap: harness.txWrap,
    // Photo writes aren't exercised by AddNoteSheet today; the sheet's
    // AddNoteSavedPayload has no photoUri. A future "attach a photo"
    // extension would land via E8-007 / similar; this test only covers the
    // text-note path that shipped.
    insertPhotoFn: jest.fn(async () => undefined),
  });

  const handleCancel = React.useCallback(() => {
    setOpen(false);
  }, []);

  const handleSave = React.useCallback(
    async (payload: AddNoteSavedPayload) => {
      const outcome = await persist(payloadToPersistInput(payload));
      onPersisted?.(outcome.ok ? outcome.note : null);
      // Mirror the production close-after-save contract — the sheet's
      // header documents "After onSave fires, the parent should set
      // open=false". This matches the codex P2 fix from E8-003: the user
      // already tapped Done, so the sheet closes here. Tests that need to
      // observe the post-save UI surface (the discriminated-union sweep)
      // pass keepOpenAfterSave=true.
      if (!keepOpenAfterSave) setOpen(false);
    },
    [keepOpenAfterSave, onPersisted, persist],
  );

  return (
    <AddNoteSheet
      open={open}
      onSave={handleSave}
      onCancel={handleCancel}
      apiClient={apiClient}
      plantNickname="Steve"
      netInfo={netInfo}
      testID="add-note-sheet"
    />
  );
}

// Tests --------------------------------------------------------------

describe('Add-note flow integration', () => {
  beforeEach(() => {
    mockState.reduceMotion = false;
    mockReduceMotionListeners.length = 0;
    _resetNoteListenersForTests();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const useColorSchemeMock = require('react-native/Libraries/Utilities/useColorScheme')
      .default as jest.Mock<'light' | 'dark' | null | undefined, []>;
    useColorSchemeMock.mockReturnValue('light');
  });

  afterEach(async () => {
    await act(async () => {
      await new Promise((resolve) => setImmediate(resolve));
    });
  });

  // Save & ask returns LLM rec → Done persists --------------------

  it('save & analyze returns recommendation: consult fires once → recommendation card with reasoning + Done CTA, NOT auto-persisted', async () => {
    // Codex P2 lock from E8-003: the user must read the recommendation
    // before save. Done CTA gates persistence — Save & analyze alone does
    // NOT write to SQLite.
    const harness = await setupHarness();
    const { client, consultSpy } = makeClient(async () => ({ ok: true, data: RECOMMENDATION }));
    const onPersisted = jest.fn();

    render(<NoteFlow apiClient={client} harness={harness} onPersisted={onPersisted} />);

    fireEvent.changeText(
      screen.getByTestId('add-note-sheet-input'),
      'Just repotted into a 6 inch terracotta',
    );
    await act(async () => {
      fireEvent.press(screen.getByTestId('add-note-sheet-save'));
      await flushMicrotasks();
    });

    // Consult fired exactly once.
    expect(consultSpy).toHaveBeenCalledTimes(1);
    // Recommendation phase mounted — reasoning visible, Done present.
    expect(screen.getByTestId('add-note-sheet-recommendation')).toBeOnTheScreen();
    expect(screen.getByText(RECOMMENDATION.reasoning)).toBeOnTheScreen();
    expect(screen.getByTestId('add-note-sheet-recommendation-done')).toBeOnTheScreen();
    // No SQLite write yet — the user must tap Done.
    expect(onPersisted).not.toHaveBeenCalled();
    const beforeRow = harness.raw
      .prepare('SELECT count(*) AS c FROM notes')
      .get() as { c: number };
    expect(beforeRow.c).toBe(0);
  });

  // Persist on Save (post-recommendation Done) ------------------------

  it('Done after recommendation: persists a row to the notes table with the LLM response stored verbatim', async () => {
    // The contract that connects E8-003 → E8-005: AddNoteSavedPayload flows
    // through payloadToPersistInput to notesApi.addNote to a SQLite INSERT.
    // Verify the row landed AND the subscribeToNoteEvents bus emitted (the
    // cross-component observability path that future PhotoTimeline +
    // note-history compositions consume).
    const harness = await setupHarness();
    const { client } = makeClient(async () => ({ ok: true, data: RECOMMENDATION }));
    const onPersisted = jest.fn();
    const noteEvents: Note[] = [];
    subscribeToNoteEvents(harness.plantId, (n) => noteEvents.push(n));

    render(<NoteFlow apiClient={client} harness={harness} onPersisted={onPersisted} />);

    fireEvent.changeText(
      screen.getByTestId('add-note-sheet-input'),
      'Repotted Steve into a bigger pot',
    );
    await act(async () => {
      fireEvent.press(screen.getByTestId('add-note-sheet-save'));
      await flushMicrotasks();
    });
    await act(async () => {
      fireEvent.press(screen.getByTestId('add-note-sheet-recommendation-done'));
      await flushMicrotasks();
    });

    expect(onPersisted).toHaveBeenCalledTimes(1);

    // SQLite row landed with the user's note + the LLM response stored verbatim.
    const rows = harness.raw
      .prepare('SELECT * FROM notes WHERE plant_id = ?')
      .all(harness.plantId) as Array<{
      user_text: string;
      consult_status: string;
      llm_response: string | null;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.user_text).toBe('Repotted Steve into a bigger pot');
    expect(rows[0]?.consult_status).toBe('ok');
    // LLM response is JSON-stringified by addNote — round-trip the kind.
    const parsed = JSON.parse(rows[0]?.llm_response ?? 'null') as { kind: string };
    expect(parsed.kind).toBe('recommendation');

    // Cross-component observability: the note-saved event fired for this plant.
    expect(noteEvents).toHaveLength(1);
    expect(noteEvents[0]?.user_text).toBe('Repotted Steve into a bigger pot');
  });

  // Off-topic Layer-1 reject ----------------------------------------

  it('layer1_reject: reject card surfaces with editorial copy; Save CTA is hidden so off-topic notes can NOT persist', async () => {
    // Even if a user wanted to bypass and tap Save again, the reject card
    // does not render the original Save CTA — only Try again + Cancel —
    // so off-topic content never reaches SQLite.
    const harness = await setupHarness();
    const { client } = makeClient(async () => ({
      ok: false,
      kind: 'layer1_reject',
      message: 'off-topic',
    }));
    const onPersisted = jest.fn();

    render(<NoteFlow apiClient={client} harness={harness} onPersisted={onPersisted} />);

    fireEvent.changeText(screen.getByTestId('add-note-sheet-input'), 'best pasta recipe');
    await act(async () => {
      fireEvent.press(screen.getByTestId('add-note-sheet-save'));
      await flushMicrotasks();
    });

    const reject = screen.getByTestId('add-note-sheet-reject');
    expect(reject).toBeOnTheScreen();
    // Cite the existing variant copy to prove we're rendering the locked
    // reject path (AddNoteSheet RejectCard at component:665-668).
    expect(screen.getByText(/keep this about your plants/i)).toBeOnTheScreen();
    expect(screen.getByText(/focused on plant care/i)).toBeOnTheScreen();
    // Save CTA is hidden on the reject path — no path to persist.
    expect(screen.queryByTestId('add-note-sheet-save')).toBeNull();
    expect(screen.queryByTestId('add-note-sheet-recommendation-done')).toBeNull();
    expect(onPersisted).not.toHaveBeenCalled();

    // No row landed in SQLite.
    const row = harness.raw.prepare('SELECT count(*) AS c FROM notes').get() as { c: number };
    expect(row.c).toBe(0);
  });

  // Strict-mode latch ------------------------------------------------

  it('strict-mode double-mount: consult fires exactly once on Save (matches the E5-012 / E9-004 latch contract)', async () => {
    // The latch on AddNoteSheet inFlightRef is per-press, not per-mount.
    // Render under React.StrictMode so dev double-invocation runs effects
    // and renders twice — the consult should still fire exactly once.
    const harness = await setupHarness();
    const { client, consultSpy } = makeClient(async () => ({ ok: true, data: RECOMMENDATION }));

    render(
      <React.StrictMode>
        <NoteFlow apiClient={client} harness={harness} />
      </React.StrictMode>,
    );

    fireEvent.changeText(screen.getByTestId('add-note-sheet-input'), 'Just repotted');
    await act(async () => {
      fireEvent.press(screen.getByTestId('add-note-sheet-save'));
      await flushMicrotasks();
    });

    await waitFor(() =>
      expect(screen.getByTestId('add-note-sheet-recommendation')).toBeOnTheScreen(),
    );
    expect(consultSpy).toHaveBeenCalledTimes(1);
  });

  it('strict-mode double-mount: subscribeToNoteEvents bus emits exactly once per save (no leaked duplicate subscription under double-mount)', async () => {
    // Codex catch (E8-006 medium): the strict-mode latch tests assert
    // `consultSpy` count, but the OTHER strict-mode safety claim sits on
    // the module-scoped `NOTE_LISTENERS_BY_PLANT` Map (usePersistNote:118)
    // — the one that drives PhotoTimeline / note-history observability
    // in future compositions. Verify a subscriber mounted under
    // React.StrictMode receives exactly one event per save: a leaked
    // double-subscription would surface as 2 events, a torn subscription
    // would surface as 0.
    const harness = await setupHarness();
    const { client } = makeClient(async () => ({ ok: true, data: RECOMMENDATION }));
    const events: Note[] = [];

    function Subscriber() {
      React.useEffect(() => {
        return subscribeToNoteEvents(harness.plantId, (n) => events.push(n));
      }, []);
      return null;
    }

    render(
      <React.StrictMode>
        <Subscriber />
        <NoteFlow apiClient={client} harness={harness} />
      </React.StrictMode>,
    );

    fireEvent.changeText(screen.getByTestId('add-note-sheet-input'), 'Just repotted');
    await act(async () => {
      fireEvent.press(screen.getByTestId('add-note-sheet-save'));
      await flushMicrotasks();
    });
    await act(async () => {
      fireEvent.press(screen.getByTestId('add-note-sheet-recommendation-done'));
      await flushMicrotasks();
    });

    // Exactly one event — the subscribe / unsubscribe pair under strict
    // mode nets to a single registered listener (usePersistNote:127-129).
    expect(events).toHaveLength(1);
    expect(events[0]?.user_text).toBe('Just repotted');
  });

  it('strict-mode double-mount: a synchronous double-press of Save still fires consult exactly once', async () => {
    // Two press events in the same tick that both pass the disabled check.
    // inFlightRef debounces synchronous double-taps per the AddNoteSheet
    // header (component:64-69).
    const harness = await setupHarness();
    const { client, consultSpy } = makeClient(async () => ({ ok: true, data: RECOMMENDATION }));

    render(
      <React.StrictMode>
        <NoteFlow apiClient={client} harness={harness} />
      </React.StrictMode>,
    );

    fireEvent.changeText(screen.getByTestId('add-note-sheet-input'), 'Just repotted');
    await act(async () => {
      fireEvent.press(screen.getByTestId('add-note-sheet-save'));
      fireEvent.press(screen.getByTestId('add-note-sheet-save'));
      await flushMicrotasks();
    });

    expect(consultSpy).toHaveBeenCalledTimes(1);
  });

  // Reduce-motion ----------------------------------------------------

  it('reduce-motion: loading dot is static (no spinner) AND no Animated.timing fires across the recommendation reveal', async () => {
    // Same canonical pattern as E9-003 / E7-005 / E5-012 — under reduce
    // motion, surfaces initialize at the end-state with no Animated.timing
    // fired. AddNoteSheet's loading row swaps spinner→static dot directly
    // (no Animated.Value); we assert that AND that no Animated.timing is
    // invoked across the loading→recommendation transition. The
    // EditorialBottomSheet reduce-motion branch (E2-011 lock) sets the
    // translation directly via setValue rather than timing.
    mockState.reduceMotion = true;
    const timingSpy = jest.spyOn(Animated, 'timing');
    timingSpy.mockClear();

    const harness = await setupHarness();
    let resolveConsult: (r: ApiResult<ConsultResponse>) => void = () => {};
    const pending = new Promise<ApiResult<ConsultResponse>>((r) => {
      resolveConsult = r;
    });
    const { client } = makeClient(() => pending);

    render(<NoteFlow apiClient={client} harness={harness} />);
    // Drain the AccessibilityInfo mount-time effect so reduceMotion=true.
    await flushMicrotasks();

    fireEvent.changeText(screen.getByTestId('add-note-sheet-input'), 'Just repotted');
    await act(async () => {
      fireEvent.press(screen.getByTestId('add-note-sheet-save'));
      await flushMicrotasks();
    });

    // Loading: the static dot replaces the spinner per AddNoteSheet:549-560.
    await waitFor(() =>
      expect(screen.getByTestId('add-note-sheet-loading-static')).toBeOnTheScreen(),
    );
    expect(screen.queryByTestId('add-note-sheet-loading-spinner')).toBeNull();
    // No Animated.timing fired across the entry of the loading phase.
    expect(timingSpy).not.toHaveBeenCalled();

    // Resolve consult → recommendation phase mounts. Still no Animated.timing.
    await act(async () => {
      resolveConsult({ ok: true, data: RECOMMENDATION });
      await flushMicrotasks();
    });
    await waitFor(() =>
      expect(screen.getByTestId('add-note-sheet-recommendation')).toBeOnTheScreen(),
    );
    expect(timingSpy).not.toHaveBeenCalled();

    // Codex catch (E8-006 medium): also assert the EditorialBottomSheet's
    // translateY Animated.Value is at the end-state (0) under reduce
    // motion. The primitive's reduce-motion branch (EditorialBottomSheet:
    // 158-159, 194) sets translateY directly via setValue(0) and switches
    // Modal animationType to 'none'. A regression that initialized
    // offscreen (e.g. translateY=200) and snapped via effect would still
    // satisfy "no Animated.timing fired" — this assertion pins the actual
    // end-state value. Mirrors the cameraFlow integration test pattern at
    // cameraFlow.integration.test.tsx:699-712.
    const sheet = screen.getByTestId('add-note-sheet-sheet');
    const flat: Array<Record<string, unknown> | undefined> = Array.isArray(sheet.props.style)
      ? sheet.props.style.flat()
      : [sheet.props.style];
    const transform = flat
      .map((s) => (s as { transform?: unknown } | undefined)?.transform)
      .find((v) => v !== undefined) as Array<Record<string, unknown>> | undefined;
    expect(transform).toBeDefined();
    const translateY = transform?.find(
      (entry) => (entry as { translateY?: unknown }).translateY !== undefined,
    ) as { translateY?: { _value?: number } | number } | undefined;
    const tyVal = translateY?.translateY;
    const numericTy = typeof tyVal === 'number' ? tyVal : tyVal?._value;
    expect(numericTy).toBe(0);

    timingSpy.mockRestore();
  });

  // Discriminated-union sweep ----------------------------------------

  it('discriminated-union sweep: every locked ApiResult kind renders the documented UI surface (network coerces to queued, others render distinct)', async () => {
    // The 7 locked client kinds from API_ERROR_KINDS plus the success path.
    // Each kind renders the documented testID → a future kind addition
    // that accidentally collapses two distinct surfaces (e.g. lumping
    // low_confidence into reject) trips this test immediately.
    //
    // Codex catch (E8-006 medium): network and queued share the queued
    // UI surface BY DESIGN under V1's offline-coercion lock — master plan
    // line 346, useConsultRequest:216-219. The integration assertion is
    // therefore: api-client network → queued UI; the network testID
    // NEVER renders today. A future de-coercion would surface the
    // network UI; this test pins the current behavior so the de-coercion
    // has to be a documented unlock rather than a silent drift. The
    // sibling assertion (`forbiddenTestIds` includes the network testID
    // on every case) pins the no-leak.
    //
    // For each kind that AUTO-FIRES onSave (queued — and network via
    // coercion), we additionally assert onSave was invoked with the
    // expected `status='queued'` payload. This proves the queued path is
    // observable end-to-end without relying on the keepOpenAfterSave
    // host shortcut alone (codex P4 catch).
    const cases: Array<{
      label: string;
      result: ApiResult<ConsultResponse>;
      expectedTestId: string;
      forbiddenTestIds: readonly string[];
      /** True for kinds that auto-fire onSave from the press handler. */
      autoFiresOnSave: boolean;
    }> = [
      {
        label: 'success → recommendation',
        result: { ok: true, data: RECOMMENDATION },
        expectedTestId: 'add-note-sheet-recommendation',
        forbiddenTestIds: [
          'add-note-sheet-reject',
          'add-note-sheet-low-confidence',
          'add-note-sheet-error-timeout',
          'add-note-sheet-error-server',
          'add-note-sheet-error-parse_error',
          'add-note-sheet-queued',
        ],
        autoFiresOnSave: false,
      },
      {
        label: 'network → queued (hook coercion)',
        result: { ok: false, kind: 'network' },
        expectedTestId: 'add-note-sheet-queued',
        forbiddenTestIds: [
          'add-note-sheet-recommendation',
          'add-note-sheet-error-timeout',
          'add-note-sheet-error-server',
          'add-note-sheet-error-parse_error',
          'add-note-sheet-reject',
          'add-note-sheet-low-confidence',
        ],
        autoFiresOnSave: true,
      },
      {
        label: 'timeout',
        result: { ok: false, kind: 'timeout' },
        expectedTestId: 'add-note-sheet-error-timeout',
        forbiddenTestIds: [
          'add-note-sheet-error-server',
          'add-note-sheet-error-parse_error',
          'add-note-sheet-reject',
          'add-note-sheet-low-confidence',
          'add-note-sheet-queued',
          'add-note-sheet-recommendation',
        ],
        autoFiresOnSave: false,
      },
      {
        label: 'server',
        result: { ok: false, kind: 'server', retry_after: 30 },
        expectedTestId: 'add-note-sheet-error-server',
        forbiddenTestIds: [
          'add-note-sheet-error-timeout',
          'add-note-sheet-error-parse_error',
          'add-note-sheet-reject',
          'add-note-sheet-low-confidence',
          'add-note-sheet-queued',
          'add-note-sheet-recommendation',
        ],
        autoFiresOnSave: false,
      },
      {
        label: 'layer1_reject',
        result: { ok: false, kind: 'layer1_reject' },
        expectedTestId: 'add-note-sheet-reject',
        forbiddenTestIds: [
          'add-note-sheet-low-confidence',
          'add-note-sheet-error-timeout',
          'add-note-sheet-error-server',
          'add-note-sheet-error-parse_error',
          'add-note-sheet-queued',
          'add-note-sheet-recommendation',
        ],
        autoFiresOnSave: false,
      },
      {
        label: 'low_confidence',
        result: { ok: false, kind: 'low_confidence' },
        expectedTestId: 'add-note-sheet-low-confidence',
        forbiddenTestIds: [
          'add-note-sheet-reject',
          'add-note-sheet-error-timeout',
          'add-note-sheet-error-server',
          'add-note-sheet-error-parse_error',
          'add-note-sheet-queued',
          'add-note-sheet-recommendation',
        ],
        autoFiresOnSave: false,
      },
      {
        label: 'parse_error',
        result: { ok: false, kind: 'parse_error' },
        expectedTestId: 'add-note-sheet-error-parse_error',
        forbiddenTestIds: [
          'add-note-sheet-error-timeout',
          'add-note-sheet-error-server',
          'add-note-sheet-reject',
          'add-note-sheet-low-confidence',
          'add-note-sheet-queued',
          'add-note-sheet-recommendation',
        ],
        autoFiresOnSave: false,
      },
      {
        label: 'queued (backend signal)',
        result: { ok: false, kind: 'queued' },
        expectedTestId: 'add-note-sheet-queued',
        forbiddenTestIds: [
          'add-note-sheet-recommendation',
          'add-note-sheet-reject',
          'add-note-sheet-low-confidence',
          'add-note-sheet-error-timeout',
          'add-note-sheet-error-server',
          'add-note-sheet-error-parse_error',
        ],
        autoFiresOnSave: true,
      },
    ];

    for (const { label, result, expectedTestId, forbiddenTestIds, autoFiresOnSave } of cases) {
      const harness = await setupHarness();
      const { client } = makeClient(async () => result);
      const onPersisted = jest.fn();
      const { unmount } = render(
        <NoteFlow
          apiClient={client}
          harness={harness}
          keepOpenAfterSave
          onPersisted={onPersisted}
        />,
      );

      fireEvent.changeText(screen.getByTestId('add-note-sheet-input'), `case: ${label}`);
      await act(async () => {
        fireEvent.press(screen.getByTestId('add-note-sheet-save'));
        await flushMicrotasks();
      });

      await waitFor(() =>
        expect(screen.queryByTestId(expectedTestId)).toBeOnTheScreen(),
      );
      for (const forbidden of forbiddenTestIds) {
        expect(screen.queryByTestId(forbidden)).toBeNull();
      }
      // The network testID NEVER renders today — pin the no-leak.
      expect(screen.queryByTestId('add-note-sheet-error-network')).toBeNull();

      // Codex P4 catch: also assert the auto-fire behavior is observable
      // end-to-end, not just the UI render. Queued + network (coerced to
      // queued) BOTH auto-fire onSave from the press handler with
      // status='queued'; every other kind keeps the user in the sheet
      // for retry/dismiss/Done. A future regression that turns
      // recommendation into an auto-fire path (or that swallows the
      // queued auto-fire) trips here.
      if (autoFiresOnSave) {
        await waitFor(() => expect(onPersisted).toHaveBeenCalledTimes(1));
        const persistedNote = onPersisted.mock.calls[0]?.[0] as Note | null;
        expect(persistedNote?.consult_status).toBe('queued');
      } else {
        expect(onPersisted).not.toHaveBeenCalled();
      }

      unmount();
    }
  });

  // Cancel mid-flow --------------------------------------------------

  it('cancel pre-Save (backdrop press): no SQLite write, no consult call', async () => {
    // The EditorialBottomSheet primitive's backdrop press fires onCancel.
    // Tapping it before Save means consult never fires and no row lands.
    const harness = await setupHarness();
    const { client, consultSpy } = makeClient(async () => ({ ok: true, data: RECOMMENDATION }));
    const onPersisted = jest.fn();

    render(<NoteFlow apiClient={client} harness={harness} onPersisted={onPersisted} />);

    fireEvent.changeText(
      screen.getByTestId('add-note-sheet-input'),
      'I started typing but then changed my mind',
    );
    fireEvent.press(
      screen.getByTestId('add-note-sheet-backdrop', { includeHiddenElements: true }),
    );
    await flushMicrotasks();

    expect(consultSpy).not.toHaveBeenCalled();
    expect(onPersisted).not.toHaveBeenCalled();
    const row = harness.raw.prepare('SELECT count(*) AS c FROM notes').get() as { c: number };
    expect(row.c).toBe(0);
  });

  it('cancel mid-loading (recommendation path): backdrop dismiss while consult is in flight; recommendation resolution does NOT trigger persist (Done CTA gate holds)', async () => {
    // The codex P2 lock from E8-003 holds across cancel: even if a
    // recommendation lands after the user dismissed the sheet, the
    // press-handler does NOT auto-fire onSave for ok+recommendation
    // (component:253-279). Persistence requires Done. The sheet has
    // already unmounted, so Done can't be tapped → no row.
    const harness = await setupHarness();
    let resolveConsult: (r: ApiResult<ConsultResponse>) => void = () => {};
    const pending = new Promise<ApiResult<ConsultResponse>>((r) => {
      resolveConsult = r;
    });
    const { client, consultSpy } = makeClient(() => pending);
    const onPersisted = jest.fn();

    render(<NoteFlow apiClient={client} harness={harness} onPersisted={onPersisted} />);

    fireEvent.changeText(screen.getByTestId('add-note-sheet-input'), 'Just repotted');
    await act(async () => {
      fireEvent.press(screen.getByTestId('add-note-sheet-save'));
      await flushMicrotasks();
    });

    // Loading dock is up; consult is in flight.
    expect(consultSpy).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('add-note-sheet-loading')).toBeOnTheScreen();

    // Backdrop press fires onCancel → host sets open=false.
    fireEvent.press(
      screen.getByTestId('add-note-sheet-backdrop', { includeHiddenElements: true }),
    );
    await flushMicrotasks();

    await act(async () => {
      resolveConsult({ ok: true, data: RECOMMENDATION });
      await flushMicrotasks();
    });

    // No row landed. The recommendation surface needs an explicit Done
    // tap to persist; since the sheet unmounted on cancel, Done can't be
    // tapped. The codex P2 lock (Done-after-recommendation gate) doubles
    // as a cancel-mid-loading guard for the success path.
    expect(onPersisted).not.toHaveBeenCalled();
    const row = harness.raw.prepare('SELECT count(*) AS c FROM notes').get() as { c: number };
    expect(row.c).toBe(0);
  });

  it('cancel mid-loading (queued auto-fire HAZARD): documents the present-day race where queued resolution after backdrop-cancel still persists the note', async () => {
    // Codex catch (E8-006 high finding): the queued path auto-fires
    // onSave from the press handler (component:265-272) WITHOUT a post-
    // cancel guard. The press handler awaits `consult(...)`; if the user
    // dismisses the sheet via backdrop before the queued result lands,
    // onSave still fires on the now-cancelled sheet and the host persists
    // a row the user already abandoned.
    //
    // This is a real production hazard: a slow offline-detect (netInfo
    // resolves false ~tens of ms after Save) leaves a window where the
    // user sees the loading state, taps the backdrop to cancel, and then
    // their note still gets saved as queued. The race is small but real.
    //
    // SCOPE: E8-006 ships TESTS, not behavior changes. The fix is a
    // follow-up (likely a `cancelledRef` checked before the queued onSave
    // call, mirroring `inFlightRef`'s shape). This test PINS the current
    // behavior so the follow-up has a clear before/after — flipping this
    // to `not.toHaveBeenCalled()` is the acceptance criterion for the fix.
    //
    // Rejected scope-creep: changing AddNoteSheet here would (a) violate
    // the E8-006 brief ("ADD coverage; existing tests stay"); (b) couple
    // a test PR to a behavior PR; (c) skip the codex/design review the
    // behavior change needs in its own ticket.
    const harness = await setupHarness();
    let resolveConsult: (r: ApiResult<ConsultResponse>) => void = () => {};
    const pending = new Promise<ApiResult<ConsultResponse>>((r) => {
      resolveConsult = r;
    });
    const { client, consultSpy } = makeClient(() => pending);
    const onPersisted = jest.fn();

    render(<NoteFlow apiClient={client} harness={harness} onPersisted={onPersisted} />);

    fireEvent.changeText(screen.getByTestId('add-note-sheet-input'), 'Just repotted');
    await act(async () => {
      fireEvent.press(screen.getByTestId('add-note-sheet-save'));
      await flushMicrotasks();
    });
    expect(consultSpy).toHaveBeenCalledTimes(1);

    // Cancel via backdrop while consult is in flight.
    fireEvent.press(
      screen.getByTestId('add-note-sheet-backdrop', { includeHiddenElements: true }),
    );
    await flushMicrotasks();

    // Queued result lands AFTER cancel. The press handler still fires
    // onSave because there is no post-cancel guard.
    await act(async () => {
      resolveConsult({ ok: false, kind: 'queued' });
      await flushMicrotasks();
    });

    // PRESENT-DAY HAZARD: the row IS persisted because onSave fires
    // unconditionally on the queued resolution. Future fix flips these
    // assertions to .not.toHaveBeenCalled() / row.c === 0.
    expect(onPersisted).toHaveBeenCalledTimes(1);
    const row = harness.raw.prepare('SELECT count(*) AS c FROM notes').get() as { c: number };
    expect(row.c).toBe(1);
  });

  // Persist on Save: queued path -----------------------------------

  it('queued path: offline submit auto-persists with consult_status=queued so E7 drainer can resolve later', async () => {
    // The master plan + AddNoteSheet:265-273: queued is the one non-success
    // kind that DOES auto-fire onSave (with status='queued'). The persist
    // hook stores consult_status verbatim per the schema, and the row lands
    // immediately so the user sees their note in the timeline even before
    // the LLM responds.
    const harness = await setupHarness();
    const { client, consultSpy } = makeClient(async () => ({ ok: true, data: RECOMMENDATION }));
    const onPersisted = jest.fn();

    render(
      <NoteFlow
        apiClient={client}
        harness={harness}
        netInfo={{ isConnected: () => false }}
        onPersisted={onPersisted}
      />,
    );

    fireEvent.changeText(screen.getByTestId('add-note-sheet-input'), 'Offline note');
    await act(async () => {
      fireEvent.press(screen.getByTestId('add-note-sheet-save'));
      await flushMicrotasks();
    });

    // No consult call — netInfo coerced to queued before fetch.
    expect(consultSpy).not.toHaveBeenCalled();
    // onSave fired with status=queued → host called persist → SQLite write.
    await waitFor(() => expect(onPersisted).toHaveBeenCalledTimes(1));
    const rows = harness.raw
      .prepare('SELECT user_text, consult_status, llm_response FROM notes WHERE plant_id = ?')
      .all(harness.plantId) as Array<{
      user_text: string;
      consult_status: string;
      llm_response: string | null;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.user_text).toBe('Offline note');
    // The mapper routes status:'queued' → kind:'queued'. The persist hook
    // stores it verbatim in consult_status.
    expect(rows[0]?.consult_status).toBe('queued');
    expect(rows[0]?.llm_response).toBeNull();
  });
});
