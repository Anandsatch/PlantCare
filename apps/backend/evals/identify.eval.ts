import { describe, expect, it } from 'vitest';
import { identifyRouter } from '../src/llm/router';
import { identifyFixtures } from './fixtures/identify';
import { assertConfidenceBand, mockCalls, REAL_API } from './eval-runner';

const baseInput = { kind: 'vision' as const, imageDataUrl: 'data:image/png;base64,deadbeef' };
const apiKey = 'test-key';

describe('/api/identify eval (mock mode)', () => {
  for (const fx of identifyFixtures) {
    it(`[${fx.category}] ${fx.name}`, async () => {
      const callFree = mockCalls({ kind: 'ok', content: fx.mock_response });
      const callPaid = mockCalls({ kind: 'error', reason: 'http_error' });

      const result = await identifyRouter(baseInput, { apiKey, callFree, callPaid });

      // Reject fixtures: confidence is intentionally low (< 30) so the
      // router escalates. With paid mocked to fail, the router falls back
      // to the low-conf free parse — source='free', species_slug='unknown'.
      // Real-API mode (post-V1) will instead assert the live free model
      // returned 'unknown' on the cat image without escalating to paid.
      if (fx.expected.is_reject) {
        expect(result.species_slug).toBe('unknown');
        expect(result.confidence).toBeLessThan(30);
        expect(callFree).toHaveBeenCalledOnce();
        expect(callPaid).toHaveBeenCalledOnce(); // escalation attempted
        return;
      }

      // Healthy / partial / low-light: confidence MUST be ≥ 70 in the
      // mock_response (otherwise the prompt + free model isn't doing its
      // job). Router takes the free path without escalating.
      expect(result.source).toBe('free');
      expect(result.species_slug).toBe(fx.expected.species_slug);
      assertConfidenceBand(fx.name, result.confidence, fx.expected.confidence_baseline);
      expect(callFree).toHaveBeenCalledOnce();
      expect(callPaid).not.toHaveBeenCalled();
    });
  }

  // Aggregate snapshot — surfaces parser drift across the whole fixture
  // set in a single visible diff. Vitest writes the snapshot the first
  // time and compares on subsequent runs.
  it('parsed shape snapshot across all fixtures', async () => {
    const parsed = [];
    for (const fx of identifyFixtures) {
      const callFree = mockCalls({ kind: 'ok', content: fx.mock_response });
      // Provide a paid mock so the reject fixture's escalation arm doesn't
      // crash on missing interceptor — outcome is still treated as failed.
      const callPaid = mockCalls({ kind: 'error', reason: 'http_error' });
      const r = await identifyRouter(baseInput, { apiKey, callFree, callPaid });
      // Strip latency_ms — it's nondeterministic timing data, not a contract.
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { latency_ms: _l, ...rest } = r;
      parsed.push({ name: fx.name, ...rest });
    }
    expect(parsed).toMatchSnapshot();
  });
});

// Real-API mode placeholder. Skipped unless EVAL_REAL_API=1 — V1 does not
// ship live image fixtures; this hook is here so the harness file already
// has a destination when image fixtures land in a follow-up.
describe.skipIf(!REAL_API)('/api/identify eval (real API)', () => {
  it.todo('hits live OpenRouter with image fixtures and asserts ±10 confidence band');
});
