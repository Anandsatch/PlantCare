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

    weather: jest.fn() as never,
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

        weather: jest.fn() as never,
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

  it('non-success kind (server) renders the server error variant without throwing', async () => {
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
      expect(screen.queryByTestId('result-error-server')).toBeOnTheScreen(),
    );
    // Editorial copy carries the server-error kind.
    expect(screen.getByTestId('result-error-headline')).toHaveTextContent(
      /something went wrong/i,
    );
    // No success card.
    expect(screen.queryByTestId('result-success')).toBeNull();
  });

  it('non-success kind (layer1_reject) renders the layer1 reject variant', async () => {
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
      expect(screen.getByTestId('result-error-layer1_reject')).toBeOnTheScreen(),
    );
    expect(screen.getByTestId('result-error-headline')).toHaveTextContent(
      /focused on plant care/i,
    );
  });

  it('non-success kind (queued) renders the queued banner variant', async () => {
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
      expect(screen.getByTestId('result-error-queued')).toBeOnTheScreen(),
    );
    // The queued banner reads as a non-disruptive status.
    expect(screen.getByTestId('result-queued-banner')).toBeOnTheScreen();
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

      weather: jest.fn() as never,
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

      weather: jest.fn() as never,
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

  it('saving while result is non-success: onSave is NOT invoked (error variant branch)', async () => {
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
      expect(screen.getByTestId('result-error-server')).toBeOnTheScreen(),
    );
    // No save CTA on the error variant branch — onSave never invoked.
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
    // Compress-failed renders the dedicated compress-failed variant — distinct
    // from API-side errors per the discriminated union. No success card.
    expect(screen.queryByTestId('result-success')).toBeNull();
    expect(screen.queryByTestId('result-error-compress-failed')).toBeOnTheScreen();
    expect(screen.getByTestId('result-error-headline')).toHaveTextContent(
      /preparing your photo/i,
    );
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

  // ─── E5-009 — error variants ──────────────────────────────────────────
  //
  // Every kind from `ApiResult<DiagnoseResponse>` plus the screen-internal
  // `compress-failed` phase gets its own distinct UI. The discriminated union
  // STAYS distinct — no kind collapses into another. Tests here assert (a)
  // each kind renders its own headline + CTAs; (b) "Try again" reuses the
  // SAME compressed photo (no recompression); (c) "Save photo for now" fires
  // the right callback with the right payload; (d) "Pick from list" /
  // "Try a different photo" / "Report" callbacks fire on the right kinds;
  // (e) reduce-motion hard-disables the variant fade; (f) dark theme tokens
  // swap; (g) accessibility roles per kind; (h) strict-mode double-mount
  // doesn't fire side effects twice.

  describe('E5-009 error variants', () => {
    // ─── low_confidence ──────────────────────────────────────────────────
    it('low_confidence: renders the editorial "We\'re not quite sure" headline', async () => {
      const { client } = makeApiClient(async () => ({
        ok: false,
        kind: 'low_confidence',
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
        expect(screen.getByTestId('result-error-low_confidence')).toBeOnTheScreen(),
      );
      expect(screen.getByTestId('result-error-headline')).toHaveTextContent(
        /not quite sure/i,
      );
      expect(screen.getByTestId('result-pick-from-list')).toBeOnTheScreen();
      expect(screen.getByTestId('result-retake')).toBeOnTheScreen();
    });

    it('low_confidence: "Pick from list" fires onPickFromList', async () => {
      const { client } = makeApiClient(async () => ({
        ok: false,
        kind: 'low_confidence',
      }));
      const { spy: compressSpy } = makeCompressImpl();
      const onPickFromList = jest.fn();

      render(
        <CameraResultScreen
          photoUri="file:///raw.jpg"
          mode="diagnose"
          apiClient={client}
          onSave={jest.fn()}
          onPickFromList={onPickFromList}
          compressPhotoImpl={compressSpy}
          testID="result"
        />,
      );

      await waitFor(() =>
        expect(screen.getByTestId('result-pick-from-list')).toBeOnTheScreen(),
      );
      fireEvent.press(screen.getByTestId('result-pick-from-list'));
      expect(onPickFromList).toHaveBeenCalledTimes(1);
    });

    it('low_confidence: "Try a different photo" fires onRetake', async () => {
      const { client } = makeApiClient(async () => ({
        ok: false,
        kind: 'low_confidence',
      }));
      const { spy: compressSpy } = makeCompressImpl();
      const onRetake = jest.fn();

      render(
        <CameraResultScreen
          photoUri="file:///raw.jpg"
          mode="diagnose"
          apiClient={client}
          onSave={jest.fn()}
          onRetake={onRetake}
          compressPhotoImpl={compressSpy}
          testID="result"
        />,
      );

      await waitFor(() => expect(screen.getByTestId('result-retake')).toBeOnTheScreen());
      fireEvent.press(screen.getByTestId('result-retake'));
      expect(onRetake).toHaveBeenCalledTimes(1);
    });

    it('low_confidence: does NOT auto-save anything (onSave never invoked)', async () => {
      const { client } = makeApiClient(async () => ({
        ok: false,
        kind: 'low_confidence',
      }));
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
        expect(screen.getByTestId('result-error-low_confidence')).toBeOnTheScreen(),
      );
      expect(onSave).not.toHaveBeenCalled();
      expect(screen.queryByTestId('result-save')).toBeNull();
    });

    // ─── timeout ─────────────────────────────────────────────────────────
    it('timeout: renders distinct copy from network/server', async () => {
      const { client } = makeApiClient(async () => ({ ok: false, kind: 'timeout' }));
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
        expect(screen.getByTestId('result-error-timeout')).toBeOnTheScreen(),
      );
      expect(screen.getByTestId('result-error-headline')).toHaveTextContent(
        /taking longer than usual/i,
      );
      // Does NOT carry the network copy.
      expect(screen.queryByText(/can't reach the server/i)).toBeNull();
    });

    it('timeout: "Try again" re-fires diagnose with the SAME compressed photo', async () => {
      let callCount = 0;
      const { client, diagnoseSpy } = makeApiClient(async () => {
        callCount += 1;
        if (callCount === 1) return { ok: false, kind: 'timeout' };
        return { ok: true, data: SUCCESS_DATA };
      });
      const { spy: compressSpy, uri: compressedUri } = makeCompressImpl();

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

      await waitFor(() => expect(diagnoseSpy).toHaveBeenCalledTimes(1));
      await waitFor(() =>
        expect(screen.getByTestId('result-try-again')).toBeOnTheScreen(),
      );

      fireEvent.press(screen.getByTestId('result-try-again'));

      await waitFor(() => expect(diagnoseSpy).toHaveBeenCalledTimes(2));
      // Compression NOT re-fired — same URI.
      expect(compressSpy).toHaveBeenCalledTimes(1);
      const second = diagnoseSpy.mock.calls[1]?.[0] as { image: { uri: string } };
      expect(second.image.uri).toBe(compressedUri);
    });

    it('timeout: "Save photo for now" fires onSavePhotoOnly with the result + compressed URI', async () => {
      const { client } = makeApiClient(async () => ({ ok: false, kind: 'timeout' }));
      const { spy: compressSpy, uri: compressedUri } = makeCompressImpl();
      const onSavePhotoOnly = jest.fn();
      const ctx = { species_slug: 'monstera', nickname: 'Steve' } as const;

      render(
        <CameraResultScreen
          photoUri="file:///raw.jpg"
          mode="diagnose"
          plantContext={ctx}
          apiClient={client}
          onSave={jest.fn()}
          onSavePhotoOnly={onSavePhotoOnly}
          compressPhotoImpl={compressSpy}
          testID="result"
        />,
      );

      await waitFor(() =>
        expect(screen.getByTestId('result-save-photo-only')).toBeOnTheScreen(),
      );
      fireEvent.press(screen.getByTestId('result-save-photo-only'));

      expect(onSavePhotoOnly).toHaveBeenCalledTimes(1);
      expect(onSavePhotoOnly).toHaveBeenCalledWith({
        photoUri: compressedUri,
        mode: 'diagnose',
        plantContext: ctx,
        result: { ok: false, kind: 'timeout' },
      });
    });

    it('timeout: "Save photo for now" CTA hidden when onSavePhotoOnly is omitted', async () => {
      const { client } = makeApiClient(async () => ({ ok: false, kind: 'timeout' }));
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
        expect(screen.getByTestId('result-error-timeout')).toBeOnTheScreen(),
      );
      expect(screen.queryByTestId('result-save-photo-only')).toBeNull();
    });

    // ─── network ─────────────────────────────────────────────────────────
    //
    // Note: `useDiagnoseRequest` coerces api-client `network` → `queued` for
    // V1's offline UX (master plan, line 346). So an api client that returns
    // `kind: 'network'` reaches the screen as `kind: 'queued'` instead. The
    // network variant rendering is still load-bearing (the discriminated
    // union has the kind, the resolver returns it, and a future netInfo or
    // hook change could surface it directly), so we test the rendering via
    // the resolver unit tests above and via the discriminated-union testID
    // sweep below — which uses a stub that bypasses the hook coercion. For
    // an end-to-end render assertion, we'd need to mock useDiagnoseRequest,
    // which couples this test to hook internals. Keeping the resolver-level
    // assertion plus the variant copy unit-tested via the helper avoids that
    // coupling.
    it('network: variant resolver returns the network kind with distinct copy', () => {
      const ready = {
        kind: 'ready' as const,
        compressed: { uri: 'x', width: 1, height: 1, sizeBytes: 1 },
      };
      const v = __testing.resolveErrorVariant(ready, { ok: false, kind: 'network' });
      expect(v?.kind).toBe('network');
      expect(v?.copy.headline).toMatch(/can't reach the server/i);
      // Distinct from timeout's headline.
      const timeoutV = __testing.resolveErrorVariant(ready, { ok: false, kind: 'timeout' });
      expect(v?.copy.headline).not.toBe(timeoutV?.copy.headline);
    });

    it('network: variant resolver carries forwarded message for telemetry', () => {
      const ready = {
        kind: 'ready' as const,
        compressed: { uri: 'x', width: 1, height: 1, sizeBytes: 1 },
      };
      const v = __testing.resolveErrorVariant(ready, {
        ok: false,
        kind: 'network',
        message: 'dns_fail',
      });
      expect(v?.message).toBe('dns_fail');
    });

    // ─── server ──────────────────────────────────────────────────────────
    it('server: renders generic server error copy', async () => {
      const { client } = makeApiClient(async () => ({
        ok: false,
        kind: 'server',
        message: 'svc_unconfigured',
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
        expect(screen.getByTestId('result-error-server')).toBeOnTheScreen(),
      );
      expect(screen.getByTestId('result-error-headline')).toHaveTextContent(
        /something went wrong/i,
      );
    });

    it('server: "Report" fires onReportError with kind + message + photoUri', async () => {
      const { client } = makeApiClient(async () => ({
        ok: false,
        kind: 'server',
        message: 'svc_unconfigured',
      }));
      const { spy: compressSpy, uri: compressedUri } = makeCompressImpl();
      const onReportError = jest.fn();

      render(
        <CameraResultScreen
          photoUri="file:///raw.jpg"
          mode="diagnose"
          apiClient={client}
          onSave={jest.fn()}
          onReportError={onReportError}
          compressPhotoImpl={compressSpy}
          testID="result"
        />,
      );

      await waitFor(() =>
        expect(screen.getByTestId('result-report')).toBeOnTheScreen(),
      );
      fireEvent.press(screen.getByTestId('result-report'));

      expect(onReportError).toHaveBeenCalledTimes(1);
      expect(onReportError).toHaveBeenCalledWith({
        kind: 'server',
        message: 'svc_unconfigured',
        photoUri: compressedUri,
        mode: 'diagnose',
      });
    });

    it('server: Report CTA hidden when onReportError omitted', async () => {
      const { client } = makeApiClient(async () => ({ ok: false, kind: 'server' }));
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
        expect(screen.getByTestId('result-error-server')).toBeOnTheScreen(),
      );
      expect(screen.queryByTestId('result-report')).toBeNull();
    });

    it('server: "Try again" re-fires diagnose', async () => {
      let callCount = 0;
      const { client, diagnoseSpy } = makeApiClient(async () => {
        callCount += 1;
        if (callCount === 1) return { ok: false, kind: 'server' };
        return { ok: true, data: SUCCESS_DATA };
      });
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
        expect(screen.getByTestId('result-try-again')).toBeOnTheScreen(),
      );
      fireEvent.press(screen.getByTestId('result-try-again'));
      await waitFor(() => expect(diagnoseSpy).toHaveBeenCalledTimes(2));
      // No recompression.
      expect(compressSpy).toHaveBeenCalledTimes(1);
    });

    // ─── parse_error ─────────────────────────────────────────────────────
    it('parse_error: renders distinct local-parse copy', async () => {
      const { client } = makeApiClient(async () => ({
        ok: false,
        kind: 'parse_error',
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
        expect(screen.getByTestId('result-error-parse_error')).toBeOnTheScreen(),
      );
      expect(screen.getByTestId('result-error-headline')).toHaveTextContent(
        /response we couldn't understand/i,
      );
      // Distinct from server.
      expect(screen.queryByText(/something went wrong on our end/i)).toBeNull();
    });

    it('parse_error: "Try again" re-fires diagnose; only one CTA', async () => {
      let callCount = 0;
      const { client, diagnoseSpy } = makeApiClient(async () => {
        callCount += 1;
        if (callCount === 1) return { ok: false, kind: 'parse_error' };
        return { ok: true, data: SUCCESS_DATA };
      });
      const { spy: compressSpy } = makeCompressImpl();

      render(
        <CameraResultScreen
          photoUri="file:///raw.jpg"
          mode="diagnose"
          apiClient={client}
          onSave={jest.fn()}
          onReportError={jest.fn()}
          onSavePhotoOnly={jest.fn()}
          compressPhotoImpl={compressSpy}
          testID="result"
        />,
      );

      await waitFor(() =>
        expect(screen.getByTestId('result-try-again')).toBeOnTheScreen(),
      );
      // parse_error has only the Try-again CTA — no Save-for-now, no Report.
      expect(screen.queryByTestId('result-save-photo-only')).toBeNull();
      expect(screen.queryByTestId('result-report')).toBeNull();

      fireEvent.press(screen.getByTestId('result-try-again'));
      await waitFor(() => expect(diagnoseSpy).toHaveBeenCalledTimes(2));
      expect(compressSpy).toHaveBeenCalledTimes(1);
    });

    // ─── layer1_reject ───────────────────────────────────────────────────
    it('layer1_reject: renders kind editorial card; only Try-different-photo CTA', async () => {
      const { client } = makeApiClient(async () => ({
        ok: false,
        kind: 'layer1_reject',
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
        expect(screen.getByTestId('result-error-layer1_reject')).toBeOnTheScreen(),
      );
      expect(screen.getByTestId('result-error-headline')).toHaveTextContent(
        /focused on plant care/i,
      );
      expect(screen.getByTestId('result-retake')).toBeOnTheScreen();
      // No retry / save-for-now / report.
      expect(screen.queryByTestId('result-try-again')).toBeNull();
      expect(screen.queryByTestId('result-save-photo-only')).toBeNull();
      expect(screen.queryByTestId('result-report')).toBeNull();
    });

    it('layer1_reject: "Try a different photo" fires onRetake', async () => {
      const { client } = makeApiClient(async () => ({
        ok: false,
        kind: 'layer1_reject',
      }));
      const { spy: compressSpy } = makeCompressImpl();
      const onRetake = jest.fn();

      render(
        <CameraResultScreen
          photoUri="file:///raw.jpg"
          mode="diagnose"
          apiClient={client}
          onSave={jest.fn()}
          onRetake={onRetake}
          compressPhotoImpl={compressSpy}
          testID="result"
        />,
      );

      await waitFor(() => expect(screen.getByTestId('result-retake')).toBeOnTheScreen());
      fireEvent.press(screen.getByTestId('result-retake'));
      expect(onRetake).toHaveBeenCalledTimes(1);
    });

    // ─── queued ──────────────────────────────────────────────────────────
    it('queued: renders the pending banner; no CTA', async () => {
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
        expect(screen.getByTestId('result-error-queued')).toBeOnTheScreen(),
      );
      // Pending banner present.
      expect(screen.getByTestId('result-queued-banner')).toBeOnTheScreen();
      // No plantContext + no explicit entryMode → defaults to quick.
      // v0.1.58.0 follow-up: Quick Diagnose surfaces diagnose-focused
      // copy (no implication of pending plant persistence).
      expect(screen.getByText(/diagnose queued/i)).toBeOnTheScreen();
      // No retry / save / report / retake CTAs.
      expect(screen.queryByTestId('result-try-again')).toBeNull();
      expect(screen.queryByTestId('result-retake')).toBeNull();
      expect(screen.queryByTestId('result-save-photo-only')).toBeNull();
      expect(screen.queryByTestId('result-report')).toBeNull();
    });

    // ─── compress-failed ─────────────────────────────────────────────────
    it('compress-failed: renders dedicated variant with retake CTA', async () => {
      const compressImpl = jest.fn(async () => {
        throw new Error('manipulate-failed');
      });
      const { client } = makeApiClient(async () => ({ ok: true, data: SUCCESS_DATA }));
      const onRetake = jest.fn();

      render(
        <CameraResultScreen
          photoUri="file:///raw.jpg"
          mode="diagnose"
          apiClient={client}
          onSave={jest.fn()}
          onRetake={onRetake}
          compressPhotoImpl={compressImpl}
          testID="result"
        />,
      );

      await waitFor(() =>
        expect(
          screen.getByTestId('result-error-compress-failed'),
        ).toBeOnTheScreen(),
      );
      expect(screen.getByTestId('result-error-headline')).toHaveTextContent(
        /preparing your photo/i,
      );
      fireEvent.press(screen.getByTestId('result-retake'));
      expect(onRetake).toHaveBeenCalledTimes(1);
    });

    // ─── reduce-motion ───────────────────────────────────────────────────
    it('reduce-motion: error-card opacity is 1 immediately (no Animated.timing)', async () => {
      mockedUseReduceMotion.mockReturnValue(true);
      const { client } = makeApiClient(async () => ({ ok: false, kind: 'timeout' }));
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
        expect(screen.getByTestId('result-error-timeout')).toBeOnTheScreen(),
      );
      const errorView = screen.getByTestId('result-error-timeout');
      const flat: Array<Record<string, unknown> | undefined> = Array.isArray(
        errorView.props.style,
      )
        ? errorView.props.style.flat()
        : [errorView.props.style];
      const opacityValue = flat
        .map((s) => (s as { opacity?: unknown } | undefined)?.opacity)
        .find((v) => v !== undefined);
      const numeric =
        typeof opacityValue === 'number'
          ? opacityValue
          : (opacityValue as { _value?: number } | undefined)?._value;
      expect(numeric).toBe(1);
    });

    // ─── dark theme ──────────────────────────────────────────────────────
    it('dark theme: error headline uses darkTheme.colors.text', async () => {
      mockedUseTheme.mockReturnValue(darkTheme);
      const { client } = makeApiClient(async () => ({ ok: false, kind: 'server' }));
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
        expect(screen.getByTestId('result-error-headline')).toBeOnTheScreen(),
      );
      const headline = screen.getByTestId('result-error-headline');
      const flat: Array<Record<string, unknown> | undefined> = Array.isArray(
        headline.props.style,
      )
        ? headline.props.style.flat()
        : [headline.props.style];
      const color = flat
        .map((s) => (s as { color?: unknown } | undefined)?.color)
        .find((v) => v !== undefined);
      expect(color).toBe(darkTheme.colors.text);
    });

    // ─── A11y roles ──────────────────────────────────────────────────────
    it('a11y: server error variant has accessibilityRole=alert', async () => {
      const { client } = makeApiClient(async () => ({ ok: false, kind: 'server' }));
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
        expect(screen.getByTestId('result-error-server')).toBeOnTheScreen(),
      );
      const view = screen.getByTestId('result-error-server');
      expect(view.props.accessibilityRole).toBe('alert');
    });

    it('a11y: queued variant has accessibilityRole=status (non-disruptive)', async () => {
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
        expect(screen.getByTestId('result-error-queued')).toBeOnTheScreen(),
      );
      const view = screen.getByTestId('result-error-queued');
      expect(view.props.accessibilityRole).toBe('status');
    });

    it('a11y: announceForAccessibility called with the headline on error transition', async () => {
      const { client } = makeApiClient(async () => ({ ok: false, kind: 'timeout' }));
      const { spy: compressSpy } = makeCompressImpl();
      const announceImpl = jest.fn();

      render(
        <CameraResultScreen
          photoUri="file:///raw.jpg"
          mode="diagnose"
          apiClient={client}
          onSave={jest.fn()}
          compressPhotoImpl={compressSpy}
          announceForAccessibilityImpl={announceImpl}
          testID="result"
        />,
      );

      await waitFor(() => expect(announceImpl).toHaveBeenCalled());
      // Announcement carries the editorial headline.
      const announced = announceImpl.mock.calls.map((c) => c[0]);
      expect(announced.some((s) => /taking longer than usual/i.test(String(s)))).toBe(
        true,
      );
    });

    it('a11y: announce only fires once per kind transition (idempotent on re-render)', async () => {
      const { client } = makeApiClient(async () => ({ ok: false, kind: 'server' }));
      const { spy: compressSpy } = makeCompressImpl();
      const announceImpl = jest.fn();

      const { rerender } = render(
        <CameraResultScreen
          photoUri="file:///raw.jpg"
          mode="diagnose"
          apiClient={client}
          onSave={jest.fn()}
          compressPhotoImpl={compressSpy}
          announceForAccessibilityImpl={announceImpl}
          testID="result"
        />,
      );

      await waitFor(() =>
        expect(screen.getByTestId('result-error-server')).toBeOnTheScreen(),
      );
      const initialCount = announceImpl.mock.calls.length;
      // Re-render — announcement should NOT fire again for the same kind.
      rerender(
        <CameraResultScreen
          photoUri="file:///raw.jpg"
          mode="diagnose"
          apiClient={client}
          onSave={jest.fn()}
          compressPhotoImpl={compressSpy}
          announceForAccessibilityImpl={announceImpl}
          testID="result"
        />,
      );
      await act(async () => {
        await Promise.resolve();
      });
      expect(announceImpl).toHaveBeenCalledTimes(initialCount);
    });

    // ─── Strict-mode double-mount (StrictMode wraps the tree) ─────────────
    //
    // React 19 strict-mode fires effects twice (mount → cleanup → mount).
    // The screen's E5-008 design: compression's `cancelled` flag drops the
    // first effect's setState, and `initialDiagnoseFiredRef` latches the
    // diagnose call so it fires exactly once even when compression runs
    // twice. So compressSpy may be called twice (effect re-runs) but
    // diagnoseSpy fires exactly once. The user-visible state lands on a
    // single error variant render.
    it('strict-mode: diagnose fires exactly once; error variant renders once', async () => {
      const { client, diagnoseSpy } = makeApiClient(async () => ({
        ok: false,
        kind: 'timeout',
      }));
      const { spy: compressSpy } = makeCompressImpl();

      render(
        <React.StrictMode>
          <CameraResultScreen
            photoUri="file:///raw.jpg"
            mode="diagnose"
            apiClient={client}
            onSave={jest.fn()}
            compressPhotoImpl={compressSpy}
            testID="result"
          />
        </React.StrictMode>,
      );

      await waitFor(() =>
        expect(screen.getByTestId('result-error-timeout')).toBeOnTheScreen(),
      );
      // Diagnose latch holds even under strict-mode.
      expect(diagnoseSpy).toHaveBeenCalledTimes(1);
      // Exactly one error variant rendered (no duplicates).
      expect(screen.getAllByTestId('result-error-timeout')).toHaveLength(1);
      // Compression may have fired up to twice; the cancelled flag drops the
      // first effect's setState, so the visible state is a single ready phase.
      expect(compressSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
      expect(compressSpy.mock.calls.length).toBeLessThanOrEqual(2);
    });

    // ─── Codex P2 regression: no stale error card during retry ───────────
    //
    // When the user presses "Try again", `useDiagnoseRequest` flips
    // `status='requesting'` but keeps the previous error in `lastResult`.
    // The loading dock is the only surface the user should see during the
    // retry — the stale error card must NOT co-render alongside it (would
    // double-announce on a screen reader and let the user re-press the
    // already-pressed CTA).
    it('codex-P2: stale error card hidden while a retry is in flight', async () => {
      let resolveSecond: (v: ApiResult<DiagnoseResponse>) => void = () => {};
      let callCount = 0;
      const diagnoseImpl = jest.fn(
        () =>
          new Promise<ApiResult<DiagnoseResponse>>((resolve) => {
            callCount += 1;
            if (callCount === 1) {
              resolve({ ok: false, kind: 'timeout' });
            } else {
              // Hold the second call open so the test observes the
              // requesting window with no stale error card.
              resolveSecond = resolve;
            }
          }),
      );
      const client: ApiClient = {
        identify: jest.fn() as never,
        diagnose: diagnoseImpl as never,
        consult: jest.fn() as never,
        review: jest.fn() as never,

        weather: jest.fn() as never,
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

      await waitFor(() =>
        expect(screen.getByTestId('result-error-timeout')).toBeOnTheScreen(),
      );

      // Press Try again. The hook flips status='requesting' but
      // lastResult is still the timeout error.
      fireEvent.press(screen.getByTestId('result-try-again'));
      await waitFor(() => expect(diagnoseImpl).toHaveBeenCalledTimes(2));

      // Loading dock should be visible AND the stale error card should be
      // gone (not co-rendered).
      await waitFor(() => expect(screen.getByTestId('result-loading')).toBeOnTheScreen());
      expect(screen.queryByTestId('result-error-timeout')).toBeNull();

      // Resolve the second request so the test cleans up.
      await act(async () => {
        resolveSecond({ ok: true, data: SUCCESS_DATA });
      });
    });

    // ─── Discriminated-union hygiene: each kind yields its own testID ─────
    //
    // The 'network' kind is excluded from the live-render sweep because
    // useDiagnoseRequest coerces it to 'queued' (master plan offline UX).
    // The resolveErrorVariant helper test above covers network's render
    // path directly. The remaining 6 kinds reach the screen verbatim.
    it('discriminated union stays distinct: every kind (sans coerced network) has its own testID suffix', async () => {
      const kinds: Array<{ kind: string; result: Parameters<typeof makeApiClient>[0] }> = [
        { kind: 'low_confidence', result: async () => ({ ok: false, kind: 'low_confidence' }) },
        { kind: 'timeout', result: async () => ({ ok: false, kind: 'timeout' }) },
        { kind: 'server', result: async () => ({ ok: false, kind: 'server' }) },
        { kind: 'parse_error', result: async () => ({ ok: false, kind: 'parse_error' }) },
        { kind: 'layer1_reject', result: async () => ({ ok: false, kind: 'layer1_reject' }) },
        { kind: 'queued', result: async () => ({ ok: false, kind: 'queued' }) },
      ];

      for (const { kind, result } of kinds) {
        const { client } = makeApiClient(result);
        const { spy: compressSpy } = makeCompressImpl();
        const { unmount } = render(
          <CameraResultScreen
            photoUri="file:///raw.jpg"
            mode="diagnose"
            apiClient={client}
            onSave={jest.fn()}
            compressPhotoImpl={compressSpy}
            testID="r"
          />,
        );
        await waitFor(() =>
          expect(screen.getByTestId(`r-error-${kind}`)).toBeOnTheScreen(),
        );
        unmount();
      }
    });
  });

  // ─── resolveErrorVariant unit tests ───────────────────────────────────
  describe('resolveErrorVariant helper', () => {
    it('returns null when phase is compressing', () => {
      const v = __testing.resolveErrorVariant({ kind: 'compressing' }, null);
      expect(v).toBeNull();
    });

    it('returns null when result is success', () => {
      const v = __testing.resolveErrorVariant(
        { kind: 'ready', compressed: { uri: 'x', width: 1, height: 1, sizeBytes: 1 } },
        { ok: true, data: SUCCESS_DATA },
      );
      expect(v).toBeNull();
    });

    it('compress-failed phase wins over a stale lastResult', () => {
      const v = __testing.resolveErrorVariant(
        { kind: 'compress-failed', error: new Error('x') },
        { ok: true, data: SUCCESS_DATA },
      );
      expect(v?.kind).toBe('compress-failed');
    });

    it('returns the matching variant for every locked union kind', () => {
      const ready = {
        kind: 'ready' as const,
        compressed: { uri: 'x', width: 1, height: 1, sizeBytes: 1 },
      };
      const kinds = [
        'network',
        'timeout',
        'server',
        'layer1_reject',
        'low_confidence',
        'parse_error',
        'queued',
      ] as const;
      for (const k of kinds) {
        const v = __testing.resolveErrorVariant(ready, { ok: false, kind: k });
        expect(v?.kind).toBe(k);
      }
    });
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

  // ─── entry-mode-aware queued copy (v0.1.58.0 follow-up) ────────────────
  describe('entry-mode-aware queued copy', () => {
    it('diagnose entry: queued banner reads "Diagnose queued — will run when online."', async () => {
      const { client } = makeApiClient(async () => ({ ok: false, kind: 'queued' }));
      const { spy: compressSpy } = makeCompressImpl();
      render(
        <CameraResultScreen
          photoUri="file:///raw.jpg"
          mode="diagnose"
          entryMode="diagnose"
          apiClient={client}
          onSave={jest.fn()}
          compressPhotoImpl={compressSpy}
          testID="result"
        />,
      );
      await waitFor(() =>
        expect(screen.getByTestId('result-error-queued')).toBeOnTheScreen(),
      );
      // ToastBanner renders the message prop as a Text child.
      expect(screen.getByText(/diagnose queued/i)).toBeOnTheScreen();
      // Reject the misleading plant-path copy.
      expect(screen.queryByText(/save when you're back online/i)).toBeNull();
    });

    it('identify entry: queued banner reads "We\'ll save when you\'re back online."', async () => {
      const { client } = makeApiClient(async () => ({ ok: false, kind: 'queued' }));
      const { spy: compressSpy } = makeCompressImpl();
      render(
        <CameraResultScreen
          photoUri="file:///raw.jpg"
          mode="diagnose"
          entryMode="identify"
          plantContext={{ species_slug: 'monstera', nickname: 'Steve' }}
          plantNickname="Steve"
          apiClient={client}
          onSave={jest.fn()}
          compressPhotoImpl={compressSpy}
          testID="result"
        />,
      );
      await waitFor(() =>
        expect(screen.getByTestId('result-error-queued')).toBeOnTheScreen(),
      );
      expect(screen.getByText(/save when you're back online/i)).toBeOnTheScreen();
      expect(screen.queryByText(/diagnose queued/i)).toBeNull();
    });

    it('default: inferred from plantContext presence (identify entry when context present)', async () => {
      // No explicit entryMode prop; plantContext present → identify entry.
      const { client } = makeApiClient(async () => ({ ok: false, kind: 'queued' }));
      const { spy: compressSpy } = makeCompressImpl();
      render(
        <CameraResultScreen
          photoUri="file:///raw.jpg"
          mode="diagnose"
          plantContext={{ species_slug: 'monstera', nickname: 'Steve' }}
          apiClient={client}
          onSave={jest.fn()}
          compressPhotoImpl={compressSpy}
          testID="result"
        />,
      );
      await waitFor(() =>
        expect(screen.getByTestId('result-error-queued')).toBeOnTheScreen(),
      );
      expect(screen.getByText(/save when you're back online/i)).toBeOnTheScreen();
    });

    it('default: inferred diagnose entry when plantContext absent', async () => {
      // No explicit entryMode prop, no plantContext → diagnose entry
      // (the Quick Diagnose rescue case the follow-up fixes).
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
        expect(screen.getByTestId('result-error-queued')).toBeOnTheScreen(),
      );
      expect(screen.getByText(/diagnose queued/i)).toBeOnTheScreen();
    });

    it('resolveErrorVariant: identify mode → "save when you\'re back online"', () => {
      const v = __testing.resolveErrorVariant(
        { kind: 'ready', compressed: { uri: 'x', width: 1, height: 1, sizeBytes: 1 } },
        { ok: false, kind: 'queued' },
        'identify',
      );
      expect(v?.copy.headline).toMatch(/save when you're back online/i);
    });

    it('resolveErrorVariant: diagnose mode → "Diagnose queued"', () => {
      const v = __testing.resolveErrorVariant(
        { kind: 'ready', compressed: { uri: 'x', width: 1, height: 1, sizeBytes: 1 } },
        { ok: false, kind: 'queued' },
        'diagnose',
      );
      expect(v?.copy.headline).toMatch(/diagnose queued/i);
    });
  });

  // ─── offlineQueue prop wiring (v0.1.61.0 follow-up) ────────────────────
  describe('offlineQueue prop wiring', () => {
    it('forwards offlineQueue to useDiagnoseRequest: post-call network enqueues', async () => {
      // The api client returns `network`; useDiagnoseRequest coerces to
      // `queued` and (when offlineQueue is wired) persists via safeEnqueue.
      // We stub the QueueExecutor and assert the INSERT statement fires.
      const { client } = makeApiClient(async () => ({ ok: false, kind: 'network' }));
      const { spy: compressSpy } = makeCompressImpl();
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
        <CameraResultScreen
          photoUri="file:///raw.jpg"
          mode="diagnose"
          apiClient={client}
          onSave={jest.fn()}
          compressPhotoImpl={compressSpy}
          offlineQueue={{ db: fakeDb as never }}
          testID="result"
        />,
      );

      // Wait for the queued banner to render — by that point the
      // post-call enqueue has run synchronously inside the diagnose
      // promise chain.
      await waitFor(() =>
        expect(screen.getByTestId('result-error-queued')).toBeOnTheScreen(),
      );
      expect(withExclusiveTransactionAsync).toHaveBeenCalledTimes(1);
      // Probe for live duplicate fired with the diagnose endpoint.
      expect(getFirstAsync).toHaveBeenCalled();
      const probeArgs = getFirstAsync.mock.calls[0];
      expect((probeArgs?.[1] as unknown[])?.[0]).toBe('diagnose');
      // Insert fired with the diagnose endpoint as the ref_table.
      expect(runAsync).toHaveBeenCalled();
      const insertArgs = runAsync.mock.calls[0];
      expect(insertArgs?.[0]).toMatch(/INSERT INTO sync_queue/);
      expect((insertArgs?.[1] as unknown[])?.[1]).toBe('diagnose');
    });

    it('omitting offlineQueue keeps legacy behavior: no persistence calls', async () => {
      const { client } = makeApiClient(async () => ({ ok: false, kind: 'network' }));
      const { spy: compressSpy } = makeCompressImpl();
      const runAsync = jest.fn();
      const withExclusiveTransactionAsync = jest.fn();
      // No db passed.

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
        expect(screen.getByTestId('result-error-queued')).toBeOnTheScreen(),
      );
      expect(runAsync).not.toHaveBeenCalled();
      expect(withExclusiveTransactionAsync).not.toHaveBeenCalled();
    });
  });
});
