import { describe, expect, it } from 'vitest';
import { consultRouter } from '../src/llm/router';
import { consultFixtures } from './fixtures/consult';
import {
  assertConfidenceBand,
  expectCallArgs,
  mockCalls,
  REAL_API,
} from './eval-runner';

const CONSULT_PROMPT_FRAGMENT = 'plant care advisor';
const apiKey = 'test-key';

describe('/api/consult eval (mock mode)', () => {
  for (const fx of consultFixtures) {
    it(`[${fx.category}] ${fx.name}`, async () => {
      const callFree = mockCalls({ kind: 'ok', content: fx.mock_response });
      const callPaid = mockCalls({ kind: 'error', reason: 'http_error' });

      const input = { kind: 'text' as const, userMessage: fx.user_note };
      const result = await consultRouter(input, { apiKey, callFree, callPaid });

      expectCallArgs(callFree, 0, {
        kind: 'text',
        systemPromptIncludes: CONSULT_PROMPT_FRAGMENT,
        userMessageIncludes: fx.user_note.slice(0, 20),
      });

      if (fx.expected.kind === 'rejected_off_topic') {
        // Rejection rides the parser's `final` arm — router returns
        // immediately, NEVER escalates.
        expect(result.kind).toBe('rejected_off_topic');
        expect(result.source).toBe('free');
        if (result.kind === 'rejected_off_topic') {
          expect(result.reason).toContain(fx.expected.reason_includes);
        }
        expect(callFree).toHaveBeenCalledOnce();
        expect(callPaid).not.toHaveBeenCalled();
        return;
      }

      expect(result.kind).toBe('recommendation');
      expect(result.source).toBe('free');
      if (result.kind === 'recommendation') {
        expect(result.revised_interval_days).toBe(fx.expected.revised_interval_days);
        assertConfidenceBand(fx.name, result.confidence, fx.expected.confidence_baseline);
      }
      expect(callFree).toHaveBeenCalledOnce();
      expect(callPaid).not.toHaveBeenCalled();
    });
  }

  it('parsed shape snapshot across all fixtures', async () => {
    const parsed = [];
    for (const fx of consultFixtures) {
      const callFree = mockCalls({ kind: 'ok', content: fx.mock_response });
      const callPaid = mockCalls({ kind: 'error', reason: 'http_error' });
      const input = { kind: 'text' as const, userMessage: fx.user_note };
      const r = await consultRouter(input, { apiKey, callFree, callPaid });
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { latency_ms: _l, ...rest } = r;
      parsed.push({ name: fx.name, ...rest });
    }
    expect(parsed).toMatchSnapshot();
  });
});

describe.skipIf(!REAL_API)('/api/consult eval (real API)', () => {
  it.todo('hits live OpenRouter with text fixtures and asserts ±10 confidence band');
});
