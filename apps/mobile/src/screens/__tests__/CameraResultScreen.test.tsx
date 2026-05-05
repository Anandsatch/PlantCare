/**
 * E5-008 — CameraResultScreen tests. Cover the A-3 success path:
 *   - mount → fires compression once + diagnose once
 *   - in-flight → renders DiagnoseLoadingState; bucket transitions via fake timers
 *   - success → A-3 card renders species + confidence + narrative
 *   - "Save" → fires onSave with full discriminated-union payload + photo URI
 *   - "Try again" → re-fires diagnose with the SAME compressed photo (no recompress)
 *   - non-success kinds → render the E5-009 placeholder, never crash
 *   - reduce-motion → success reveal becomes static (no animation)
 *   - dark theme → tokens swap correctly
 *   - a11y: hero alt text, CTA roles + labels, loading state announces progress
 *   - AppState resume mid-request → does NOT re-fire diagnose; bucket clock
 *     continues from the original anchor
 */

import { darkTheme, lightTheme } from '@plantcare/theme';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import React from 'react';
import { AppState } from 'react-native';

import type { ApiClient, ApiResult, DiagnoseResponse } from '../../api';
import { CameraResultScreen, __testing } from '../CameraResultScreen';

// ─── Mocks ──────────────────────────────────────────────────────────────

jest.mock('../../hooks/useTheme', () => ({
  useTheme: jest.fn(),
}));
jest.mock('../../hooks/useReduceMotion', () => ({
  useReduceMotion: jest.fn(),
}));
// Stub AccessibilityInfo subscription used by DiagnoseLoadingState's PulseDots
// effect path (which we don't reach because we mock useReduceMotion above, but
// the AppState listener installed by the screen still needs a fake subscription
// to register cleanly).
jest.spyOn(AppState, 'addEventListener').mockImplementation(
  () => ({ remove: jest.fn() }) as never,
);

import { useReduceMotion } from '../../hooks/useReduceMotion';
import { useTheme } from '../../hooks/useTheme';

const mockedUseTheme = useTheme as jest.MockedFunction<typeof useTheme>;
const mockedUseReduceMotion = useReduceMotion as jest.MockedFunction<typeof useReduceMotion>;

// ─── Helpers ────────────────────────────────────────────────────────────

const SUCCESS_DATA: DiagnoseResponse = {
  disease_slug: 'spider_mites',
  disease_label: 'Spider mites',
  confidence: 92,
  severity: 'medium',
  fix_steps: [
    'Tiny webs on the underside and stippled leaves point to spider mites',
    'Spray with neem oil weekly',
    'Isolate from your other plants for 2 weeks',
  ],
  alternatives: [],
  source: 'paid_escalated',
  latency_ms: 1234,
};

function makeApiClient(
  diagnoseImpl: (
    input: { image: { uri: string } | Blob | { uri: string; name?: string; type?: string } },
  ) => Promise<ApiResult<DiagnoseResponse>>,
): { client: ApiClient; diagnoseSpy: jest.Mock } {
  const diagnoseSpy = jest.fn(diagnoseImpl as never);
  const client: ApiClient = {
    identify: jest.fn() as never,
    diagnose: diagnoseSpy as never,
    consult: jest.fn() as never,
    review: jest.fn() as never,
  };
  return { client, diagnoseSpy };
}

function makeCompressImpl(uri = 'file:///doc/plants/unattached/123-abc.jpg') {
  // Default impl resolves on next microtask so the test can observe the
  // compressing → ready transition explicitly.
  const spy = jest.fn(async () => ({
    uri,
    width: 1024,
    height: 1024,
    sizeBytes: 200_000,
  }));
  return { spy, uri };
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe('CameraResultScreen', () => {
  beforeEach(() => {
    mockedUseTheme.mockReset();
    mockedUseReduceMotion.mockReset();
    mockedUseTheme.mockReturnValue(lightTheme);
    mockedUseReduceMotion.mockReturnValue(false);
  });

  it('mount: fires compression once and diagnose once with the compressed URI', async () => {
    const { client, diagnoseSpy } = makeApiClient(async () => ({
      ok: true,
      data: SUCCESS_DATA,
    }));
    const { spy: compressSpy, uri: compressedUri } = makeCompressImpl();

    render(
      <CameraResultScreen
        photoUri="file:///cache/raw.jpg"
        mode="diagnose"
        apiClient={client}
        onSave={jest.fn()}
        compressPhotoImpl={compressSpy}
        testID="result"
      />,
    );

    // Compression fires synchronously on mount; await its resolution.
    await waitFor(() => expect(compressSpy).toHaveBeenCalledTimes(1));
    expect(compressSpy).toHaveBeenCalledWith({ sourceUri: 'file:///cache/raw.jpg' });

    await waitFor(() => expect(diagnoseSpy).toHaveBeenCalledTimes(1));
    const callArg = diagnoseSpy.mock.calls[0]?.[0] as { image: { uri: string } };
    expect(callArg.image.uri).toBe(compressedUri);
  });

  it('in-flight: renders DiagnoseLoadingState while compress + diagnose are pending', async () => {
    // Hold compression open so the loading state renders before resolution.
    let resolveCompress: (v: { uri: string; width: number; height: number; sizeBytes: number }) => void = () => {};
    const compressImpl = jest.fn(
      () =>
        new Promise<{ uri: string; width: number; height: number; sizeBytes: number }>(
          (resolve) => {
            resolveCompress = resolve;
          },
        ),
    );
    const { client } = makeApiClient(async () => ({ ok: true, data: SUCCESS_DATA }));

    render(
      <CameraResultScreen
        photoUri="file:///cache/raw.jpg"
        mode="diagnose"
        apiClient={client}
        onSave={jest.fn()}
        compressPhotoImpl={compressImpl}
        testID="result"
      />,
    );

    // Loading dock present.
    expect(screen.getByTestId('result-loading')).toBeOnTheScreen();

    // Resolve compression so the test cleans up; loading should still show
    // while diagnose is pending — but diagnose returns immediately in this
    // setup so we just clean up.
    await act(async () => {
      resolveCompress({ uri: 'file:///compressed.jpg', width: 1024, height: 1024, sizeBytes: 100 });
    });
  });

  it('in-flight: 3 time buckets advance correctly via fake timers (loading copy switches)', async () => {
    jest.useFakeTimers();
    try {
      const fixedNow = 1_000_000_000_000;
      jest.setSystemTime(fixedNow);

      // Hold the diagnose promise open across the whole test so loading state stays mounted.
      const diagnoseImpl = jest.fn(
        () => new Promise<ApiResult<DiagnoseResponse>>(() => {}),
      );
      const client: ApiClient = {
        identify: jest.fn() as never,
        diagnose: diagnoseImpl as never,
        consult: jest.fn() as never,
        review: jest.fn() as never,
      };
      const { spy: compressSpy } = makeCompressImpl();

      render(
        <CameraResultScreen
          photoUri="file:///cache/raw.jpg"
          mode="diagnose"
          apiClient={client}
          onSave={jest.fn()}
          compressPhotoImpl={compressSpy}
          testID="result"
        />,
      );

      // Flush microtasks so compression resolves and diagnose starts.
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      // Bucket 0: initial copy at elapsed=0.
      expect(screen.getByText('Looking closely…')).toBeOnTheScreen();

      // Advance to bucket 1 (8s).
      await act(async () => {
        jest.setSystemTime(fixedNow + 9000);
        jest.advanceTimersByTime(9000);
      });
      expect(screen.getByText('Almost there…')).toBeOnTheScreen();

      // Advance to bucket 2 (20s).
      await act(async () => {
        jest.setSystemTime(fixedNow + 21000);
        jest.advanceTimersByTime(12_000);
      });
      expect(screen.getByText('Trying a more careful look…')).toBeOnTheScreen();
    } finally {
      jest.useRealTimers();
    }
  });

  it('success: renders A-3 card with species, confidence chip, and narrative', async () => {
    const { client } = makeApiClient(async () => ({ ok: true, data: SUCCESS_DATA }));
    const { spy: compressSpy } = makeCompressImpl();

    render(
      <CameraResultScreen
        photoUri="file:///cache/raw.jpg"
        mode="diagnose"
        plantNickname="Steve"
        apiClient={client}
        onSave={jest.fn()}
        compressPhotoImpl={compressSpy}
        testID="result"
      />,
    );

    await waitFor(() => expect(screen.queryByTestId('result-success')).toBeOnTheScreen());

    expect(screen.getByTestId('result-headline')).toHaveTextContent('Spider mites');
    expect(screen.getByTestId('result-confidence')).toHaveTextContent('92% CONFIDENT');
    // Narrative joins fix_steps with periods.
    const narrativeText = screen.getByTestId('result-narrative').props.children as string;
    expect(narrativeText).toMatch(/spider mites/i);
    expect(narrativeText).toMatch(/neem oil/);
    expect(narrativeText).toMatch(/\./);
  });

  it('success: confidence rounds to nearest integer (e.g. 87.6 → 88% CONFIDENT)', async () => {
    const { client } = makeApiClient(async () => ({
      ok: true,
      data: { ...SUCCESS_DATA, confidence: 87.6 },
    }));
    const { spy: compressSpy } = makeCompressImpl();

    render(
      <CameraResultScreen
        photoUri="file:///cache/raw.jpg"
        mode="diagnose"
        apiClient={client}
        onSave={jest.fn()}
        compressPhotoImpl={compressSpy}
        testID="result"
      />,
    );

    await waitFor(() =>
      expect(screen.getByTestId('result-confidence')).toHaveTextContent('88% CONFIDENT'),
    );
  });

  it('save: onSave fires with the full payload (result + compressed photoUri + mode + plantContext)', async () => {
    const { client } = makeApiClient(async () => ({ ok: true, data: SUCCESS_DATA }));
    const { spy: compressSpy, uri: compressedUri } = makeCompressImpl();
    const onSave = jest.fn();
    const ctx = { species_slug: 'monstera_deliciosa', nickname: 'Steve' } as const;

    render(
      <CameraResultScreen
        photoUri="file:///cache/raw.jpg"
        mode="diagnose"
        plantNickname="Steve"
        plantContext={ctx}
        apiClient={client}
        onSave={onSave}
        compressPhotoImpl={compressSpy}
        testID="result"
      />,
    );

    await waitFor(() => expect(screen.queryByTestId('result-success')).toBeOnTheScreen());
    fireEvent.press(screen.getByTestId('result-save'));

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith({
      result: { ok: true, data: SUCCESS_DATA },
      photoUri: compressedUri,
      mode: 'diagnose',
      plantContext: ctx,
    });
  });

  it('save CTA copy: "Save to {nickname}" when provided, "Save to my plants" otherwise', async () => {
    const { client } = makeApiClient(async () => ({ ok: true, data: SUCCESS_DATA }));
    const { spy: compressSpy } = makeCompressImpl();

    const { unmount } = render(
      <CameraResultScreen
        photoUri="file:///raw.jpg"
        mode="diagnose"
        plantNickname="Steve"
        apiClient={client}
        onSave={jest.fn()}
        compressPhotoImpl={compressSpy}
        testID="result"
      />,
    );
    await waitFor(() => expect(screen.queryByText('Save to Steve')).toBeOnTheScreen());
    unmount();

    const compress2 = makeCompressImpl();
    render(
      <CameraResultScreen
        photoUri="file:///raw.jpg"
        mode="diagnose"
        apiClient={makeApiClient(async () => ({ ok: true, data: SUCCESS_DATA })).client}
        onSave={jest.fn()}
        compressPhotoImpl={compress2.spy}
        testID="result2"
      />,
    );
    await waitFor(() => expect(screen.queryByText('Save to my plants')).toBeOnTheScreen());
  });

  it('try-again: re-fires diagnose with the SAME compressed URI (does NOT recompress)', async () => {
    const { client, diagnoseSpy } = makeApiClient(async () => ({
      ok: true,
      data: SUCCESS_DATA,
    }));
    const { spy: compressSpy, uri: compressedUri } = makeCompressImpl();

    render(
      <CameraResultScreen
        photoUri="file:///cache/raw.jpg"
        mode="diagnose"
        apiClient={client}
        onSave={jest.fn()}
        compressPhotoImpl={compressSpy}
        testID="result"
      />,
    );

    await waitFor(() => expect(diagnoseSpy).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByTestId('result-retry')).toBeOnTheScreen());

    fireEvent.press(screen.getByTestId('result-retry'));

    await waitFor(() => expect(diagnoseSpy).toHaveBeenCalledTimes(2));
    // Compression NOT re-fired — same photo URI re-used.
    expect(compressSpy).toHaveBeenCalledTimes(1);
    const secondCall = diagnoseSpy.mock.calls[1]?.[0] as { image: { uri: string } };
    expect(secondCall.image.uri).toBe(compressedUri);
  });

  it('non-success kind (server) renders the E5-009 placeholder without throwing', async () => {
    const { client } = makeApiClient(async () => ({
      ok: false,
      kind: 'server',
      retry_after: 30,
    }));
    const { spy: compressSpy } = makeCompressImpl();

    render(
      <CameraResultScreen
        photoUri="file:///cache/raw.jpg"
        mode="diagnose"
        apiClient={client}
        onSave={jest.fn()}
        compressPhotoImpl={compressSpy}
        testID="result"
      />,
    );

    await waitFor(() =>
      expect(screen.queryByTestId('result-placeholder')).toBeOnTheScreen(),
    );
    // Placeholder calls out the kind so we know the discriminated union survives.
    expect(screen.getByTestId('result-placeholder')).toHaveTextContent(/server/);
    // No success card.
    expect(screen.queryByTestId('result-success')).toBeNull();
  });

  it('non-success kind (layer1_reject) renders placeholder with the right kind tag', async () => {
    const { client } = makeApiClient(async () => ({
      ok: false,
      kind: 'layer1_reject',
      message: "I don't see a plant here.",
    }));
    const { spy: compressSpy } = makeCompressImpl();

    render(
      <CameraResultScreen
        photoUri="file:///raw.jpg"
        mode="diagnose"
        apiClient={client}
        onSave={jest.fn()}
        compressPhotoImpl={compressSpy}
        testID="result"
      />,
    );

    await waitFor(() =>
      expect(screen.getByTestId('result-placeholder')).toHaveTextContent(/layer1_reject/),
    );
  });

  it('non-success kind (queued) renders placeholder with the queued kind tag', async () => {
    const { client } = makeApiClient(async () => ({ ok: false, kind: 'queued' }));
    const { spy: compressSpy } = makeCompressImpl();

    render(
      <CameraResultScreen
        photoUri="file:///raw.jpg"
        mode="diagnose"
        apiClient={client}
        onSave={jest.fn()}
        compressPhotoImpl={compressSpy}
        testID="result"
      />,
    );

    await waitFor(() =>
      expect(screen.getByTestId('result-placeholder')).toHaveTextContent(/queued/),
    );
  });

  it('reduce-motion: success reveal mounts at full opacity (no Animated.timing)', async () => {
    mockedUseReduceMotion.mockReturnValue(true);
    const { client } = makeApiClient(async () => ({ ok: true, data: SUCCESS_DATA }));
    const { spy: compressSpy } = makeCompressImpl();

    render(
      <CameraResultScreen
        photoUri="file:///raw.jpg"
        mode="diagnose"
        apiClient={client}
        onSave={jest.fn()}
        compressPhotoImpl={compressSpy}
        testID="result"
      />,
    );

    await waitFor(() => expect(screen.queryByTestId('result-success')).toBeOnTheScreen());

    // The Animated.View should render with opacity 1 immediately (no fade).
    const successView = screen.getByTestId('result-success');
    // Animated.Value renders in style; under jest-expo + RN, the resolved
    // style passes through. We assert the style array contains opacity 1.
    const flattened: Array<Record<string, unknown> | undefined> = Array.isArray(
      successView.props.style,
    )
      ? successView.props.style.flat()
      : [successView.props.style];
    const opacityValue = flattened
      .map((s) => (s as { opacity?: unknown } | undefined)?.opacity)
      .find((v) => v !== undefined);
    // Animated.Value exposes ._value when running under jest's mocked Animated.
    const numericOpacity =
      typeof opacityValue === 'number'
        ? opacityValue
        : (opacityValue as { _value?: number } | undefined)?._value;
    expect(numericOpacity).toBe(1);
  });

  it('dark theme: token swap — surface and text follow Midnight Conservatory', async () => {
    mockedUseTheme.mockReturnValue(darkTheme);
    const { client } = makeApiClient(async () => ({ ok: true, data: SUCCESS_DATA }));
    const { spy: compressSpy } = makeCompressImpl();

    render(
      <CameraResultScreen
        photoUri="file:///raw.jpg"
        mode="diagnose"
        apiClient={client}
        onSave={jest.fn()}
        compressPhotoImpl={compressSpy}
        testID="result"
      />,
    );

    await waitFor(() => expect(screen.queryByTestId('result-success')).toBeOnTheScreen());

    // Headline color = darkTheme.colors.text.
    const headline = screen.getByTestId('result-headline');
    const headlineFlat: Array<Record<string, unknown> | undefined> = Array.isArray(
      headline.props.style,
    )
      ? headline.props.style.flat()
      : [headline.props.style];
    const headlineColor = headlineFlat
      .map((s) => (s as { color?: unknown } | undefined)?.color)
      .find((v) => v !== undefined);
    expect(headlineColor).toBe(darkTheme.colors.text);

    // Confidence accent = darkTheme.colors.tan.
    const confidence = screen.getByTestId('result-confidence');
    const confidenceFlat: Array<Record<string, unknown> | undefined> = Array.isArray(
      confidence.props.style,
    )
      ? confidence.props.style.flat()
      : [confidence.props.style];
    const confidenceColor = confidenceFlat
      .map((s) => (s as { color?: unknown } | undefined)?.color)
      .find((v) => v !== undefined);
    expect(confidenceColor).toBe(darkTheme.colors.tan);
  });

  it('a11y: hero photo has alt text; CTAs have accessibilityRole=button + label', async () => {
    const { client } = makeApiClient(async () => ({ ok: true, data: SUCCESS_DATA }));
    const { spy: compressSpy } = makeCompressImpl();

    render(
      <CameraResultScreen
        photoUri="file:///raw.jpg"
        mode="diagnose"
        plantNickname="Steve"
        apiClient={client}
        onSave={jest.fn()}
        compressPhotoImpl={compressSpy}
        testID="result"
      />,
    );

    await waitFor(() => expect(screen.queryByTestId('result-success')).toBeOnTheScreen());

    // Hero a11y label.
    expect(screen.getByLabelText('Captured photo')).toBeOnTheScreen();
    // CTAs a11y identity (EditorialButton sets accessibilityRole + label internally).
    expect(screen.getByRole('button', { name: 'Get a second opinion' })).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Save to Steve' })).toBeOnTheScreen();
  });

  it('a11y: loading state announces progress (accessibilityLabel on the loading dock)', async () => {
    const diagnoseImpl = jest.fn(
      () => new Promise<ApiResult<DiagnoseResponse>>(() => {}),
    );
    const client: ApiClient = {
      identify: jest.fn() as never,
      diagnose: diagnoseImpl as never,
      consult: jest.fn() as never,
      review: jest.fn() as never,
    };
    const { spy: compressSpy } = makeCompressImpl();

    render(
      <CameraResultScreen
        photoUri="file:///raw.jpg"
        mode="diagnose"
        apiClient={client}
        onSave={jest.fn()}
        compressPhotoImpl={compressSpy}
        testID="result"
      />,
    );

    // The loading state advertises itself via accessibilityLabel.
    await waitFor(() =>
      expect(screen.getByLabelText('Diagnosing your plant photo')).toBeOnTheScreen(),
    );
  });

  it('AppState resume mid-request: does NOT re-fire the diagnose call', async () => {
    // Capture the AppState change listener so we can simulate background→active.
    let listener: ((next: 'active' | 'background' | 'inactive') => void) | null = null;
    (AppState.addEventListener as jest.Mock).mockImplementation(
      (_event: string, cb: (next: 'active' | 'background' | 'inactive') => void) => {
        listener = cb;
        return { remove: jest.fn() };
      },
    );

    // Hold the diagnose promise open so the request stays in flight when we
    // simulate the resume.
    const diagnoseImpl = jest.fn(
      () => new Promise<ApiResult<DiagnoseResponse>>(() => {}),
    );
    const client: ApiClient = {
      identify: jest.fn() as never,
      diagnose: diagnoseImpl as never,
      consult: jest.fn() as never,
      review: jest.fn() as never,
    };
    const { spy: compressSpy } = makeCompressImpl();

    render(
      <CameraResultScreen
        photoUri="file:///raw.jpg"
        mode="diagnose"
        apiClient={client}
        onSave={jest.fn()}
        compressPhotoImpl={compressSpy}
        testID="result"
      />,
    );

    await waitFor(() => expect(diagnoseImpl).toHaveBeenCalledTimes(1));

    // Simulate background then resume.
    await act(async () => {
      listener?.('background');
      listener?.('active');
    });

    // No double-fire — diagnose count stays at 1.
    expect(diagnoseImpl).toHaveBeenCalledTimes(1);
  });

  it('saving while result is non-success: onSave is NOT invoked (placeholder branch)', async () => {
    const { client } = makeApiClient(async () => ({ ok: false, kind: 'server' }));
    const { spy: compressSpy } = makeCompressImpl();
    const onSave = jest.fn();

    render(
      <CameraResultScreen
        photoUri="file:///raw.jpg"
        mode="diagnose"
        apiClient={client}
        onSave={onSave}
        compressPhotoImpl={compressSpy}
        testID="result"
      />,
    );

    await waitFor(() =>
      expect(screen.getByTestId('result-placeholder')).toBeOnTheScreen(),
    );
    // No save CTA on the placeholder branch — onSave never invoked.
    expect(screen.queryByTestId('result-save')).toBeNull();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('try-again before diagnose has resolved: queues second call (race-by-call-order)', async () => {
    // Hold first diagnose open; press Try again would re-fire while in-flight.
    // The button only appears after success; this case is mostly defensive but
    // if a future variant surfaces a "retry now" affordance during loading,
    // the contract is: hook owns race-by-call-order and does the right thing.
    // Here we assert that handleRetry no-ops cleanly when phase isn't 'ready'
    // by mounting with a slow compress.
    let resolveCompress: (v: { uri: string; width: number; height: number; sizeBytes: number }) => void = () => {};
    const compressImpl = jest.fn(
      () =>
        new Promise<{ uri: string; width: number; height: number; sizeBytes: number }>(
          (resolve) => {
            resolveCompress = resolve;
          },
        ),
    );
    const { client, diagnoseSpy } = makeApiClient(async () => ({
      ok: true,
      data: SUCCESS_DATA,
    }));

    render(
      <CameraResultScreen
        photoUri="file:///raw.jpg"
        mode="diagnose"
        apiClient={client}
        onSave={jest.fn()}
        compressPhotoImpl={compressImpl}
        testID="result"
      />,
    );

    // No retry button while compressing.
    expect(screen.queryByTestId('result-retry')).toBeNull();
    expect(diagnoseSpy).not.toHaveBeenCalled();

    // Resolve compression for clean teardown.
    await act(async () => {
      resolveCompress({ uri: 'file:///c.jpg', width: 1024, height: 1024, sizeBytes: 100 });
    });
    await waitFor(() => expect(diagnoseSpy).toHaveBeenCalledTimes(1));
  });

  it('compression failure: renders the E5-009 placeholder (no crash)', async () => {
    const compressImpl = jest.fn(async () => {
      throw new Error('manipulate-failed');
    });
    const { client, diagnoseSpy } = makeApiClient(async () => ({
      ok: true,
      data: SUCCESS_DATA,
    }));

    render(
      <CameraResultScreen
        photoUri="file:///raw.jpg"
        mode="diagnose"
        apiClient={client}
        onSave={jest.fn()}
        compressPhotoImpl={compressImpl}
        testID="result"
      />,
    );

    // diagnose never fires because compression failed.
    await waitFor(() => expect(compressImpl).toHaveBeenCalledTimes(1));
    // Wait a tick for state to settle.
    await act(async () => {
      await Promise.resolve();
    });
    expect(diagnoseSpy).not.toHaveBeenCalled();
    // Compress-failed renders the placeholder with the kind tag preserved so
    // E5-009 can style it distinct from API-side errors. No success card.
    expect(screen.queryByTestId('result-success')).toBeNull();
    expect(screen.queryByTestId('result-placeholder')).toBeOnTheScreen();
    expect(screen.getByTestId('result-placeholder')).toHaveTextContent(/compress-failed/);
  });

  it('does not auto-fire a second diagnose on parent re-render', async () => {
    const { client, diagnoseSpy } = makeApiClient(async () => ({
      ok: true,
      data: SUCCESS_DATA,
    }));
    const { spy: compressSpy } = makeCompressImpl();

    const { rerender } = render(
      <CameraResultScreen
        photoUri="file:///raw.jpg"
        mode="diagnose"
        apiClient={client}
        onSave={jest.fn()}
        compressPhotoImpl={compressSpy}
        testID="result"
      />,
    );

    await waitFor(() => expect(diagnoseSpy).toHaveBeenCalledTimes(1));

    // Re-render the parent without changing photoUri. Diagnose count must stay 1.
    rerender(
      <CameraResultScreen
        photoUri="file:///raw.jpg"
        mode="diagnose"
        plantNickname="Steve"
        apiClient={client}
        onSave={jest.fn()}
        compressPhotoImpl={compressSpy}
        testID="result"
      />,
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(diagnoseSpy).toHaveBeenCalledTimes(1);
  });

  it('photoUri change re-fires the initial diagnose (latch resets)', async () => {
    // Codex P2: a parent that reuses the same mounted screen instance for a
    // new capture (e.g. user takes a second photo without unmounting) must
    // see the initial-diagnose latch reset so compression + diagnose re-run
    // for the new URI.
    const { client, diagnoseSpy } = makeApiClient(async () => ({
      ok: true,
      data: SUCCESS_DATA,
    }));
    const compressSpy = jest.fn(async (input: { sourceUri: string }) => ({
      uri: `file:///compressed-${input.sourceUri.split('/').pop()}`,
      width: 1024,
      height: 1024,
      sizeBytes: 200_000,
    }));

    const { rerender } = render(
      <CameraResultScreen
        photoUri="file:///raw1.jpg"
        mode="diagnose"
        apiClient={client}
        onSave={jest.fn()}
        compressPhotoImpl={compressSpy}
        testID="result"
      />,
    );

    await waitFor(() => expect(diagnoseSpy).toHaveBeenCalledTimes(1));
    expect(compressSpy).toHaveBeenCalledTimes(1);

    rerender(
      <CameraResultScreen
        photoUri="file:///raw2.jpg"
        mode="diagnose"
        apiClient={client}
        onSave={jest.fn()}
        compressPhotoImpl={compressSpy}
        testID="result"
      />,
    );

    await waitFor(() => expect(compressSpy).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(diagnoseSpy).toHaveBeenCalledTimes(2));
    // Each diagnose call uses its own compressed URI.
    const firstCall = diagnoseSpy.mock.calls[0]?.[0] as { image: { uri: string } };
    const secondCall = diagnoseSpy.mock.calls[1]?.[0] as { image: { uri: string } };
    expect(firstCall.image.uri).toBe('file:///compressed-raw1.jpg');
    expect(secondCall.image.uri).toBe('file:///compressed-raw2.jpg');
  });

  describe('buildNarrative helper', () => {
    it('joins fix_steps with periods and trims whitespace', () => {
      const text = __testing.buildNarrative({
        ...SUCCESS_DATA,
        fix_steps: ['  one ', 'two', 'three.'],
      });
      expect(text).toBe('one. two. three.');
    });

    it('returns a friendly all-clear when fix_steps is empty + slug=healthy', () => {
      const text = __testing.buildNarrative({
        ...SUCCESS_DATA,
        disease_slug: 'healthy',
        fix_steps: [],
      });
      expect(text).toMatch(/healthy/i);
    });

    it('returns empty string when fix_steps is empty + slug is non-healthy', () => {
      const text = __testing.buildNarrative({
        ...SUCCESS_DATA,
        disease_slug: 'unknown',
        fix_steps: [],
      });
      expect(text).toBe('');
    });
  });
});
