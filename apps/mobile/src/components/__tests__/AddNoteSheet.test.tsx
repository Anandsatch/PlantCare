/**
 * AddNoteSheet tests — E8-003.
 *
 * Coverage targets:
 *   - Render: headline, input, Save & analyze, Cancel
 *   - Save disabled until non-empty (whitespace trimmed)
 *   - Submit fires consult once (Strict-mode double-mount latch)
 *   - kind=ok → onSave with payload + sheet stays open until parent closes
 *   - kind=layer1_reject → reject card; Try again preserves note + clears
 *   - kind=low_confidence → distinct card, NOT collapsed with reject
 *   - kind=timeout / server / parse_error each render distinct UI
 *   - kind=queued → pending toast + onSave fires with status='queued'
 *   - kind=success + data.kind=rejected_off_topic (forward-compat) → reject
 *   - Cancel CTA fires onCancel
 *   - Loading state during in-flight; reduce-motion gates spinner → static dot
 *   - Dark theme tokens swap
 *   - A11y: input label + reject role=alert
 *   - AppState resume: doesn't double-fire
 *   - Empty submit guard (whitespace-only) doesn't fire request
 *   - Emoji-only note IS allowed (trim doesn't strip emoji)
 *   - derivePhase pure helper coverage
 */
import { darkTheme, lightTheme } from '@plantcare/theme';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import type { ApiClient, ApiResult, ConsultResponse } from '../../api';
import { AddNoteSheet, derivePhase } from '../AddNoteSheet';

// ─── Mocks ──────────────────────────────────────────────────────────────

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

// eslint-disable-next-line @typescript-eslint/no-require-imports
const useColorSchemeMock = require('react-native/Libraries/Utilities/useColorScheme')
  .default as jest.Mock<'light' | 'dark' | null | undefined, []>;

beforeEach(() => {
  mockState.reduceMotion = false;
  mockReduceMotionListeners.length = 0;
  useColorSchemeMock.mockReturnValue('light');
});

// Drain mount-time async effects (isReduceMotionEnabled, useEffect cleanup)
// after each test to avoid React 19 "not wrapped in act()" warnings.
afterEach(async () => {
  await act(async () => {
    await new Promise((resolve) => setImmediate(resolve));
  });
});

// ─── Helpers ────────────────────────────────────────────────────────────

const RECOMMENDATION: ConsultResponse = {
  kind: 'recommendation',
  revised_interval_days: 7,
  reasoning: 'Hold off on watering for 3 more days while it recovers from repotting.',
  confidence: 86,
  source: 'paid_escalated',
  latency_ms: 1234,
};

function makeClient(
  consultImpl: (
    body: { note: string; plant_context?: unknown },
  ) => Promise<ApiResult<ConsultResponse>>,
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

function renderSheet(overrides: Partial<{
  open: boolean;
  client: ApiClient;
  onSave: jest.Mock;
  onCancel: jest.Mock;
  netInfo: { isConnected: () => boolean | Promise<boolean> };
  plantNickname: string;
}> = {}) {
  const onSave = overrides.onSave ?? jest.fn();
  const onCancel = overrides.onCancel ?? jest.fn();
  const apiClient =
    overrides.client ??
    makeClient(async () => ({ ok: true, data: RECOMMENDATION })).client;
  const utils = render(
    <AddNoteSheet
      open={overrides.open ?? true}
      onSave={onSave as never}
      onCancel={onCancel as never}
      apiClient={apiClient}
      plantNickname={overrides.plantNickname ?? 'Steve'}
      netInfo={overrides.netInfo ?? { isConnected: () => true }}
      testID="add-note-sheet"
    />,
  );
  return { ...utils, onSave, onCancel, apiClient };
}

async function flushMicrotasks() {
  await act(async () => {
    await new Promise((resolve) => setImmediate(resolve));
  });
}

// ─── Pure helper tests ──────────────────────────────────────────────────

describe('derivePhase', () => {
  it('idle + null → input', () => {
    expect(derivePhase('idle', null)).toBe('input');
  });
  it('success + ok recommendation → recommendation', () => {
    expect(
      derivePhase('success', {
        ok: true,
        data: {
          kind: 'recommendation',
          revised_interval_days: 7,
          reasoning: 'Hold off',
          confidence: 80,
          source: 'paid_escalated',
          latency_ms: 1,
        },
      }),
    ).toBe('recommendation');
  });
  it('requesting → loading', () => {
    expect(derivePhase('requesting', null)).toBe('loading');
  });
  it('queued status → queued phase', () => {
    expect(derivePhase('queued', { ok: false, kind: 'queued' })).toBe('queued');
  });
  it('layer1_reject → reject', () => {
    expect(derivePhase('error', { ok: false, kind: 'layer1_reject' })).toBe('reject');
  });
  it('low_confidence → low_confidence (NOT collapsed with reject)', () => {
    expect(derivePhase('error', { ok: false, kind: 'low_confidence' })).toBe(
      'low_confidence',
    );
  });
  it('timeout → timeout (distinct from server)', () => {
    expect(derivePhase('error', { ok: false, kind: 'timeout' })).toBe('timeout');
  });
  it('server → server', () => {
    expect(derivePhase('error', { ok: false, kind: 'server', retry_after: 30 })).toBe(
      'server',
    );
  });
  it('parse_error → parse_error', () => {
    expect(derivePhase('error', { ok: false, kind: 'parse_error' })).toBe('parse_error');
  });
  it('forward-compat ok+rejected_off_topic → reject', () => {
    expect(
      derivePhase('success', {
        ok: true,
        data: {
          kind: 'rejected_off_topic',
          reason: 'off-topic',
          source: 'paid_escalated',
          latency_ms: 12,
        },
      }),
    ).toBe('reject');
  });
});

// ─── Component tests ────────────────────────────────────────────────────

describe('<AddNoteSheet />', () => {
  it('renders headline + input + Save + Cancel when open', async () => {
    renderSheet();
    expect(screen.getByTestId('add-note-sheet-headline')).toBeOnTheScreen();
    expect(screen.getByTestId('add-note-sheet-input')).toBeOnTheScreen();
    expect(screen.getByTestId('add-note-sheet-save')).toBeOnTheScreen();
    expect(screen.getByTestId('add-note-sheet-cancel')).toBeOnTheScreen();
  });

  it('uses plant nickname in headline when provided', () => {
    renderSheet({ plantNickname: 'Steve' });
    expect(screen.getByTestId('add-note-sheet-headline').props.children).toContain('Steve');
  });

  it('Save is disabled until note is non-empty (trim whitespace)', () => {
    renderSheet();
    const save = screen.getByTestId('add-note-sheet-save');
    expect(save.props.accessibilityState?.disabled).toBe(true);

    // Whitespace-only stays disabled.
    fireEvent.changeText(screen.getByTestId('add-note-sheet-input'), '   \n  ');
    expect(
      screen.getByTestId('add-note-sheet-save').props.accessibilityState?.disabled,
    ).toBe(true);

    fireEvent.changeText(screen.getByTestId('add-note-sheet-input'), 'Just repotted');
    expect(
      screen.getByTestId('add-note-sheet-save').props.accessibilityState?.disabled,
    ).toBe(false);
  });

  it('emoji-only note is allowed (trim does not strip emoji)', () => {
    renderSheet();
    fireEvent.changeText(screen.getByTestId('add-note-sheet-input'), '🌱🌱');
    expect(
      screen.getByTestId('add-note-sheet-save').props.accessibilityState?.disabled,
    ).toBe(false);
  });

  it('submit fires consult once even on synchronous double-tap (Strict-mode latch)', async () => {
    const { consultSpy, client } = makeClient(
      async () => ({ ok: true, data: RECOMMENDATION }),
    );
    const onSave = jest.fn();
    renderSheet({ client, onSave });

    fireEvent.changeText(screen.getByTestId('add-note-sheet-input'), 'Just repotted');
    await act(async () => {
      fireEvent.press(screen.getByTestId('add-note-sheet-save'));
      fireEvent.press(screen.getByTestId('add-note-sheet-save'));
      await flushMicrotasks();
    });

    // The hook is invoked exactly once even though Save was tapped twice
    // synchronously. onSave is NOT auto-called on recommendation; the user
    // would tap Done to fire it.
    expect(consultSpy).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();
  });

  it('kind=ok renders inline recommendation card with reasoning copy (does NOT auto-fire onSave)', async () => {
    const { client } = makeClient(async () => ({ ok: true, data: RECOMMENDATION }));
    const onSave = jest.fn();
    renderSheet({ client, onSave });

    fireEvent.changeText(screen.getByTestId('add-note-sheet-input'), 'Just repotted');
    await act(async () => {
      fireEvent.press(screen.getByTestId('add-note-sheet-save'));
      await flushMicrotasks();
    });

    // Inline reasoning shows; user reads it; onSave has NOT yet fired —
    // this is the master-plan-locked behavior (line 333). Codex-P2 fix
    // for "discriminated union collapsed" — recommendation is its own
    // distinct UI phase.
    expect(screen.getByTestId('add-note-sheet-recommendation')).toBeOnTheScreen();
    expect(screen.getByText(RECOMMENDATION.reasoning)).toBeOnTheScreen();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('kind=ok → Done press fires onSave with the right payload', async () => {
    const { client } = makeClient(async () => ({ ok: true, data: RECOMMENDATION }));
    const onSave = jest.fn();
    const before = Date.now();
    renderSheet({ client, onSave });

    fireEvent.changeText(screen.getByTestId('add-note-sheet-input'), '  Just repotted  ');
    await act(async () => {
      fireEvent.press(screen.getByTestId('add-note-sheet-save'));
      await flushMicrotasks();
    });

    fireEvent.press(screen.getByTestId('add-note-sheet-recommendation-done'));

    expect(onSave).toHaveBeenCalledTimes(1);
    const payload = onSave.mock.calls[0]?.[0];
    expect(payload).toMatchObject({
      note: 'Just repotted',
      llmResponse: RECOMMENDATION,
      status: 'ok',
    });
    expect(typeof payload.timestamp).toBe('number');
    expect(payload.timestamp).toBeGreaterThanOrEqual(before);
  });

  it('kind=layer1_reject renders the reject card (alert role); Try again returns to input WITH note preserved', async () => {
    const { client } = makeClient(async () => ({
      ok: false,
      kind: 'layer1_reject',
      message: 'off-topic',
    }));
    renderSheet({ client });

    fireEvent.changeText(screen.getByTestId('add-note-sheet-input'), 'best pasta recipe');
    await act(async () => {
      fireEvent.press(screen.getByTestId('add-note-sheet-save'));
      await flushMicrotasks();
    });

    const reject = screen.getByTestId('add-note-sheet-reject');
    expect(reject).toBeOnTheScreen();
    expect(reject.props.accessibilityRole).toBe('alert');

    // Try again returns to input phase. The note text is preserved (we use
    // the React-controlled value; reset() doesn't clear local note state).
    await act(async () => {
      fireEvent.press(screen.getByTestId('add-note-sheet-reject-try-again'));
      await flushMicrotasks();
    });

    expect(screen.queryByTestId('add-note-sheet-reject')).toBeNull();
    expect(screen.getByTestId('add-note-sheet-input').props.value).toBe(
      'best pasta recipe',
    );
  });

  it('kind=low_confidence renders distinct card (NOT collapsed with reject)', async () => {
    const { client } = makeClient(async () => ({ ok: false, kind: 'low_confidence' }));
    renderSheet({ client });
    fireEvent.changeText(screen.getByTestId('add-note-sheet-input'), 'leaves');
    await act(async () => {
      fireEvent.press(screen.getByTestId('add-note-sheet-save'));
      await flushMicrotasks();
    });
    expect(screen.getByTestId('add-note-sheet-low-confidence')).toBeOnTheScreen();
    expect(screen.queryByTestId('add-note-sheet-reject')).toBeNull();
  });

  it('kind=timeout renders the timeout error card (distinct from server)', async () => {
    const { client } = makeClient(async () => ({ ok: false, kind: 'timeout' }));
    renderSheet({ client });
    fireEvent.changeText(screen.getByTestId('add-note-sheet-input'), 'Just repotted');
    await act(async () => {
      fireEvent.press(screen.getByTestId('add-note-sheet-save'));
      await flushMicrotasks();
    });
    expect(screen.getByTestId('add-note-sheet-error-timeout')).toBeOnTheScreen();
    expect(screen.queryByTestId('add-note-sheet-error-server')).toBeNull();
  });

  it('kind=server renders the server error card; retry_after surfaces in copy', async () => {
    const { client } = makeClient(async () => ({
      ok: false,
      kind: 'server',
      retry_after: 30,
    }));
    renderSheet({ client });
    fireEvent.changeText(screen.getByTestId('add-note-sheet-input'), 'help');
    await act(async () => {
      fireEvent.press(screen.getByTestId('add-note-sheet-save'));
      await flushMicrotasks();
    });
    const serverCard = screen.getByTestId('add-note-sheet-error-server');
    expect(serverCard).toBeOnTheScreen();
    // Body text mentions the retry_after seconds. Walk children for a Text
    // node containing "30" — JSON.stringify on RN host nodes hits circular
    // fiber refs, so we look up by text content instead.
    expect(screen.getByText(/30 seconds/)).toBeOnTheScreen();
  });

  it('kind=parse_error renders the parse_error card', async () => {
    const { client } = makeClient(async () => ({ ok: false, kind: 'parse_error' }));
    renderSheet({ client });
    fireEvent.changeText(screen.getByTestId('add-note-sheet-input'), 'Just repotted');
    await act(async () => {
      fireEvent.press(screen.getByTestId('add-note-sheet-save'));
      await flushMicrotasks();
    });
    expect(screen.getByTestId('add-note-sheet-error-parse_error')).toBeOnTheScreen();
  });

  it('kind=queued renders pending toast (status role) AND fires onSave with status=queued', async () => {
    const { client } = makeClient(async () => ({ ok: false, kind: 'queued' }));
    const onSave = jest.fn();
    renderSheet({
      client,
      onSave,
      netInfo: { isConnected: () => true }, // online; the 'queued' is a backend signal here
    });
    fireEvent.changeText(screen.getByTestId('add-note-sheet-input'), 'Just repotted');
    await act(async () => {
      fireEvent.press(screen.getByTestId('add-note-sheet-save'));
      await flushMicrotasks();
    });

    const queued = screen.getByTestId('add-note-sheet-queued');
    expect(queued).toBeOnTheScreen();
    expect(queued.props.accessibilityRole).toBe('status');
    expect(onSave).toHaveBeenCalledTimes(1);
    const payload = onSave.mock.calls[0]?.[0];
    expect(payload).toMatchObject({
      note: 'Just repotted',
      llmResponse: null,
      status: 'queued',
    });
  });

  it('offline (netInfo=false) coerces to queued and fires onSave with status=queued', async () => {
    const { client, consultSpy } = makeClient(
      async () => ({ ok: true, data: RECOMMENDATION }),
    );
    const onSave = jest.fn();
    renderSheet({ client, onSave, netInfo: { isConnected: () => false } });
    fireEvent.changeText(screen.getByTestId('add-note-sheet-input'), 'Just repotted');
    await act(async () => {
      fireEvent.press(screen.getByTestId('add-note-sheet-save'));
      await flushMicrotasks();
    });
    expect(consultSpy).not.toHaveBeenCalled();
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0]?.[0]).toMatchObject({ status: 'queued' });
  });

  it('Cancel CTA fires onCancel', () => {
    const onCancel = jest.fn();
    renderSheet({ onCancel });
    fireEvent.press(screen.getByTestId('add-note-sheet-cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('swipe-down via backdrop press fires onCancel (E2-011 primitive integration)', () => {
    const onCancel = jest.fn();
    renderSheet({ onCancel });
    fireEvent.press(
      screen.getByTestId('add-note-sheet-backdrop', { includeHiddenElements: true }),
    );
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('loading state: spinner visible during in-flight; reduce-motion swaps to static dot', async () => {
    let resolve: (r: ApiResult<ConsultResponse>) => void = () => {};
    const pending = new Promise<ApiResult<ConsultResponse>>((r) => {
      resolve = r;
    });
    const { client } = makeClient(() => pending);
    renderSheet({ client });
    fireEvent.changeText(screen.getByTestId('add-note-sheet-input'), 'Just repotted');
    await act(async () => {
      fireEvent.press(screen.getByTestId('add-note-sheet-save'));
      await flushMicrotasks();
    });

    await waitFor(() => {
      expect(screen.getByTestId('add-note-sheet-loading')).toBeOnTheScreen();
    });
    // Reduce-motion OFF: spinner present, static dot absent.
    expect(screen.getByTestId('add-note-sheet-loading-spinner')).toBeOnTheScreen();
    expect(screen.queryByTestId('add-note-sheet-loading-static')).toBeNull();

    await act(async () => {
      resolve({ ok: true, data: RECOMMENDATION });
      await flushMicrotasks();
    });
  });

  it('loading state honors reduce-motion: static dot replaces spinner', async () => {
    mockState.reduceMotion = true;
    let resolve: (r: ApiResult<ConsultResponse>) => void = () => {};
    const pending = new Promise<ApiResult<ConsultResponse>>((r) => {
      resolve = r;
    });
    const { client } = makeClient(() => pending);
    renderSheet({ client });
    // Wait for the reduce-motion mount-time effect to settle.
    await flushMicrotasks();

    fireEvent.changeText(screen.getByTestId('add-note-sheet-input'), 'Just repotted');
    await act(async () => {
      fireEvent.press(screen.getByTestId('add-note-sheet-save'));
      await flushMicrotasks();
    });

    await waitFor(() => {
      expect(screen.getByTestId('add-note-sheet-loading-static')).toBeOnTheScreen();
    });
    expect(screen.queryByTestId('add-note-sheet-loading-spinner')).toBeNull();

    await act(async () => {
      resolve({ ok: true, data: RECOMMENDATION });
      await flushMicrotasks();
    });
  });

  it('dark theme: surface tokens swap to Midnight Conservatory', () => {
    useColorSchemeMock.mockReturnValue('dark');
    renderSheet();
    const sheet = screen.getByTestId('add-note-sheet-sheet');
    const flat = Array.isArray(sheet.props.style)
      ? Object.assign({}, ...sheet.props.style.flat())
      : sheet.props.style;
    expect(flat.backgroundColor).toBe(darkTheme.colors.surface);
  });

  it('light theme: surface tokens are Conservatory cream', () => {
    useColorSchemeMock.mockReturnValue('light');
    renderSheet();
    const sheet = screen.getByTestId('add-note-sheet-sheet');
    const flat = Array.isArray(sheet.props.style)
      ? Object.assign({}, ...sheet.props.style.flat())
      : sheet.props.style;
    expect(flat.backgroundColor).toBe(lightTheme.colors.surface);
  });

  it('TextInput has accessibilityLabel for screen readers', () => {
    renderSheet();
    expect(
      screen.getByTestId('add-note-sheet-input').props.accessibilityLabel,
    ).toBe('Note about your plant');
  });

  it('focus trap is owned by EditorialBottomSheet (accessibilityViewIsModal=true on the sheet)', () => {
    renderSheet();
    expect(
      screen.getByTestId('add-note-sheet-sheet').props.accessibilityViewIsModal,
    ).toBe(true);
    expect(screen.getByTestId('add-note-sheet-sheet').props.accessibilityRole).toBe(
      'dialog',
    );
  });

  it('AppState resume / re-render: open=true → false → true cycle clears local note state', async () => {
    const { client } = makeClient(async () => ({ ok: true, data: RECOMMENDATION }));
    const onSave = jest.fn();
    const onCancel = jest.fn();
    const { rerender } = render(
      <AddNoteSheet
        open
        onSave={onSave as never}
        onCancel={onCancel as never}
        apiClient={client}
        plantNickname="Steve"
        netInfo={{ isConnected: () => true }}
        testID="add-note-sheet"
      />,
    );
    fireEvent.changeText(screen.getByTestId('add-note-sheet-input'), 'first try');

    // Close.
    rerender(
      <AddNoteSheet
        open={false}
        onSave={onSave as never}
        onCancel={onCancel as never}
        apiClient={client}
        plantNickname="Steve"
        netInfo={{ isConnected: () => true }}
        testID="add-note-sheet"
      />,
    );
    await flushMicrotasks();

    // Re-open.
    rerender(
      <AddNoteSheet
        open
        onSave={onSave as never}
        onCancel={onCancel as never}
        apiClient={client}
        plantNickname="Steve"
        netInfo={{ isConnected: () => true }}
        testID="add-note-sheet"
      />,
    );
    await flushMicrotasks();

    expect(screen.getByTestId('add-note-sheet-input').props.value).toBe('');
  });

  it('AppState resume: an in-flight request already-fired does NOT double-fire on re-render', async () => {
    let resolve: (r: ApiResult<ConsultResponse>) => void = () => {};
    const pending = new Promise<ApiResult<ConsultResponse>>((r) => {
      resolve = r;
    });
    const { consultSpy, client } = makeClient(() => pending);
    const onSave = jest.fn();
    const { rerender } = render(
      <AddNoteSheet
        open
        onSave={onSave as never}
        onCancel={jest.fn() as never}
        apiClient={client}
        plantNickname="Steve"
        netInfo={{ isConnected: () => true }}
        testID="add-note-sheet"
      />,
    );

    fireEvent.changeText(screen.getByTestId('add-note-sheet-input'), 'Just repotted');
    await act(async () => {
      fireEvent.press(screen.getByTestId('add-note-sheet-save'));
      await flushMicrotasks();
    });
    expect(consultSpy).toHaveBeenCalledTimes(1);

    // Simulate a re-render (AppState foreground or parent re-render). The
    // press handler is keyed on inFlightRef + Save's loading state; neither
    // condition allows a second consult to fire without a fresh user press.
    rerender(
      <AddNoteSheet
        open
        onSave={onSave as never}
        onCancel={jest.fn() as never}
        apiClient={client}
        plantNickname="Steve"
        netInfo={{ isConnected: () => true }}
        testID="add-note-sheet"
      />,
    );
    await flushMicrotasks();
    expect(consultSpy).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolve({ ok: true, data: RECOMMENDATION });
      await flushMicrotasks();
    });
  });

  it('whitespace-only submit guard: tapping Save with " " (after toggling) does not fire request', async () => {
    const { consultSpy, client } = makeClient(
      async () => ({ ok: true, data: RECOMMENDATION }),
    );
    renderSheet({ client });
    // First type a real value to enable the button, then clear it back to whitespace.
    fireEvent.changeText(screen.getByTestId('add-note-sheet-input'), 'Just repotted');
    fireEvent.changeText(screen.getByTestId('add-note-sheet-input'), '   ');
    // Save should be disabled now.
    expect(
      screen.getByTestId('add-note-sheet-save').props.accessibilityState?.disabled,
    ).toBe(true);
    // Press anyway — disabled Pressable should swallow.
    await act(async () => {
      fireEvent.press(screen.getByTestId('add-note-sheet-save'));
      await flushMicrotasks();
    });
    expect(consultSpy).not.toHaveBeenCalled();
  });

  it('forward-compat: ok=true with data.kind=rejected_off_topic renders the reject card', async () => {
    const { client } = makeClient(async () => ({
      ok: true,
      data: {
        kind: 'rejected_off_topic',
        reason: 'off-topic',
        source: 'paid_escalated',
        latency_ms: 12,
      },
    }));
    const onSave = jest.fn();
    renderSheet({ client, onSave });
    fireEvent.changeText(screen.getByTestId('add-note-sheet-input'), 'best pasta?');
    await act(async () => {
      fireEvent.press(screen.getByTestId('add-note-sheet-save'));
      await flushMicrotasks();
    });
    expect(screen.getByTestId('add-note-sheet-reject')).toBeOnTheScreen();
    // Forward-compat reject is NOT persisted via onSave (we don't save off-topic).
    expect(onSave).not.toHaveBeenCalled();
  });
});

// ─── E11-006 budget gate tests ───────────────────────────────────────────

describe('<AddNoteSheet /> — E11-006 budget gate', () => {
  function renderGated(
    overrides: {
      budgetGate?: { disabled: boolean };
      consultImpl?: (
        body: { note: string; plant_context?: unknown },
      ) => Promise<ApiResult<ConsultResponse>>;
    } = {},
  ) {
    const onSave = jest.fn();
    const onCancel = jest.fn();
    const { client, consultSpy } = makeClient(
      overrides.consultImpl ??
        (async () => ({ ok: true, data: RECOMMENDATION })),
    );
    const utils = render(
      <AddNoteSheet
        open
        onSave={onSave as never}
        onCancel={onCancel as never}
        apiClient={client}
        plantNickname="Steve"
        netInfo={{ isConnected: () => true }}
        budgetGate={overrides.budgetGate}
        testID="add-note-sheet"
      />,
    );
    return { ...utils, onSave, onCancel, consultSpy };
  }

  it('passes through (no gate) when budgetGate is omitted — back-compat', async () => {
    const { consultSpy } = renderGated({});
    fireEvent.changeText(screen.getByTestId('add-note-sheet-input'), 'Just repotted');
    await act(async () => {
      fireEvent.press(screen.getByTestId('add-note-sheet-save'));
      await flushMicrotasks();
    });
    expect(consultSpy).toHaveBeenCalledTimes(1);
  });

  it('disables Save and skips consult() when budgetGate.disabled=true', async () => {
    const { consultSpy } = renderGated({ budgetGate: { disabled: true } });
    fireEvent.changeText(screen.getByTestId('add-note-sheet-input'), 'Just repotted');

    // The CTA is rendered but disabled. fireEvent.press is a no-op on a
    // disabled EditorialButton (the disabled flag short-circuits the
    // Pressable's onPress). Belt-and-braces: even if a future button
    // change leaks the press through, handleSavePress short-circuits
    // on `budgetDisabled` before calling consult.
    await act(async () => {
      fireEvent.press(screen.getByTestId('add-note-sheet-save'));
      await flushMicrotasks();
    });
    expect(consultSpy).not.toHaveBeenCalled();
  });

  it('swaps the Save CTA label to "Daily limit reached" when disabled', async () => {
    renderGated({ budgetGate: { disabled: true } });
    fireEvent.changeText(screen.getByTestId('add-note-sheet-input'), 'Just repotted');
    expect(screen.getByText('Daily limit reached')).toBeOnTheScreen();
    expect(screen.queryByText('Save & analyze')).toBeNull();
  });

  it('swaps the accessibility label too (limit-reached announcement)', async () => {
    renderGated({ budgetGate: { disabled: true } });
    const cta = screen.getByTestId('add-note-sheet-save');
    expect(cta.props.accessibilityLabel).toBe(
      'Daily LLM limit reached. Save and analyze unavailable until midnight UTC.',
    );
  });

  it('keeps the default label when budgetGate.disabled=false', async () => {
    const { consultSpy } = renderGated({ budgetGate: { disabled: false } });
    fireEvent.changeText(screen.getByTestId('add-note-sheet-input'), 'Just repotted');
    expect(screen.getByText('Save & analyze')).toBeOnTheScreen();
    await act(async () => {
      fireEvent.press(screen.getByTestId('add-note-sheet-save'));
      await flushMicrotasks();
    });
    expect(consultSpy).toHaveBeenCalledTimes(1);
  });

  it('does NOT break the queued offline path when gate is disabled (gate wins)', async () => {
    // Even if the queued path WOULD have fired offline, the gate cuts
    // the consult() call entirely — the user-perceived state is "out
    // of budget", same as online.
    const onSave = jest.fn();
    const { client, consultSpy } = makeClient(
      async () => ({ ok: false, kind: 'queued' }),
    );
    render(
      <AddNoteSheet
        open
        onSave={onSave as never}
        onCancel={jest.fn() as never}
        apiClient={client}
        plantNickname="Steve"
        netInfo={{ isConnected: () => false }}
        budgetGate={{ disabled: true }}
        testID="add-note-sheet"
      />,
    );
    fireEvent.changeText(screen.getByTestId('add-note-sheet-input'), 'leaves drooping');
    await act(async () => {
      fireEvent.press(screen.getByTestId('add-note-sheet-save'));
      await flushMicrotasks();
    });
    expect(consultSpy).not.toHaveBeenCalled();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('does NOT break the queued offline path when gate is enabled (queued still works)', async () => {
    // Sanity-check the inverse: with the gate enabled, the offline
    // path queues normally.
    const onSave = jest.fn();
    const { client } = makeClient(async () => ({ ok: false, kind: 'queued' }));
    render(
      <AddNoteSheet
        open
        onSave={onSave as never}
        onCancel={jest.fn() as never}
        apiClient={client}
        plantNickname="Steve"
        netInfo={{ isConnected: () => false }}
        budgetGate={{ disabled: false }}
        testID="add-note-sheet"
      />,
    );
    fireEvent.changeText(screen.getByTestId('add-note-sheet-input'), 'leaves drooping');
    await act(async () => {
      fireEvent.press(screen.getByTestId('add-note-sheet-save'));
      await flushMicrotasks();
    });
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0]?.[0]).toMatchObject({ status: 'queued' });
  });
});

// ─── offlineQueue prop wiring (v0.1.61.0 follow-up) ───────────────────────

describe('<AddNoteSheet /> — offlineQueue prop wiring', () => {
  it('forwards offlineQueue to useConsultRequest: offline submit enqueues', async () => {
    // netInfo says offline → pre-flight short-circuits the consult call
    // and routes straight through safeEnqueue against the wired db.
    const { client, consultSpy } = makeClient(
      async () => ({ ok: true, data: RECOMMENDATION }), // never reached
    );
    const runAsync = jest.fn(
      async (_sql: string, _params: unknown[]) => ({ lastInsertRowId: 1, changes: 1 }),
    );
    const getFirstAsync = jest.fn(
      async <T,>(_sql: string, _params: unknown[]): Promise<T | null> => null,
    );
    const withExclusiveTransactionAsync = jest.fn(
      async (fn: () => Promise<void>) => {
        await fn();
      },
    );
    const fakeDb = {
      runAsync,
      getFirstAsync,
      getAllAsync: jest.fn(async () => []),
      withExclusiveTransactionAsync,
    };
    const onSave = jest.fn();
    render(
      <AddNoteSheet
        open
        onSave={onSave as never}
        onCancel={jest.fn() as never}
        apiClient={client}
        plantNickname="Steve"
        netInfo={{ isConnected: () => false }}
        offlineQueue={{ db: fakeDb as never }}
        testID="add-note-sheet"
      />,
    );
    fireEvent.changeText(screen.getByTestId('add-note-sheet-input'), 'leaves drooping');
    await act(async () => {
      fireEvent.press(screen.getByTestId('add-note-sheet-save'));
      await flushMicrotasks();
    });
    // Offline pre-flight: no consult fired.
    expect(consultSpy).not.toHaveBeenCalled();
    // safeEnqueue exercised the transaction + insert.
    expect(withExclusiveTransactionAsync).toHaveBeenCalledTimes(1);
    expect(runAsync).toHaveBeenCalled();
    const insertArgs = runAsync.mock.calls[0];
    expect(insertArgs?.[0]).toMatch(/INSERT INTO sync_queue/);
    expect((insertArgs?.[1] as unknown[])?.[1]).toBe('consult');
  });

  it('omitting offlineQueue keeps legacy behavior: no persistence calls', async () => {
    const { client } = makeClient(async () => ({ ok: false, kind: 'queued' }));
    const runAsync = jest.fn();
    const withExclusiveTransactionAsync = jest.fn();
    const onSave = jest.fn();
    render(
      <AddNoteSheet
        open
        onSave={onSave as never}
        onCancel={jest.fn() as never}
        apiClient={client}
        plantNickname="Steve"
        netInfo={{ isConnected: () => false }}
        testID="add-note-sheet"
      />,
    );
    fireEvent.changeText(screen.getByTestId('add-note-sheet-input'), 'leaves drooping');
    await act(async () => {
      fireEvent.press(screen.getByTestId('add-note-sheet-save'));
      await flushMicrotasks();
    });
    expect(runAsync).not.toHaveBeenCalled();
    expect(withExclusiveTransactionAsync).not.toHaveBeenCalled();
  });
});
