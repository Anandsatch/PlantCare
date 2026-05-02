import { describe, expect, it, vi } from 'vitest';
import { callFree } from '../src/llm/openrouter';

describe('openrouter wrapper — abort handling', () => {
  it('short-circuits when caller signal is already aborted (does not open socket)', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('fetch should not have been called');
    });
    const controller = new AbortController();
    controller.abort();

    const res = await callFree({
      apiKey: 'k',
      systemPrompt: 'p',
      imageDataUrl: 'data:image/png;base64,xxxx',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      signal: controller.signal,
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe('aborted');
      expect(res.latency_ms).toBe(0);
    }
  });

  it('reports aborted (not timeout) when caller aborts mid-flight', async () => {
    const controller = new AbortController();
    // fetchImpl that respects the propagated signal
    const fetchImpl = vi.fn(async (_url: unknown, init: { signal?: AbortSignal } = {}) => {
      // Schedule abort right after we hand off; the wrapper's controller
      // listens on the caller signal, so its own controller fires AbortError.
      queueMicrotask(() => controller.abort());
      return await new Promise<Response>((_, reject) => {
        init.signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    });

    const res = await callFree({
      apiKey: 'k',
      systemPrompt: 'p',
      imageDataUrl: 'data:image/png;base64,xxxx',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      signal: controller.signal,
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe('aborted');
    }
  });
});
