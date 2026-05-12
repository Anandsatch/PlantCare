/**
 * AddPlantScreen tests.
 *
 * Coverage targets the contract surface:
 *   - Mount → compresses photo → fires identify request once.
 *   - Loading state during in-flight (DiagnoseLoadingState rendered).
 *   - kind='ok' renders top-3 candidates with confidence; tap selects;
 *     submit fires onSave with the right payload.
 *   - kind='no_match' renders the manual picker.
 *   - Manual picker filter narrows; tap a row → confirm; submit calls onSave.
 *   - "Pick from list" CTA on a happy-path result swaps to picker.
 *   - Nickname empty AND set both submit-able.
 *   - Submit disabled until species selected.
 *   - Reduce-motion: animations are hard-disabled (no transform).
 *   - Dark theme tokens swap.
 *   - A11y: every interactive has role + label; FlatList rows announce
 *     species + confidence.
 *   - AppState resume: in-flight identify doesn't double-fire.
 *
 * Test seam strategy:
 *   - `compressPhoto` is mocked at the module boundary so we don't pull
 *     `expo-image-manipulator` / `expo-file-system/legacy` into the node
 *     env. The screen also accepts `skipCompress` for tests that don't
 *     need the compression branch.
 *   - `useTheme` is mocked so dark-theme assertions pin the snapshot.
 *   - `AccessibilityInfo` is mocked so reduce-motion can be flipped.
 *   - The api client is a hand-rolled mock that returns whatever the
 *     individual test wants for `identify({ image })`.
 */
import { darkTheme, lightTheme } from '@plantcare/theme';
import { describe, expect, it, jest } from '@jest/globals';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react-native';
import * as RN from 'react-native';
import { AccessibilityInfo, AppState } from 'react-native';

// ─── module mocks ─────────────────────────────────────────────────────────

jest.mock('../../photos', () => ({
  __esModule: true,
  compressPhoto: jest.fn(),
  getPhotoDirectory: jest.fn(),
}));

jest.mock('../../hooks/useTheme', () => ({
  __esModule: true,
  useTheme: jest.fn(),
}));

import { compressPhoto } from '../../photos';
import { useTheme } from '../../hooks/useTheme';
import type { ApiClient, ApiResult, IdentifyResponse } from '../../api';
import {
  AddPlantScreen,
  toAddPlantResult,
  type AddPlantSavePayload,
} from '../AddPlantScreen';
import { SPECIES_CATALOG } from '../speciesCatalog';

// Typed factory: jest.fn() with a void-returning generic untyped under the
// new @types/jest infers `UnknownFunction` which doesn't match the screen's
// `(payload) => void | Promise<void>` signature. This helper produces a
// correctly-typed spy.
function onSaveMock() {
  return jest.fn() as unknown as jest.MockedFunction<
    (p: AddPlantSavePayload) => void | Promise<void>
  >;
}

const mockedCompress = compressPhoto as jest.MockedFunction<typeof compressPhoto>;
const mockedUseTheme = useTheme as jest.MockedFunction<typeof useTheme>;

// ─── helpers ──────────────────────────────────────────────────────────────

type IdentifyImpl = (input: {
  image: { uri: string } | Blob | { uri: string; name?: string; type?: string };
}) => Promise<ApiResult<IdentifyResponse>>;

function makeApiClient(identifyImpl: IdentifyImpl): {
  client: ApiClient;
  identifySpy: jest.Mock;
} {
  const identifySpy = jest.fn(identifyImpl as never);
  const client: ApiClient = {
    identify: identifySpy as never,
    diagnose: jest.fn() as never,
    consult: jest.fn() as never,
    review: jest.fn() as never,

    weather: jest.fn() as never,
  };
  return { client, identifySpy };
}

const OK_DATA: IdentifyResponse = {
  species_slug: 'monstera_deliciosa',
  species_label: 'Monstera Deliciosa',
  confidence: 92,
  alternatives: [
    { species_slug: 'philodendron', species_label: 'Philodendron', confidence: 6 },
    { species_slug: 'pothos', species_label: 'Pothos', confidence: 2 },
    // Fourth alt — should be dropped (top-3 cap).
    { species_slug: 'snake_plant', species_label: 'Snake Plant', confidence: 1 },
  ],
  source: 'free',
  latency_ms: 850,
};

const NO_MATCH_DATA: IdentifyResponse = {
  species_slug: 'unknown',
  species_label: 'Unknown',
  confidence: 0,
  alternatives: [],
  source: 'free_failed',
  latency_ms: 200,
};

function setupTheme(scheme: 'light' | 'dark' = 'light'): void {
  mockedUseTheme.mockReturnValue(scheme === 'dark' ? darkTheme : lightTheme);
}

function setupReduceMotion(enabled: boolean): void {
  jest
    .spyOn(AccessibilityInfo, 'isReduceMotionEnabled')
    .mockResolvedValue(enabled);
  jest.spyOn(AccessibilityInfo, 'addEventListener').mockReturnValue({
    remove: jest.fn(),
  } as never);
}

// ─── tests ────────────────────────────────────────────────────────────────

describe('AddPlantScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setupTheme('light');
    setupReduceMotion(false);
    mockedCompress.mockResolvedValue({
      uri: 'file:///compressed.jpg',
      width: 1024,
      height: 1024,
      sizeBytes: 100_000,
    });
  });

  it('mount: compresses photo then fires identify exactly once', async () => {
    const { client, identifySpy } = makeApiClient(async () => ({
      ok: true,
      data: OK_DATA,
    }));

    render(
      <AddPlantScreen
        photoUri="file:///raw.jpg"
        apiClient={client}
        onSave={onSaveMock()}
      />,
    );

    await waitFor(() => {
      expect(mockedCompress).toHaveBeenCalledTimes(1);
    });
    expect(mockedCompress).toHaveBeenCalledWith({ sourceUri: 'file:///raw.jpg' });

    await waitFor(() => {
      expect(identifySpy).toHaveBeenCalledTimes(1);
    });
    // identify uses the COMPRESSED uri, not the raw one.
    expect(identifySpy).toHaveBeenCalledWith({
      image: { uri: 'file:///compressed.jpg' },
    });
  });

  it('renders DiagnoseLoadingState while identify is in flight', async () => {
    let resolveIdentify: (r: ApiResult<IdentifyResponse>) => void = () => {};
    const pending = new Promise<ApiResult<IdentifyResponse>>((resolve) => {
      resolveIdentify = resolve;
    });
    const { client } = makeApiClient(() => pending);

    render(
      <AddPlantScreen
        photoUri="file:///raw.jpg"
        apiClient={client}
        onSave={onSaveMock()}
        testID="add"
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('add-loading')).toBeTruthy();
    });

    await act(async () => {
      resolveIdentify({ ok: true, data: OK_DATA });
    });

    await waitFor(() => {
      expect(screen.queryByTestId('add-loading')).toBeNull();
    });
  });

  it("kind='ok' renders top-3 candidates with confidence labels (4th alt dropped)", async () => {
    const { client } = makeApiClient(async () => ({ ok: true, data: OK_DATA }));

    render(
      <AddPlantScreen
        photoUri="file:///raw.jpg"
        apiClient={client}
        onSave={onSaveMock()}
        testID="add"
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('add-candidate-monstera_deliciosa')).toBeTruthy();
    });
    expect(screen.getByTestId('add-candidate-philodendron')).toBeTruthy();
    expect(screen.getByTestId('add-candidate-pothos')).toBeTruthy();
    expect(screen.queryByTestId('add-candidate-snake_plant')).toBeNull();

    expect(screen.getByText('92% CONFIDENT')).toBeTruthy();
    expect(screen.getByText('6% CONFIDENT')).toBeTruthy();
    expect(screen.getByText('2% CONFIDENT')).toBeTruthy();
  });

  it('candidate tap selects → submit fires onSave with the right payload', async () => {
    const onSave = onSaveMock();
    const { client } = makeApiClient(async () => ({ ok: true, data: OK_DATA }));

    render(
      <AddPlantScreen
        photoUri="file:///raw.jpg"
        apiClient={client}
        onSave={onSave}
        testID="add"
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('add-candidate-monstera_deliciosa')).toBeTruthy();
    });

    fireEvent.press(screen.getByTestId('add-candidate-monstera_deliciosa'));
    fireEvent.press(screen.getByTestId('add-submit'));

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledTimes(1);
    });
    expect(onSave.mock.calls[0]?.[0]).toEqual({
      species_slug: 'monstera_deliciosa',
      species_label: 'Monstera Deliciosa',
      identify_confidence: 92,
      photoUri: 'file:///compressed.jpg',
      // nickname omitted (empty input).
    });
  });

  it("kind='no_match' jumps straight to the manual picker", async () => {
    const { client } = makeApiClient(async () => ({
      ok: true,
      data: NO_MATCH_DATA,
    }));

    render(
      <AddPlantScreen
        photoUri="file:///raw.jpg"
        apiClient={client}
        onSave={onSaveMock()}
        testID="add"
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('add-picker')).toBeTruthy();
    });
    expect(screen.queryByTestId('add-candidates')).toBeNull();
    // 'no_match' is a confident "not found" — no error banner. The picker IS
    // the entire UX. (Codex P1 risk surface a: discriminated union not
    // collapsed; 'no_match' is structurally distinct from 'error'.)
    expect(screen.queryByTestId('add-banner-error')).toBeNull();
    expect(screen.queryByTestId('add-banner-queued')).toBeNull();
  });

  it('manual picker: filter narrows the list; tap a row selects it; submit calls onSave', async () => {
    const onSave = onSaveMock();
    const { client } = makeApiClient(async () => ({
      ok: true,
      data: NO_MATCH_DATA,
    }));

    render(
      <AddPlantScreen
        photoUri="file:///raw.jpg"
        apiClient={client}
        onSave={onSave}
        testID="add"
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('add-picker')).toBeTruthy();
    });

    // Before filter: pothos AND monstera both visible.
    expect(screen.getByTestId('add-picker-pothos')).toBeTruthy();
    expect(screen.getByTestId('add-picker-monstera_deliciosa')).toBeTruthy();

    fireEvent.changeText(screen.getByTestId('add-filter'), 'poth');

    await waitFor(() => {
      expect(screen.queryByTestId('add-picker-monstera_deliciosa')).toBeNull();
    });
    expect(screen.getByTestId('add-picker-pothos')).toBeTruthy();

    fireEvent.press(screen.getByTestId('add-picker-pothos'));
    fireEvent.press(screen.getByTestId('add-submit'));

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledTimes(1);
    });
    const arg = onSave.mock.calls[0]?.[0] as AddPlantSavePayload;
    expect(arg.species_slug).toBe('pothos');
    expect(arg.species_label).toBe('Pothos');
    // Manual picker: no confidence available — payload omits the field.
    expect(arg).not.toHaveProperty('identify_confidence');
  });

  it('"Pick from list" CTA on a happy-path result swaps to the picker view', async () => {
    const { client } = makeApiClient(async () => ({ ok: true, data: OK_DATA }));

    render(
      <AddPlantScreen
        photoUri="file:///raw.jpg"
        apiClient={client}
        onSave={onSaveMock()}
        testID="add"
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('add-candidates')).toBeTruthy();
    });

    fireEvent.press(screen.getByTestId('add-pick-from-list'));

    await waitFor(() => {
      expect(screen.getByTestId('add-picker')).toBeTruthy();
    });
    expect(screen.queryByTestId('add-candidates')).toBeNull();
  });

  it('nickname optional: submit works with nickname empty', async () => {
    const onSave = onSaveMock();
    const { client } = makeApiClient(async () => ({ ok: true, data: OK_DATA }));

    render(
      <AddPlantScreen
        photoUri="file:///raw.jpg"
        apiClient={client}
        onSave={onSave}
        testID="add"
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('add-candidate-monstera_deliciosa')).toBeTruthy();
    });
    fireEvent.press(screen.getByTestId('add-candidate-monstera_deliciosa'));
    fireEvent.press(screen.getByTestId('add-submit'));

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledTimes(1);
    });
    expect(onSave.mock.calls[0]?.[0]).not.toHaveProperty('nickname');
  });

  it('nickname optional: submit works with nickname set; emoji + unicode preserved verbatim', async () => {
    const onSave = onSaveMock();
    const { client } = makeApiClient(async () => ({ ok: true, data: OK_DATA }));

    render(
      <AddPlantScreen
        photoUri="file:///raw.jpg"
        apiClient={client}
        onSave={onSave}
        testID="add"
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('add-candidate-monstera_deliciosa')).toBeTruthy();
    });
    fireEvent.press(screen.getByTestId('add-candidate-monstera_deliciosa'));

    // Nickname with emoji + unicode + leading whitespace. All preserved.
    const NICKNAME = '  Steve 🌱 のお気に入り';
    fireEvent.changeText(screen.getByTestId('add-nickname'), NICKNAME);
    fireEvent.press(screen.getByTestId('add-submit'));

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledTimes(1);
    });
    expect(onSave.mock.calls[0]?.[0]?.nickname).toBe(NICKNAME);
  });

  it('submit is disabled until a species is selected', async () => {
    const onSave = onSaveMock();
    const { client } = makeApiClient(async () => ({ ok: true, data: OK_DATA }));

    render(
      <AddPlantScreen
        photoUri="file:///raw.jpg"
        apiClient={client}
        onSave={onSave}
        testID="add"
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('add-candidate-monstera_deliciosa')).toBeTruthy();
    });

    // No species selected. Tap submit — onSave should NOT fire (button disabled).
    fireEvent.press(screen.getByTestId('add-submit'));
    // Allow microtasks to drain so any erroneous setSaving flip would happen.
    await act(async () => {
      await Promise.resolve();
    });
    expect(onSave).not.toHaveBeenCalled();

    // Verify the disabled accessibility state on the button.
    const submit = screen.getByTestId('add-submit');
    expect(submit.props.accessibilityState?.disabled).toBe(true);

    // Now select and try again.
    fireEvent.press(screen.getByTestId('add-candidate-monstera_deliciosa'));
    fireEvent.press(screen.getByTestId('add-submit'));
    await waitFor(() => {
      expect(onSave).toHaveBeenCalledTimes(1);
    });
  });

  it('reduce-motion: animations hard-disabled (DiagnoseLoadingState dots flat-opacity)', async () => {
    setupReduceMotion(true);

    let resolveIdentify: (r: ApiResult<IdentifyResponse>) => void = () => {};
    const pending = new Promise<ApiResult<IdentifyResponse>>((resolve) => {
      resolveIdentify = resolve;
    });
    const { client } = makeApiClient(() => pending);

    render(
      <AddPlantScreen
        photoUri="file:///raw.jpg"
        apiClient={client}
        onSave={onSaveMock()}
        testID="add"
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('add-loading')).toBeTruthy();
    });

    // Reduce-motion path of DiagnoseLoadingState pins dots to STATIC_DOT_OPACITY (0.6)
    // and skips the Animated.loop. We don't reach into Animated internals; the
    // test's contract is "no transform applied to the screen surface." The
    // loading test ID is present and renders without throwing — the integrated
    // assertion. The DiagnoseLoadingState test file owns the per-pixel reduce
    // -motion contract.
    const loading = screen.getByTestId('add-loading');
    // The screen itself never applies a transform — a transform on this node
    // would be a bug (no fade-in / slide-in / scale on AddPlantScreen).
    const flatStyle = Array.isArray(loading.props.style)
      ? Object.assign({}, ...loading.props.style.flat().filter(Boolean))
      : (loading.props.style ?? {});
    expect((flatStyle as { transform?: unknown }).transform).toBeUndefined();

    await act(async () => {
      resolveIdentify({ ok: true, data: OK_DATA });
    });
  });

  it('dark theme: tokens swap (root bg uses darkTheme.colors.bg)', async () => {
    setupTheme('dark');
    const { client } = makeApiClient(async () => ({ ok: true, data: OK_DATA }));

    render(
      <AddPlantScreen
        photoUri="file:///raw.jpg"
        apiClient={client}
        onSave={onSaveMock()}
        testID="add"
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('add-candidates')).toBeTruthy();
    });

    const root = screen.getByLabelText('Add plant');
    const flatStyle = Array.isArray(root.props.style)
      ? Object.assign({}, ...root.props.style.flat().filter(Boolean))
      : (root.props.style ?? {});
    expect((flatStyle as { backgroundColor?: string }).backgroundColor).toBe(
      darkTheme.colors.bg,
    );
  });

  it('a11y: candidate cards announce species + confidence', async () => {
    const { client } = makeApiClient(async () => ({ ok: true, data: OK_DATA }));

    render(
      <AddPlantScreen
        photoUri="file:///raw.jpg"
        apiClient={client}
        onSave={onSaveMock()}
        testID="add"
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('add-candidate-monstera_deliciosa')).toBeTruthy();
    });

    const monstera = screen.getByTestId('add-candidate-monstera_deliciosa');
    expect(monstera.props.accessibilityRole).toBe('button');
    expect(monstera.props.accessibilityLabel).toBe(
      'Monstera Deliciosa, 92 percent confident',
    );
  });

  it('a11y: every interactive control has role + accessibilityLabel', async () => {
    const { client } = makeApiClient(async () => ({
      ok: true,
      data: NO_MATCH_DATA,
    }));

    render(
      <AddPlantScreen
        photoUri="file:///raw.jpg"
        apiClient={client}
        onSave={onSaveMock()}
        onCancel={jest.fn()}
        testID="add"
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('add-picker')).toBeTruthy();
    });

    // Submit button (EditorialButton): role + label.
    const submit = screen.getByTestId('add-submit');
    expect(submit.props.accessibilityRole).toBe('button');
    expect(submit.props.accessibilityLabel).toBeTruthy();

    // Filter input: label.
    const filter = screen.getByTestId('add-filter');
    expect(filter.props.accessibilityLabel).toBe('Filter species');

    // Nickname input: label.
    const nickname = screen.getByTestId('add-nickname');
    expect(nickname.props.accessibilityLabel).toBe('Nickname (optional)');

    // Cancel link.
    const cancel = screen.getByTestId('add-cancel');
    expect(cancel.props.accessibilityRole).toBe('button');
    expect(cancel.props.accessibilityLabel).toBe('Cancel and go back');

    // Picker rows.
    const pothosRow = screen.getByTestId('add-picker-pothos');
    expect(pothosRow.props.accessibilityRole).toBe('button');
    expect(pothosRow.props.accessibilityLabel).toBe('Pothos');
  });

  it('AppState resume: in-flight identify request does NOT double-fire', async () => {
    let resolveIdentify: (r: ApiResult<IdentifyResponse>) => void = () => {};
    const pending = new Promise<ApiResult<IdentifyResponse>>((resolve) => {
      resolveIdentify = resolve;
    });
    const { client, identifySpy } = makeApiClient(() => pending);

    let appStateListener: ((next: string) => void) | undefined;
    const addEventSpy = jest
      .spyOn(AppState, 'addEventListener')
      .mockImplementation(((event: string, cb: (next: string) => void) => {
        if (event === 'change') appStateListener = cb;
        return { remove: jest.fn() };
      }) as never);

    render(
      <AddPlantScreen
        photoUri="file:///raw.jpg"
        apiClient={client}
        onSave={onSaveMock()}
        testID="add"
      />,
    );

    await waitFor(() => {
      expect(identifySpy).toHaveBeenCalledTimes(1);
    });

    // Simulate background → foreground transition.
    expect(appStateListener).toBeDefined();
    act(() => {
      appStateListener?.('background');
      appStateListener?.('active');
    });

    // identify must STILL have been called exactly once.
    expect(identifySpy).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveIdentify({ ok: true, data: OK_DATA });
    });

    // Even after resolve, no second dispatch.
    expect(identifySpy).toHaveBeenCalledTimes(1);

    addEventSpy.mockRestore();
  });

  it('a11y focus handoff: setAccessibilityFocus fires on the candidates header when loading → ok swap completes', async () => {
    // Stub raf so we can flush the deferred focus call deterministically.
    const rafs: Array<FrameRequestCallback> = [];
    const rafSpy = jest
      .spyOn(global, 'requestAnimationFrame')
      .mockImplementation(((cb: FrameRequestCallback) => {
        rafs.push(cb);
        return rafs.length as unknown as number;
      }) as never);
    const cancelRafSpy = jest
      .spyOn(global, 'cancelAnimationFrame')
      .mockImplementation((() => {}) as never);

    const focusSpy = jest
      .spyOn(AccessibilityInfo, 'setAccessibilityFocus')
      .mockImplementation(() => {});
    // findNodeHandle returns null under jest's node test renderer (no native
    // tree). Stub to a deterministic handle so the focus effect proceeds.
    const findHandleSpy = jest
      .spyOn(RN, 'findNodeHandle')
      .mockReturnValue(42);

    const { client } = makeApiClient(async () => ({ ok: true, data: OK_DATA }));

    render(
      <AddPlantScreen
        photoUri="file:///raw.jpg"
        apiClient={client}
        onSave={onSaveMock()}
        testID="add"
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('add-candidates')).toBeTruthy();
    });

    // Flush any pending raf callbacks queued by the focus effect.
    act(() => {
      rafs.splice(0).forEach((cb) => cb(0));
    });

    expect(focusSpy).toHaveBeenCalledWith(42);

    rafSpy.mockRestore();
    cancelRafSpy.mockRestore();
    focusSpy.mockRestore();
    findHandleSpy.mockRestore();
  });

  it('queued result (offline) shows tan banner and lets the user fall back to picker', async () => {
    const { client } = makeApiClient(async () => ({ ok: false, kind: 'queued' }));

    render(
      <AddPlantScreen
        photoUri="file:///raw.jpg"
        apiClient={client}
        onSave={onSaveMock()}
        testID="add"
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('add-banner-queued')).toBeTruthy();
    });
    // Picker is the active view so the user can still pick a species manually.
    expect(screen.getByTestId('add-picker')).toBeTruthy();
  });

  it('compress failure: surfaces error banner + manual picker (user can still proceed)', async () => {
    mockedCompress.mockRejectedValueOnce(new Error('boom'));
    const { client, identifySpy } = makeApiClient(async () => ({
      ok: true,
      data: OK_DATA,
    }));

    render(
      <AddPlantScreen
        photoUri="file:///raw.jpg"
        apiClient={client}
        onSave={onSaveMock()}
        testID="add"
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('add-banner-error')).toBeTruthy();
    });
    expect(screen.getByTestId('add-picker')).toBeTruthy();
    // identify was never called because compression failed first.
    expect(identifySpy).not.toHaveBeenCalled();
  });

  // ─── offlineQueue prop wiring (v0.1.61.0 follow-up) ────────────────────
  describe('offlineQueue prop wiring', () => {
    it('forwards offlineQueue to useIdentifyRequest: network coercion enqueues', async () => {
      // api-client returns `network` → useIdentifyRequest coerces to `queued`
      // and (when offlineQueue is wired) persists via safeEnqueue.
      const { client } = makeApiClient(async () => ({ ok: false, kind: 'network' }));
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

      render(
        <AddPlantScreen
          photoUri="file:///raw.jpg"
          apiClient={client}
          onSave={onSaveMock()}
          skipCompress
          offlineQueue={{ db: fakeDb as never }}
          testID="add"
        />,
      );

      await waitFor(() => {
        expect(withExclusiveTransactionAsync).toHaveBeenCalledTimes(1);
      });
      // Verify the enqueue used the `identify` endpoint as the ref_table.
      const probeArgs = getFirstAsync.mock.calls[0];
      expect((probeArgs?.[1] as unknown[])?.[0]).toBe('identify');
      expect(runAsync).toHaveBeenCalled();
      const insertArgs = runAsync.mock.calls[0];
      expect(insertArgs?.[0]).toMatch(/INSERT INTO sync_queue/);
      expect((insertArgs?.[1] as unknown[])?.[1]).toBe('identify');
    });

    it('omitting offlineQueue keeps legacy behavior: no persistence calls', async () => {
      const { client } = makeApiClient(async () => ({ ok: false, kind: 'network' }));
      const runAsync = jest.fn();
      const withExclusiveTransactionAsync = jest.fn();

      render(
        <AddPlantScreen
          photoUri="file:///raw.jpg"
          apiClient={client}
          onSave={onSaveMock()}
          skipCompress
          testID="add"
        />,
      );

      // Wait for identify to settle; the queued surface should render
      // without any DB calls because no offlineQueue was wired.
      await waitFor(() => {
        // Allow a microtask flush for the identify chain.
        expect(client.identify).toHaveBeenCalled();
      });
      // A short delay for the post-call coercion path to complete.
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(runAsync).not.toHaveBeenCalled();
      expect(withExclusiveTransactionAsync).not.toHaveBeenCalled();
    });
  });
});

describe('toAddPlantResult', () => {
  it("ok + species_slug != 'unknown' + confidence > 0 → 'ok' with capped/sorted candidates", () => {
    const result = toAddPlantResult({ ok: true, data: OK_DATA });
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.candidates).toHaveLength(3);
      // Sorted descending by confidence: 92, 6, 2.
      expect(result.candidates.map((c) => c.confidence)).toEqual([92, 6, 2]);
      expect(result.candidates[0]?.slug).toBe('monstera_deliciosa');
    }
  });

  it("ok + species_slug === 'unknown' → 'no_match'", () => {
    const result = toAddPlantResult({ ok: true, data: NO_MATCH_DATA });
    expect(result.kind).toBe('no_match');
  });

  it("ok + confidence === 0 → 'no_match' (even with a non-unknown slug)", () => {
    const result = toAddPlantResult({
      ok: true,
      data: { ...OK_DATA, confidence: 0 },
    });
    expect(result.kind).toBe('no_match');
  });

  it("!ok + kind='queued' → 'queued'", () => {
    const result = toAddPlantResult({ ok: false, kind: 'queued' });
    expect(result.kind).toBe('queued');
  });

  it("!ok + kind='timeout' → 'error' with errorKind preserved", () => {
    const result = toAddPlantResult({ ok: false, kind: 'timeout' });
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.errorKind).toBe('timeout');
    }
  });

  it('catalog static reference: SPECIES_CATALOG has the expected stable entries', () => {
    // Smoke test — protects against accidental catalog rename / removal in
    // future PRs. The picker UI binds to slugs in this list.
    const slugs = SPECIES_CATALOG.map((e) => e.slug);
    expect(slugs).toContain('monstera_deliciosa');
    expect(slugs).toContain('pothos');
    expect(slugs).toContain('species_unknown');
  });
});
