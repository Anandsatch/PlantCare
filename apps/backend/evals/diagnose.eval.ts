import { describe, expect, it } from 'vitest';
import { diagnoseRouter } from '../src/llm/router';
import { diagnoseFixtures } from './fixtures/diagnose';
import {
  assertConfidenceBand,
  expectCallArgs,
  mockCalls,
  REAL_API,
} from './eval-runner';

const DIAGNOSE_PROMPT_FRAGMENT = 'plant health diagnostician';

const baseInput = { kind: 'vision' as const, imageDataUrl: 'data:image/png;base64,deadbeef' };
const apiKey = 'test-key';

describe('/api/diagnose eval (mock mode)', () => {
  for (const fx of diagnoseFixtures) {
    it(`[${fx.category}] ${fx.name}`, async () => {
      const callFree = mockCalls({ kind: 'ok', content: fx.mock_response });
      const callPaid = mockCalls({ kind: 'error', reason: 'http_error' });

      const result = await diagnoseRouter(baseInput, { apiKey, callFree, callPaid });

      expectCallArgs(callFree, 0, {
        kind: 'vision',
        systemPromptIncludes: DIAGNOSE_PROMPT_FRAGMENT,
      });

      if (fx.expected.is_reject) {
        // Cat reject: free returns 'unknown' with low confidence; router
        // attempts escalation (paid mock fails), result is the low-conf
        // free fallback. fix_steps MUST be empty on reject — a parser
        // bug returning instructions for an unidentified plant is a
        // P1-class user-visible regression.
        expect(result.disease_slug).toBe('unknown');
        expect(result.confidence).toBeLessThan(30);
        expect(result.fix_steps).toHaveLength(0);
        expect(result.alternatives).toHaveLength(0);
        expect(callFree).toHaveBeenCalledOnce();
        expect(callPaid).toHaveBeenCalledOnce();
        return;
      }

      expect(result.source).toBe('free');
      expect(result.disease_slug).toBe(fx.expected.disease_slug);
      expect(result.severity).toBe(fx.expected.severity);
      assertConfidenceBand(fx.name, result.confidence, fx.expected.confidence_baseline);

      // Healthy: fix_steps must be empty per the system prompt.
      // Sick: fix_steps must meet the per-fixture minimum.
      if (fx.category === 'healthy') {
        expect(result.fix_steps).toHaveLength(0);
      } else if (fx.expected.fix_steps_min !== undefined) {
        expect(result.fix_steps.length).toBeGreaterThanOrEqual(fx.expected.fix_steps_min);
      }

      expect(callFree).toHaveBeenCalledOnce();
      expect(callPaid).not.toHaveBeenCalled();
    });
  }

  it('paid escalation success path', async () => {
    const callFree = mockCalls({ kind: 'ok', content: 'not parseable as JSON' });
    const callPaid = mockCalls({ kind: 'ok', content: diagnoseFixtures[0].mock_response });

    const result = await diagnoseRouter(baseInput, { apiKey, callFree, callPaid });

    expect(callFree).toHaveBeenCalledOnce();
    expect(callPaid).toHaveBeenCalledOnce();
    expect(result.source).toBe('paid_escalated');
    expect(result.disease_slug).toBe('spider_mites');
    expect(result.severity).toBe('medium');
    expect(result.fix_steps.length).toBeGreaterThanOrEqual(2);
    expectCallArgs(callPaid, 0, {
      kind: 'vision',
      systemPromptIncludes: DIAGNOSE_PROMPT_FRAGMENT,
    });
  });

  it('parsed shape snapshot across all fixtures', async () => {
    const parsed = [];
    for (const fx of diagnoseFixtures) {
      const callFree = mockCalls({ kind: 'ok', content: fx.mock_response });
      const callPaid = mockCalls({ kind: 'error', reason: 'http_error' });
      const r = await diagnoseRouter(baseInput, { apiKey, callFree, callPaid });
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { latency_ms: _l, ...rest } = r;
      parsed.push({ name: fx.name, ...rest });
    }
    expect(parsed).toMatchSnapshot();
  });
});

describe.skipIf(!REAL_API)('/api/diagnose eval (real API)', () => {
  it.todo('hits live OpenRouter with image fixtures and asserts ±10 confidence band');
});
