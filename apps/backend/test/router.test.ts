import { describe, expect, it, vi } from 'vitest';
import { identifyRouter, parseIdentify } from '../src/llm/router';
import type { callFree as callFreeFn, CallResult } from '../src/llm/openrouter';

const HIGH_CONF_FREE = JSON.stringify({
  species_slug: 'monstera_deliciosa',
  species_label: 'Monstera Deliciosa',
  confidence: 92,
  alternatives: [
    { species_slug: 'philodendron_hederaceum', species_label: 'Heartleaf Philodendron', confidence: 7 },
  ],
});

const LOW_CONF_FREE = JSON.stringify({
  species_slug: 'ficus_lyrata',
  species_label: 'Fiddle Leaf Fig',
  confidence: 42,
  alternatives: [],
});

const HIGH_CONF_PAID = JSON.stringify({
  species_slug: 'ficus_lyrata',
  species_label: 'Fiddle Leaf Fig',
  confidence: 88,
  alternatives: [],
});

function ok(content: string, latency_ms = 50): CallResult {
  return { ok: true, content, latency_ms };
}
function err(
  reason: 'timeout' | 'http_error' | 'empty' | 'aborted',
  latency_ms = 10,
): CallResult {
  return { ok: false, reason, latency_ms };
}

// Typed mock factory so .mock.calls is inferred as the real param tuple
// instead of `never[]`.
type CallFn = typeof callFreeFn;
function makeCall(impl: CallFn): ReturnType<typeof vi.fn<CallFn>> {
  return vi.fn<CallFn>(impl);
}

const baseInput = { imageDataUrl: 'data:image/jpeg;base64,xxxx' };
const baseDeps = { apiKey: 'test-key' };

describe('identifyRouter', () => {
  it('returns free result when confidence >= 70 and never calls paid', async () => {
    const callFree = vi.fn(async () => ok(HIGH_CONF_FREE));
    const callPaid = vi.fn(async () => ok(HIGH_CONF_PAID));

    const res = await identifyRouter(baseInput, { ...baseDeps, callFree, callPaid });

    expect(callFree).toHaveBeenCalledOnce();
    expect(callPaid).not.toHaveBeenCalled();
    expect(res.source).toBe('free');
    expect(res.species_slug).toBe('monstera_deliciosa');
    expect(res.confidence).toBe(92);
    expect(res.alternatives).toHaveLength(1);
    expect(res.latency_ms).toBeGreaterThanOrEqual(0);
  });

  it('escalates to paid on JSON parse failure', async () => {
    const callFree = vi.fn(async () => ok('I cannot identify this plant from the photo.'));
    const callPaid = vi.fn(async () => ok(HIGH_CONF_PAID));

    const res = await identifyRouter(baseInput, { ...baseDeps, callFree, callPaid });

    expect(callFree).toHaveBeenCalledOnce();
    expect(callPaid).toHaveBeenCalledOnce();
    expect(res.source).toBe('paid_escalated');
    expect(res.species_slug).toBe('ficus_lyrata');
  });

  it('escalates to paid on confidence < 70', async () => {
    const callFree = vi.fn(async () => ok(LOW_CONF_FREE));
    const callPaid = vi.fn(async () => ok(HIGH_CONF_PAID));

    const res = await identifyRouter(baseInput, { ...baseDeps, callFree, callPaid });

    expect(callPaid).toHaveBeenCalledOnce();
    expect(res.source).toBe('paid_escalated');
    expect(res.confidence).toBe(88);
  });

  it('returns low-confidence free result if paid escalation also fails to parse', async () => {
    const callFree = vi.fn(async () => ok(LOW_CONF_FREE));
    const callPaid = vi.fn(async () => ok('still no idea'));

    const res = await identifyRouter(baseInput, { ...baseDeps, callFree, callPaid });

    expect(res.source).toBe('free');
    expect(res.species_slug).toBe('ficus_lyrata');
    expect(res.confidence).toBe(42);
  });

  it('returns free_failed fallback when free errors and paid errors', async () => {
    const callFree = vi.fn(async () => err('timeout'));
    const callPaid = vi.fn(async () => err('http_error'));

    const res = await identifyRouter(baseInput, { ...baseDeps, callFree, callPaid });

    expect(res.source).toBe('free_failed');
    expect(res.species_slug).toBe('unknown');
    expect(res.confidence).toBe(0);
    expect(res.alternatives).toEqual([]);
  });

  it('skips escalation when budget gate refuses (parse failure path)', async () => {
    const callFree = vi.fn(async () => ok('garbage'));
    const callPaid = vi.fn(async () => ok(HIGH_CONF_PAID));
    const tryConsumeEscalation = vi.fn(async () => false);

    const res = await identifyRouter(baseInput, {
      ...baseDeps,
      callFree,
      callPaid,
      tryConsumeEscalation,
    });

    expect(tryConsumeEscalation).toHaveBeenCalledOnce();
    expect(callPaid).not.toHaveBeenCalled();
    expect(res.source).toBe('free_failed');
  });

  it('skips escalation when budget gate refuses (low-confidence path) and returns free result', async () => {
    const callFree = vi.fn(async () => ok(LOW_CONF_FREE));
    const callPaid = vi.fn(async () => ok(HIGH_CONF_PAID));
    const tryConsumeEscalation = vi.fn(async () => false);

    const res = await identifyRouter(baseInput, {
      ...baseDeps,
      callFree,
      callPaid,
      tryConsumeEscalation,
    });

    expect(callPaid).not.toHaveBeenCalled();
    expect(res.source).toBe('free');
    expect(res.confidence).toBe(42);
  });

  it('escalates exactly at the 70 boundary minus one (69 → escalate)', async () => {
    const just_under = JSON.stringify({
      species_slug: 'a',
      species_label: 'A',
      confidence: 69,
      alternatives: [],
    });
    const callFree = vi.fn(async () => ok(just_under));
    const callPaid = vi.fn(async () => ok(HIGH_CONF_PAID));

    const res = await identifyRouter(baseInput, { ...baseDeps, callFree, callPaid });

    expect(callPaid).toHaveBeenCalledOnce();
    expect(res.source).toBe('paid_escalated');
  });

  it('does NOT escalate exactly at 70', async () => {
    const just_at = JSON.stringify({
      species_slug: 'a',
      species_label: 'A',
      confidence: 70,
      alternatives: [],
    });
    const callFree = vi.fn(async () => ok(just_at));
    const callPaid = vi.fn(async () => ok(HIGH_CONF_PAID));

    const res = await identifyRouter(baseInput, { ...baseDeps, callFree, callPaid });

    expect(callPaid).not.toHaveBeenCalled();
    expect(res.source).toBe('free');
  });

  it('passes SYSTEM_PROMPT_IDENTIFY to BOTH free and paid calls', async () => {
    // Regression guard: if someone wires a different prompt into tryEscalate
    // by accident, the escalated model would identify against the wrong
    // contract and parse failures would explode silently.
    const callFree = makeCall(async () => ok('garbage'));
    const callPaid = makeCall(async () => ok(HIGH_CONF_PAID));

    await identifyRouter(baseInput, { ...baseDeps, callFree, callPaid });

    const freeArg = callFree.mock.calls[0]![0]!;
    const paidArg = callPaid.mock.calls[0]![0]!;
    expect(freeArg.systemPrompt).toBe(paidArg.systemPrompt);
    expect(freeArg.systemPrompt).toMatch(/plant identification expert/);
    expect(freeArg.systemPrompt).toMatch(/STRICT JSON only/);
  });

  it('skips escalation when caller signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const callFree = makeCall(async () => err('aborted'));
    const callPaid = makeCall(async () => ok(HIGH_CONF_PAID));

    const res = await identifyRouter(baseInput, {
      ...baseDeps,
      callFree,
      callPaid,
      signal: controller.signal,
    });

    expect(callPaid).not.toHaveBeenCalled();
    expect(res.source).toBe('free_failed');
  });

  it('forwards caller signal to both free and paid HTTP calls', async () => {
    const controller = new AbortController();
    const callFree = makeCall(async () => ok(LOW_CONF_FREE));
    const callPaid = makeCall(async () => ok(HIGH_CONF_PAID));

    await identifyRouter(baseInput, {
      ...baseDeps,
      callFree,
      callPaid,
      signal: controller.signal,
    });

    expect(callFree.mock.calls[0]![0]!.signal).toBe(controller.signal);
    expect(callPaid.mock.calls[0]![0]!.signal).toBe(controller.signal);
  });
});

describe('parseIdentify', () => {
  it('rounds float confidence and clamps to [0,100]', () => {
    const raw = JSON.stringify({
      species_slug: 'a',
      species_label: 'A',
      confidence: 92.7,
      alternatives: [{ species_slug: 'b', species_label: 'B', confidence: 150 }],
    });
    const out = parseIdentify(raw);
    expect(out?.confidence).toBe(93);
    expect(out?.alternatives[0]?.confidence).toBe(100);
  });

  it('caps alternatives at 5 entries', () => {
    const alts = Array.from({ length: 20 }, (_, i) => ({
      species_slug: `a${i}`,
      species_label: `A${i}`,
      confidence: 5,
    }));
    const raw = JSON.stringify({
      species_slug: 'main',
      species_label: 'Main',
      confidence: 80,
      alternatives: alts,
    });
    expect(parseIdentify(raw)?.alternatives).toHaveLength(5);
  });

  it('falls back to species_slug when species_label missing', () => {
    const raw = JSON.stringify({
      species_slug: 'monstera_deliciosa',
      confidence: 90,
    });
    expect(parseIdentify(raw)?.species_label).toBe('monstera_deliciosa');
  });

  it('rejects when species_slug is missing or empty', () => {
    expect(parseIdentify('{"confidence":80}')).toBeNull();
    expect(parseIdentify('{"species_slug":"","confidence":80}')).toBeNull();
  });

  it('rejects when confidence is non-numeric', () => {
    expect(parseIdentify('{"species_slug":"a","confidence":"high"}')).toBeNull();
  });

  it('rejects when confidence is NaN/Infinity', () => {
    expect(parseIdentify('{"species_slug":"a","confidence":null}')).toBeNull();
  });

  it('caps alternatives at 5 with early exit (does not validate beyond cap)', () => {
    // 100 alternatives — early exit means we should stop after 5 valid ones
    // so a hostile model returning a huge array can't DoS the parser.
    const alts = Array.from({ length: 100 }, (_, i) => ({
      species_slug: `a${i}`,
      species_label: `A${i}`,
      confidence: 5,
    }));
    const raw = JSON.stringify({
      species_slug: 'main',
      species_label: 'Main',
      confidence: 80,
      alternatives: alts,
    });
    const result = parseIdentify(raw);
    expect(result?.alternatives).toHaveLength(5);
    // Verify we got the FIRST five (early-exit), not e.g. the last five
    expect(result?.alternatives.map((a) => a.species_slug)).toEqual(['a0', 'a1', 'a2', 'a3', 'a4']);
  });

  it('drops malformed alternative entries silently', () => {
    const raw = JSON.stringify({
      species_slug: 'a',
      species_label: 'A',
      confidence: 80,
      alternatives: [
        { species_slug: 'b', species_label: 'B', confidence: 10 },
        { species_slug: 'c' }, // missing confidence → drop
        'garbage', // not an object → drop
        { species_slug: 'd', species_label: 'D', confidence: 5 },
      ],
    });
    const alts = parseIdentify(raw)?.alternatives;
    expect(alts).toHaveLength(2);
    expect(alts?.map((a) => a.species_slug)).toEqual(['b', 'd']);
  });
});
