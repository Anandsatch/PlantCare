import { describe, expect, it } from 'vitest';
import { reviewRouter } from '../src/llm/router';
import { reviewFixtures } from './fixtures/review';
import {
  assertConfidenceBand,
  expectCallArgs,
  mockCalls,
  REAL_API,
} from './eval-runner';

const REVIEW_PROMPT_FRAGMENT = 'weekly garden letter';
const apiKey = 'test-key';

describe('/api/review eval (mock mode)', () => {
  for (const fx of reviewFixtures) {
    it(`[${fx.name}] shape + per_plant alignment`, async () => {
      const callFree = mockCalls({ kind: 'ok', content: fx.mock_response });
      const callPaid = mockCalls({ kind: 'error', reason: 'http_error' });

      // We feed the router the canned mock response directly — composing
      // the full LLM userMessage from the request body is the route
      // handler's job (tested in test/review.test.ts). Evals exercise
      // parser → router → output shape, not the prompt assembly.
      const input = { kind: 'text' as const, userMessage: 'eval-only-placeholder' };
      const result = await reviewRouter(input, { apiKey, callFree, callPaid });

      expectCallArgs(callFree, 0, {
        kind: 'text',
        systemPromptIncludes: REVIEW_PROMPT_FRAGMENT,
      });

      expect(result.source).toBe('free');
      assertConfidenceBand(fx.name, result.confidence, fx.expected.confidence_baseline);

      // Headline + narrative length contracts.
      expect(result.headline.length).toBeGreaterThan(0);
      expect(result.headline.length).toBeLessThanOrEqual(fx.expected.headline_max);
      expect(result.narrative.length).toBeGreaterThanOrEqual(fx.expected.narrative_min);
      expect(result.narrative.length).toBeLessThanOrEqual(fx.expected.narrative_max);

      // The catch from E1-004 adversarial review: per_plant must echo one
      // observation per request plant, in the same order. The parser
      // doesn't enforce this — only the eval does.
      expect(result.per_plant).toHaveLength(fx.request.plants.length);
      result.per_plant.forEach((obs, i) => {
        expect(obs.species_slug).toBe(fx.request.plants[i].species_slug);
        expect(obs.observation.length).toBeGreaterThan(0);
        expect(obs.observation.length).toBeLessThanOrEqual(200);
      });

      expect(callFree).toHaveBeenCalledOnce();
      expect(callPaid).not.toHaveBeenCalled();
    });
  }

  it('parsed shape snapshot across all fixtures', async () => {
    const parsed = [];
    for (const fx of reviewFixtures) {
      const callFree = mockCalls({ kind: 'ok', content: fx.mock_response });
      const callPaid = mockCalls({ kind: 'error', reason: 'http_error' });
      const input = { kind: 'text' as const, userMessage: 'eval-only-placeholder' };
      const r = await reviewRouter(input, { apiKey, callFree, callPaid });
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { latency_ms: _l, ...rest } = r;
      parsed.push({ name: fx.name, ...rest });
    }
    expect(parsed).toMatchSnapshot();
  });
});

describe.skipIf(!REAL_API)('/api/review eval (real API)', () => {
  it.todo('hits live OpenRouter with the mixed-week fixture and asserts ±10 confidence band');
});
