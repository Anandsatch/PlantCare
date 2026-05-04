// Shared eval helpers. Two modes:
//
//   Mock mode (default): each fixture provides a `mock_response` string —
//   the canonical LLM JSON we'd expect the system prompt to elicit. The
//   harness mocks `callFree`/`callPaid`, runs the real router, and asserts
//   that the parser accepted it, the source/kind matches, and confidence
//   sits within ±10 of the baseline.
//
//   Real-API mode (EVAL_REAL_API=1): the same fixtures are sent to live
//   OpenRouter. Confidence will drift call-to-call; the ±10 band is the
//   regression guard. Real-API mode is OPT-IN — disabled by default so CI
//   doesn't burn quota on every push.
//
// The point of fixturing the LLM response in mock mode is NOT to verify
// that real models behave (real-API mode does that). It's to exercise the
// parser + router state machine against the *exact wire shapes* we expect
// real models to produce, so a contract change in either side surfaces
// immediately and deterministically.

import { vi } from 'vitest';
import type {
  callFree as callFreeFn,
  CallResult,
} from '../src/llm/openrouter';

export const CONFIDENCE_BAND = 10;

export const REAL_API = process.env.EVAL_REAL_API === '1';

// Tag for `it.skipIf(!REAL_API)` blocks. Mock-only tests use plain `it`.
export const skipUnlessRealApi = !REAL_API;

export type MockOutcome =
  | { kind: 'ok'; content: string }
  | { kind: 'error'; reason: 'timeout' | 'http_error' | 'empty' | 'aborted' };

// Build a mock callFree/callPaid that returns the supplied outcomes in
// order. Each .mock.calls[i] is the ith invocation. Useful for asserting
// "free was called once, paid never was" via the returned spies.
export function mockCalls(...outcomes: MockOutcome[]): ReturnType<
  typeof vi.fn<typeof callFreeFn>
> {
  let i = 0;
  return vi.fn<typeof callFreeFn>(async () => {
    const o = outcomes[i++] ?? outcomes[outcomes.length - 1];
    if (!o) {
      // No outcomes registered: surface as http_error so the router treats
      // it as a transport failure rather than silently looping.
      return { ok: false, reason: 'http_error', latency_ms: 0 };
    }
    return toCallResult(o);
  });
}

function toCallResult(o: MockOutcome): CallResult {
  if (o.kind === 'ok') return { ok: true, content: o.content, latency_ms: 50 };
  return { ok: false, reason: o.reason, latency_ms: 10 };
}

// Assert |actual - baseline| <= CONFIDENCE_BAND, with a clear failure
// message that names the fixture so a CI log diff is actionable.
export function assertConfidenceBand(
  fixtureName: string,
  actual: number,
  baseline: number,
): void {
  const drift = Math.abs(actual - baseline);
  if (drift > CONFIDENCE_BAND) {
    throw new Error(
      `[${fixtureName}] confidence ${actual} drifted ${drift} from baseline ${baseline} (band ±${CONFIDENCE_BAND})`,
    );
  }
}
