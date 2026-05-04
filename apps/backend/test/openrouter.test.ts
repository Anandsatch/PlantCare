import { describe, expect, it, vi } from 'vitest';
import { callFree, callPaid } from '../src/llm/openrouter';

describe('openrouter wrapper — abort handling', () => {
  it('short-circuits when caller signal is already aborted (does not open socket)', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('fetch should not have been called');
    });
    const controller = new AbortController();
    controller.abort();

    const res = await callFree({
      kind: 'vision',
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
      kind: 'vision',
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

// E1-003 added a discriminated CallArgs (vision vs text). These regressions
// guard the wire shape the model receives — vision sends an array with an
// image_url part; text sends a plain string. Free-tier models throw on
// unexpected shape, so a regression here breaks every endpoint at once.
describe('openrouter wrapper — vision vs text wire shape', () => {
  function captureBody() {
    const captured: { body?: string } = {};
    const fetchImpl = vi.fn(async (_url: unknown, init: { body?: string } = {}) => {
      captured.body = init.body;
      return new Response(
        JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    return { captured, fetchImpl };
  }

  it('vision arm sends content as an array with image_url', async () => {
    const { captured, fetchImpl } = captureBody();
    await callFree({
      kind: 'vision',
      apiKey: 'k',
      systemPrompt: 'sys',
      imageDataUrl: 'data:image/jpeg;base64,abcd',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const parsed = JSON.parse(captured.body!) as {
      messages: { role: string; content: unknown }[];
    };
    expect(parsed.messages).toHaveLength(2);
    expect(parsed.messages[0]).toEqual({ role: 'system', content: 'sys' });
    expect(parsed.messages[1].role).toBe('user');
    expect(parsed.messages[1].content).toEqual([
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,abcd' } },
    ]);
  });

  it('text arm sends content as a plain string (no image_url part)', async () => {
    const { captured, fetchImpl } = captureBody();
    await callFree({
      kind: 'text',
      apiKey: 'k',
      systemPrompt: 'sys',
      userMessage: 'My monstera leaves are drooping.',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const parsed = JSON.parse(captured.body!) as {
      messages: { role: string; content: unknown }[];
    };
    expect(parsed.messages[1].content).toBe('My monstera leaves are drooping.');
    // Regression guard: no image_url, no array. A model receiving an array
    // when it expects a string will reject with a 400.
    expect(Array.isArray(parsed.messages[1].content)).toBe(false);
    const bodyStr = captured.body!;
    expect(bodyStr).not.toContain('image_url');
  });

  it('callPaid uses the same vision/text dispatch (regression: paid arm not forgotten)', async () => {
    const { captured, fetchImpl } = captureBody();
    await callPaid({
      kind: 'text',
      apiKey: 'k',
      systemPrompt: 'sys',
      userMessage: 'Hi',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const parsed = JSON.parse(captured.body!) as {
      model: string;
      messages: { role: string; content: unknown }[];
    };
    expect(parsed.model).toMatch(/claude/);
    expect(parsed.messages[1].content).toBe('Hi');
  });
});
