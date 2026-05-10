/**
 * llmBudget pure-helper tests — E11-006.
 *
 * Locks the post-codex-P1 policy: shouldRecordLlmCallResult returns
 * true ONLY for terminal-success (`ok: true`). Every non-success kind —
 * including the WIP's old broader "consumed quota" set (parse_error,
 * server, layer1_reject, low_confidence) — must return false.
 *
 * This pins the contract so a future regression that quietly re-broadens
 * the policy trips the test suite, not a downstream user-facing
 * over-count.
 */
import {
  isLlmCallEndpoint,
  recordLlmCall,
  shouldRecordLlmCallResult,
  type LlmCallEndpoint,
  type LlmCallWriter,
} from '../llmBudget';

describe('shouldRecordLlmCallResult — terminal-success only (codex E11-006 P1)', () => {
  it('returns true for ok=true', () => {
    expect(shouldRecordLlmCallResult({ ok: true })).toBe(true);
  });

  it.each([
    'queued',
    'network',
    'timeout',
    'server',
    'parse_error',
    'layer1_reject',
    'low_confidence',
  ] as const)('returns false for ok=false kind=%s', (kind) => {
    expect(shouldRecordLlmCallResult({ ok: false, kind })).toBe(false);
  });

  it('returns false for an unknown future kind (conservative default)', () => {
    expect(shouldRecordLlmCallResult({ ok: false, kind: 'future_kind' })).toBe(
      false,
    );
  });

  it('returns false for ok=false with no kind', () => {
    expect(shouldRecordLlmCallResult({ ok: false })).toBe(false);
  });
});

describe('isLlmCallEndpoint', () => {
  it.each(['identify', 'diagnose', 'consult', 'review'] as const)(
    'recognizes %s',
    (endpoint) => {
      expect(isLlmCallEndpoint(endpoint)).toBe(true);
    },
  );

  it('rejects unknown endpoints', () => {
    expect(isLlmCallEndpoint('predict')).toBe(false);
    expect(isLlmCallEndpoint('')).toBe(false);
    expect(isLlmCallEndpoint('IDENTIFY')).toBe(false);
  });
});

describe('recordLlmCall — best-effort insertion', () => {
  function makeWriter(): {
    writer: LlmCallWriter;
    runAsync: jest.Mock<Promise<unknown>, [string, ReadonlyArray<string | number>]>;
  } {
    const runAsync = jest.fn<
      Promise<unknown>,
      [string, ReadonlyArray<string | number>]
    >().mockResolvedValue(undefined);
    return { writer: { runAsync }, runAsync };
  }

  it('inserts into llm_calls with the endpoint + nowMs', async () => {
    const { writer, runAsync } = makeWriter();
    const result = await recordLlmCall(writer, 'consult', { nowMs: 1234 });
    expect(result).toBe(true);
    expect(runAsync).toHaveBeenCalledTimes(1);
    expect(runAsync.mock.calls[0]?.[0]).toContain('INSERT INTO llm_calls');
    expect(runAsync.mock.calls[0]?.[1]).toEqual(['consult', 1234]);
  });

  it('uses Date.now when nowMs is omitted', async () => {
    const { writer, runAsync } = makeWriter();
    const before = Date.now();
    await recordLlmCall(writer, 'identify');
    const after = Date.now();
    const calledAt = (runAsync.mock.calls[0]?.[1] as number[])[1];
    expect(calledAt).toBeGreaterThanOrEqual(before);
    expect(calledAt).toBeLessThanOrEqual(after);
  });

  it('refuses to insert an unknown endpoint and reports via onError', async () => {
    const { writer, runAsync } = makeWriter();
    const onError = jest.fn();
    const result = await recordLlmCall(
      writer,
      'predict' as unknown as LlmCallEndpoint,
      { onError },
    );
    expect(result).toBe(false);
    expect(runAsync).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('swallows DB errors via onError and returns false (NEVER throws)', async () => {
    const runAsync = jest
      .fn<Promise<unknown>, [string, ReadonlyArray<string | number>]>()
      .mockRejectedValue(new Error('disk full'));
    const writer: LlmCallWriter = { runAsync };
    const onError = jest.fn();
    // The contract is: never throws into the caller. Wrapping in
    // expect().resolves locks that contract — a regression that
    // re-throws would surface here, not in the LLM-call promise chain.
    await expect(
      recordLlmCall(writer, 'diagnose', { onError, nowMs: 1 }),
    ).resolves.toBe(false);
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
