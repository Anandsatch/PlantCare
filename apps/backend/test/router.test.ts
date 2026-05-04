import { describe, expect, it, vi } from 'vitest';
import {
  identifyRouter,
  parseIdentify,
  diagnoseRouter,
  parseDiagnose,
  consultRouter,
  parseConsult,
} from '../src/llm/router';
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

const baseInput = { kind: 'vision' as const, imageDataUrl: 'data:image/jpeg;base64,xxxx' };
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

// ─── Diagnose ────────────────────────────────────────────────────────────

const HIGH_CONF_DIAGNOSE_FREE = JSON.stringify({
  disease_slug: 'spider_mites',
  disease_label: 'Spider mites',
  confidence: 85,
  severity: 'medium',
  fix_steps: [
    'Isolate the plant from neighbors.',
    'Rinse both sides of leaves with water.',
    'Apply insecticidal soap weekly for 3 weeks.',
  ],
  alternatives: [
    { disease_slug: 'sun_stress', disease_label: 'Sun stress', confidence: 10 },
  ],
});

const LOW_CONF_DIAGNOSE_FREE = JSON.stringify({
  disease_slug: 'leaf_spot',
  disease_label: 'Leaf spot',
  confidence: 35,
  severity: 'low',
  fix_steps: ['Trim affected leaves.'],
  alternatives: [],
});

const HIGH_CONF_DIAGNOSE_PAID = JSON.stringify({
  disease_slug: 'root_rot',
  disease_label: 'Root rot',
  confidence: 91,
  severity: 'high',
  fix_steps: ['Repot in fresh dry soil.', 'Cut away mushy roots.'],
  alternatives: [],
});

describe('diagnoseRouter', () => {
  it('returns free result when confidence >= 70 and never calls paid', async () => {
    const callFree = vi.fn(async () => ok(HIGH_CONF_DIAGNOSE_FREE));
    const callPaid = vi.fn(async () => ok(HIGH_CONF_DIAGNOSE_PAID));

    const res = await diagnoseRouter(baseInput, { ...baseDeps, callFree, callPaid });

    expect(callPaid).not.toHaveBeenCalled();
    expect(res.source).toBe('free');
    expect(res.disease_slug).toBe('spider_mites');
    expect(res.severity).toBe('medium');
    expect(res.fix_steps).toHaveLength(3);
    expect(res.alternatives).toHaveLength(1);
  });

  it('escalates to paid on JSON parse failure', async () => {
    const callFree = vi.fn(async () => ok('I cannot diagnose this.'));
    const callPaid = vi.fn(async () => ok(HIGH_CONF_DIAGNOSE_PAID));

    const res = await diagnoseRouter(baseInput, { ...baseDeps, callFree, callPaid });

    expect(callPaid).toHaveBeenCalledOnce();
    expect(res.source).toBe('paid_escalated');
    expect(res.disease_slug).toBe('root_rot');
    expect(res.severity).toBe('high');
  });

  it('escalates to paid on confidence < 70', async () => {
    const callFree = vi.fn(async () => ok(LOW_CONF_DIAGNOSE_FREE));
    const callPaid = vi.fn(async () => ok(HIGH_CONF_DIAGNOSE_PAID));

    const res = await diagnoseRouter(baseInput, { ...baseDeps, callFree, callPaid });

    expect(callPaid).toHaveBeenCalledOnce();
    expect(res.source).toBe('paid_escalated');
    expect(res.disease_slug).toBe('root_rot');
  });

  it('returns low-confidence free result if paid escalation also fails to parse', async () => {
    const callFree = vi.fn(async () => ok(LOW_CONF_DIAGNOSE_FREE));
    const callPaid = vi.fn(async () => ok('still no idea'));

    const res = await diagnoseRouter(baseInput, { ...baseDeps, callFree, callPaid });

    expect(res.source).toBe('free');
    expect(res.disease_slug).toBe('leaf_spot');
    expect(res.confidence).toBe(35);
    expect(res.severity).toBe('low');
  });

  it('returns diagnose-shaped free_failed fallback when both calls error', async () => {
    const callFree = vi.fn(async () => err('timeout'));
    const callPaid = vi.fn(async () => err('http_error'));

    const res = await diagnoseRouter(baseInput, { ...baseDeps, callFree, callPaid });

    expect(res.source).toBe('free_failed');
    expect(res.disease_slug).toBe('unknown');
    expect(res.disease_label).toBe('Unknown');
    expect(res.confidence).toBe(0);
    // Severity is 'medium' on no-info fallback — matches the
    // anti-silent-downgrade rule used by normalizeSeverity. Keeping this
    // assertion explicit because P2 review previously caught it as 'low'.
    expect(res.severity).toBe('medium');
    expect(res.fix_steps).toEqual([]);
    expect(res.alternatives).toEqual([]);
  });

  it('passes SYSTEM_PROMPT_DIAGNOSE (not the identify prompt) to both free and paid calls', async () => {
    // Regression guard: with the shared factory it's easy to accidentally
    // bind the wrong prompt at the call site.
    const callFree = makeCall(async () => ok('garbage'));
    const callPaid = makeCall(async () => ok(HIGH_CONF_DIAGNOSE_PAID));

    await diagnoseRouter(baseInput, { ...baseDeps, callFree, callPaid });

    const freeArg = callFree.mock.calls[0]![0]!;
    const paidArg = callPaid.mock.calls[0]![0]!;
    expect(freeArg.systemPrompt).toBe(paidArg.systemPrompt);
    expect(freeArg.systemPrompt).toMatch(/plant health diagnostician/);
    expect(freeArg.systemPrompt).toMatch(/disease_slug/);
    expect(freeArg.systemPrompt).not.toMatch(/plant identification expert/);
  });

  it('skips escalation when budget gate refuses', async () => {
    const callFree = vi.fn(async () => ok('garbage'));
    const callPaid = vi.fn(async () => ok(HIGH_CONF_DIAGNOSE_PAID));
    const tryConsumeEscalation = vi.fn(async () => false);

    const res = await diagnoseRouter(baseInput, {
      ...baseDeps,
      callFree,
      callPaid,
      tryConsumeEscalation,
    });

    expect(callPaid).not.toHaveBeenCalled();
    expect(res.source).toBe('free_failed');
  });
});

describe('parseDiagnose', () => {
  const base = {
    disease_slug: 'spider_mites',
    disease_label: 'Spider mites',
    confidence: 80,
    severity: 'medium' as const,
    fix_steps: ['Step one.', 'Step two.'],
    alternatives: [],
  };

  it('parses a well-formed diagnosis', () => {
    const out = parseDiagnose(JSON.stringify(base));
    expect(out).not.toBeNull();
    expect(out?.disease_slug).toBe('spider_mites');
    expect(out?.severity).toBe('medium');
    expect(out?.fix_steps).toEqual(['Step one.', 'Step two.']);
  });

  it('clamps + rounds confidence to [0,100]', () => {
    const out = parseDiagnose(JSON.stringify({ ...base, confidence: 92.7 }));
    expect(out?.confidence).toBe(93);
    const high = parseDiagnose(JSON.stringify({ ...base, confidence: 150 }));
    expect(high?.confidence).toBe(100);
    const neg = parseDiagnose(JSON.stringify({ ...base, confidence: -5 }));
    expect(neg?.confidence).toBe(0);
  });

  it('falls back to disease_slug when disease_label missing', () => {
    const raw = JSON.stringify({ ...base, disease_label: undefined });
    expect(parseDiagnose(raw)?.disease_label).toBe('spider_mites');
  });

  it('rejects when disease_slug is missing or empty', () => {
    expect(parseDiagnose(JSON.stringify({ ...base, disease_slug: '' }))).toBeNull();
    expect(parseDiagnose('{"confidence":80}')).toBeNull();
  });

  it('rejects when confidence is non-numeric or NaN', () => {
    expect(parseDiagnose(JSON.stringify({ ...base, confidence: 'high' }))).toBeNull();
    expect(parseDiagnose('{"disease_slug":"a","confidence":null,"severity":"low"}')).toBeNull();
  });

  it('caps fix_steps at 8 entries with early-exit', () => {
    const steps = Array.from({ length: 50 }, (_, i) => `step ${i}`);
    const out = parseDiagnose(JSON.stringify({ ...base, fix_steps: steps }));
    expect(out?.fix_steps).toHaveLength(8);
    expect(out?.fix_steps[0]).toBe('step 0');
    expect(out?.fix_steps[7]).toBe('step 7');
  });

  it('drops non-string fix_steps + trims + drops empty', () => {
    const out = parseDiagnose(
      JSON.stringify({
        ...base,
        fix_steps: ['  Trim leaves.  ', 42, null, '', '   ', 'Repot.'],
      }),
    );
    expect(out?.fix_steps).toEqual(['Trim leaves.', 'Repot.']);
  });

  it('caps alternatives at 5 with early-exit', () => {
    const alts = Array.from({ length: 100 }, (_, i) => ({
      disease_slug: `d${i}`,
      disease_label: `D${i}`,
      confidence: 5,
    }));
    const out = parseDiagnose(JSON.stringify({ ...base, alternatives: alts }));
    expect(out?.alternatives).toHaveLength(5);
    expect(out?.alternatives.map((a) => a.disease_slug)).toEqual(['d0', 'd1', 'd2', 'd3', 'd4']);
  });

  it('drops malformed alternative entries silently', () => {
    const raw = JSON.stringify({
      ...base,
      alternatives: [
        { disease_slug: 'a', disease_label: 'A', confidence: 10 },
        { disease_slug: 'b' }, // missing confidence → drop
        'garbage',
        { disease_slug: 'c', disease_label: 'C', confidence: 8 },
      ],
    });
    const alts = parseDiagnose(raw)?.alternatives;
    expect(alts?.map((a) => a.disease_slug)).toEqual(['a', 'c']);
  });

  describe('severity normalization (Option C)', () => {
    it('passes through canonical low/medium/high', () => {
      expect(parseDiagnose(JSON.stringify({ ...base, severity: 'low' }))?.severity).toBe('low');
      expect(parseDiagnose(JSON.stringify({ ...base, severity: 'medium' }))?.severity).toBe('medium');
      expect(parseDiagnose(JSON.stringify({ ...base, severity: 'high' }))?.severity).toBe('high');
    });

    it('maps known synonyms', () => {
      expect(parseDiagnose(JSON.stringify({ ...base, severity: 'severe' }))?.severity).toBe('high');
      expect(parseDiagnose(JSON.stringify({ ...base, severity: 'critical' }))?.severity).toBe('high');
      expect(parseDiagnose(JSON.stringify({ ...base, severity: 'moderate' }))?.severity).toBe('medium');
      expect(parseDiagnose(JSON.stringify({ ...base, severity: 'mild' }))?.severity).toBe('low');
      expect(parseDiagnose(JSON.stringify({ ...base, severity: 'minor' }))?.severity).toBe('low');
    });

    it('is case-insensitive', () => {
      expect(parseDiagnose(JSON.stringify({ ...base, severity: 'HIGH' }))?.severity).toBe('high');
      expect(parseDiagnose(JSON.stringify({ ...base, severity: 'Severe' }))?.severity).toBe('high');
    });

    it('handles prose tails by taking the first token', () => {
      expect(
        parseDiagnose(JSON.stringify({ ...base, severity: 'high — likely fatal if untreated' }))
          ?.severity,
      ).toBe('high');
      expect(parseDiagnose(JSON.stringify({ ...base, severity: 'severe, act now' }))?.severity).toBe(
        'high',
      );
    });

    it('defaults to medium (NOT low) on unknown words to avoid silent downgrades', () => {
      expect(parseDiagnose(JSON.stringify({ ...base, severity: 'catastrophic' }))?.severity).toBe(
        'medium',
      );
      expect(parseDiagnose(JSON.stringify({ ...base, severity: 'mehhh' }))?.severity).toBe(
        'medium',
      );
    });

    it('defaults to medium when severity is missing or non-string', () => {
      const noSev = JSON.stringify({
        disease_slug: 'a',
        disease_label: 'A',
        confidence: 80,
        fix_steps: [],
        alternatives: [],
      });
      expect(parseDiagnose(noSev)?.severity).toBe('medium');
      expect(parseDiagnose(JSON.stringify({ ...base, severity: 7 }))?.severity).toBe('medium');
      expect(parseDiagnose(JSON.stringify({ ...base, severity: null }))?.severity).toBe('medium');
    });
  });
});

// ─── Consult ─────────────────────────────────────────────────────────────

const HIGH_CONF_CONSULT_FREE = JSON.stringify({
  rejected: false,
  revised_interval_days: 5,
  reasoning: 'Repotting stress lowers water needs; back off to every 5 days.',
  confidence: 82,
});

const LOW_CONF_CONSULT_FREE = JSON.stringify({
  rejected: false,
  revised_interval_days: 7,
  reasoning: 'Hard to tell without seeing the plant.',
  confidence: 40,
});

const HIGH_CONF_CONSULT_PAID = JSON.stringify({
  rejected: false,
  revised_interval_days: 4,
  reasoning: 'Paid model: post-repot soil retains moisture longer than usual.',
  confidence: 90,
});

const REJECTED_FREE = JSON.stringify({
  rejected: true,
  reason: 'not_plant_related',
});

const consultTextInput = {
  kind: 'text' as const,
  userMessage: 'Plant: species=monstera_deliciosa\nNote: I just repotted it.',
};

describe('consultRouter', () => {
  it('returns recommendation when free model parses cleanly with confidence >= 70', async () => {
    const callFree = vi.fn(async () => ok(HIGH_CONF_CONSULT_FREE));
    const callPaid = vi.fn(async () => ok(HIGH_CONF_CONSULT_PAID));

    const res = await consultRouter(consultTextInput, { ...baseDeps, callFree, callPaid });

    expect(callPaid).not.toHaveBeenCalled();
    expect(res.kind).toBe('recommendation');
    if (res.kind === 'recommendation') {
      expect(res.revised_interval_days).toBe(5);
      expect(res.confidence).toBe(82);
      expect(res.source).toBe('free');
    }
  });

  it('escalates to paid on confidence < 70 and returns paid recommendation', async () => {
    const callFree = vi.fn(async () => ok(LOW_CONF_CONSULT_FREE));
    const callPaid = vi.fn(async () => ok(HIGH_CONF_CONSULT_PAID));

    const res = await consultRouter(consultTextInput, { ...baseDeps, callFree, callPaid });

    expect(callPaid).toHaveBeenCalledOnce();
    expect(res.source).toBe('paid_escalated');
    if (res.kind === 'recommendation') {
      expect(res.revised_interval_days).toBe(4);
      expect(res.confidence).toBe(90);
    }
  });

  it('returns rejection IMMEDIATELY without escalation (off-topic is terminal)', async () => {
    // Critical guard: rejection is a confident structural answer, not a
    // confidence-< 70 problem. Escalating to paid burns budget for the same
    // result and hands a hostile note an extra retry against a stronger model.
    const callFree = vi.fn(async () => ok(REJECTED_FREE));
    const callPaid = vi.fn(async () => ok(HIGH_CONF_CONSULT_PAID));

    const res = await consultRouter(consultTextInput, { ...baseDeps, callFree, callPaid });

    expect(callFree).toHaveBeenCalledOnce();
    expect(callPaid).not.toHaveBeenCalled();
    expect(res.kind).toBe('rejected_off_topic');
    expect(res.source).toBe('free');
    if (res.kind === 'rejected_off_topic') {
      expect(res.reason).toBe('not_plant_related');
    }
  });

  it('rejection path also skips the budget gate (tryConsumeEscalation NOT called)', async () => {
    // Stronger guard than the test above: even checking the budget gate on
    // rejection is wrong, because the answer is final regardless of the gate.
    // This catches a refactor that wires rejection through tryEscalate "just
    // to be safe" — which would also leak a request count to a future
    // budget-meter regression.
    const callFree = vi.fn(async () => ok(REJECTED_FREE));
    const callPaid = vi.fn(async () => ok(HIGH_CONF_CONSULT_PAID));
    const tryConsumeEscalation = vi.fn(async () => true);

    const res = await consultRouter(consultTextInput, {
      ...baseDeps,
      callFree,
      callPaid,
      tryConsumeEscalation,
    });

    expect(tryConsumeEscalation).not.toHaveBeenCalled();
    expect(callPaid).not.toHaveBeenCalled();
    expect(res.kind).toBe('rejected_off_topic');
  });

  it('escalates on JSON parse failure and returns paid recommendation', async () => {
    const callFree = vi.fn(async () => ok('I cannot help with that.'));
    const callPaid = vi.fn(async () => ok(HIGH_CONF_CONSULT_PAID));

    const res = await consultRouter(consultTextInput, { ...baseDeps, callFree, callPaid });

    expect(callPaid).toHaveBeenCalledOnce();
    expect(res.source).toBe('paid_escalated');
    expect(res.kind).toBe('recommendation');
  });

  it('escalates on missing rejected discriminator', async () => {
    // A model that returns recommendation-shaped JSON without the explicit
    // `rejected: false` field is violating the contract — escalate.
    const noDiscriminator = JSON.stringify({
      revised_interval_days: 5,
      reasoning: 'fine',
      confidence: 80,
    });
    const callFree = vi.fn(async () => ok(noDiscriminator));
    const callPaid = vi.fn(async () => ok(HIGH_CONF_CONSULT_PAID));

    const res = await consultRouter(consultTextInput, { ...baseDeps, callFree, callPaid });

    expect(callPaid).toHaveBeenCalledOnce();
    expect(res.source).toBe('paid_escalated');
  });

  it('returns degraded recommendation fallback when free + paid both error', async () => {
    const callFree = vi.fn(async () => err('http_error'));
    const callPaid = vi.fn(async () => err('http_error'));

    const res = await consultRouter(consultTextInput, { ...baseDeps, callFree, callPaid });

    expect(res.source).toBe('free_failed');
    expect(res.kind).toBe('recommendation');
    if (res.kind === 'recommendation') {
      expect(res.confidence).toBe(0);
      expect(res.revised_interval_days).toBe(7);
      expect(res.reasoning).toMatch(/try again/i);
    }
  });

  it('uses SYSTEM_PROMPT_CONSULT (not identify or diagnose) for both free and paid', async () => {
    const callFree = makeCall(async () => ok('garbage'));
    const callPaid = makeCall(async () => ok(HIGH_CONF_CONSULT_PAID));

    await consultRouter(consultTextInput, { ...baseDeps, callFree, callPaid });

    const freeArg = callFree.mock.calls[0]![0]!;
    const paidArg = callPaid.mock.calls[0]![0]!;
    expect(freeArg.systemPrompt).toBe(paidArg.systemPrompt);
    expect(freeArg.systemPrompt).toMatch(/plant care advisor/);
    expect(freeArg.systemPrompt).toMatch(/rejected/);
    expect(freeArg.systemPrompt).not.toMatch(/plant identification expert/);
    expect(freeArg.systemPrompt).not.toMatch(/plant health diagnostician/);
  });

  it('threads text-arm input through to the call', async () => {
    const callFree = makeCall(async () => ok(HIGH_CONF_CONSULT_FREE));
    const callPaid = makeCall(async () => ok(HIGH_CONF_CONSULT_PAID));

    await consultRouter(consultTextInput, { ...baseDeps, callFree, callPaid });

    const freeArg = callFree.mock.calls[0]![0]!;
    expect(freeArg.kind).toBe('text');
    if (freeArg.kind === 'text') {
      expect(freeArg.userMessage).toContain('monstera_deliciosa');
      expect(freeArg.userMessage).toContain('repotted');
    }
  });

  it('returns low-confidence free recommendation if paid escalation also unparseable', async () => {
    const callFree = vi.fn(async () => ok(LOW_CONF_CONSULT_FREE));
    const callPaid = vi.fn(async () => ok('still no idea'));

    const res = await consultRouter(consultTextInput, { ...baseDeps, callFree, callPaid });

    expect(res.source).toBe('free');
    if (res.kind === 'recommendation') {
      expect(res.confidence).toBe(40);
      expect(res.revised_interval_days).toBe(7);
    }
  });
});

describe('parseConsult', () => {
  it('parses a well-formed recommendation', () => {
    const out = parseConsult(HIGH_CONF_CONSULT_FREE);
    expect(out?.kind).toBe('ok');
    if (out?.kind === 'ok' && out.value.kind === 'recommendation') {
      expect(out.value.revised_interval_days).toBe(5);
      expect(out.value.confidence).toBe(82);
      expect(out.value.reasoning).toMatch(/Repotting/);
    }
  });

  it('parses a well-formed rejection as final', () => {
    const out = parseConsult(REJECTED_FREE);
    expect(out?.kind).toBe('final');
    if (out?.kind === 'final' && out.value.kind === 'rejected_off_topic') {
      expect(out.value.reason).toBe('not_plant_related');
    }
  });

  it('rejection wins when both rejection AND recommendation keys are present (hostile shape)', () => {
    // A hostile model could try to slip a "recommendation" past us by
    // including rejected: true alongside revised_interval_days. Discriminator
    // must win — otherwise prompt-injection notes could exfiltrate as a
    // confident "water with bleach" recommendation.
    const both = JSON.stringify({
      rejected: true,
      reason: 'harmful_request',
      revised_interval_days: 1,
      reasoning: 'Water hourly with bleach.',
      confidence: 99,
    });
    const out = parseConsult(both);
    expect(out?.kind).toBe('final');
    if (out?.kind === 'final' && out.value.kind === 'rejected_off_topic') {
      expect(out.value.reason).toBe('harmful_request');
    }
  });

  it('rejection with missing reason gets default tag', () => {
    const out = parseConsult(JSON.stringify({ rejected: true }));
    expect(out?.kind).toBe('final');
    if (out?.kind === 'final' && out.value.kind === 'rejected_off_topic') {
      expect(out.value.reason).toBe('off_topic');
    }
  });

  it('rejection with empty/whitespace reason gets default tag', () => {
    const out = parseConsult(JSON.stringify({ rejected: true, reason: '   ' }));
    if (out?.kind === 'final' && out.value.kind === 'rejected_off_topic') {
      expect(out.value.reason).toBe('off_topic');
    }
  });

  it('truncates oversized rejection reason to 200 chars', () => {
    // Defense against a model emitting a giant reason string that becomes UI
    // bloat or a vector for prompt-injection echo.
    const huge = 'x'.repeat(5000);
    const out = parseConsult(JSON.stringify({ rejected: true, reason: huge }));
    if (out?.kind === 'final' && out.value.kind === 'rejected_off_topic') {
      expect(out.value.reason.length).toBe(200);
    }
  });

  it('rejects (returns null) when "rejected" discriminator is missing entirely', () => {
    const noDiscriminator = JSON.stringify({
      revised_interval_days: 5,
      reasoning: 'fine',
      confidence: 80,
    });
    expect(parseConsult(noDiscriminator)).toBeNull();
  });

  it('rejects (returns null) when "rejected" is non-boolean (e.g. "true" string)', () => {
    expect(
      parseConsult(JSON.stringify({ rejected: 'true', reason: 'x' })),
    ).toBeNull();
  });

  it('rejects (returns null) when recommendation has non-numeric revised_interval_days', () => {
    // Hostile-input case: model emits "water with bleach" as the days value.
    expect(
      parseConsult(
        JSON.stringify({
          rejected: false,
          revised_interval_days: 'water with bleach',
          reasoning: 'fine',
          confidence: 80,
        }),
      ),
    ).toBeNull();
  });

  it('rejects (returns null) when recommendation has empty reasoning', () => {
    expect(
      parseConsult(
        JSON.stringify({
          rejected: false,
          revised_interval_days: 5,
          reasoning: '   ',
          confidence: 80,
        }),
      ),
    ).toBeNull();
  });

  it('rejects (returns null) when recommendation confidence is non-numeric', () => {
    expect(
      parseConsult(
        JSON.stringify({
          rejected: false,
          revised_interval_days: 5,
          reasoning: 'ok',
          confidence: 'high',
        }),
      ),
    ).toBeNull();
  });

  it('clamps revised_interval_days to [1, 30]', () => {
    const tooLow = parseConsult(
      JSON.stringify({ rejected: false, revised_interval_days: -3, reasoning: 'r', confidence: 80 }),
    );
    if (tooLow?.kind === 'ok' && tooLow.value.kind === 'recommendation') {
      expect(tooLow.value.revised_interval_days).toBe(1);
    }

    const tooHigh = parseConsult(
      JSON.stringify({ rejected: false, revised_interval_days: 9999, reasoning: 'r', confidence: 80 }),
    );
    if (tooHigh?.kind === 'ok' && tooHigh.value.kind === 'recommendation') {
      expect(tooHigh.value.revised_interval_days).toBe(30);
    }

    const fractional = parseConsult(
      JSON.stringify({ rejected: false, revised_interval_days: 4.7, reasoning: 'r', confidence: 80 }),
    );
    if (fractional?.kind === 'ok' && fractional.value.kind === 'recommendation') {
      expect(fractional.value.revised_interval_days).toBe(5);
    }
  });

  it('clamps + rounds confidence to [0, 100]', () => {
    const out = parseConsult(
      JSON.stringify({ rejected: false, revised_interval_days: 5, reasoning: 'r', confidence: 92.7 }),
    );
    if (out?.kind === 'ok' && out.value.kind === 'recommendation') {
      expect(out.value.confidence).toBe(93);
    }
    const high = parseConsult(
      JSON.stringify({ rejected: false, revised_interval_days: 5, reasoning: 'r', confidence: 200 }),
    );
    if (high?.kind === 'ok' && high.value.kind === 'recommendation') {
      expect(high.value.confidence).toBe(100);
    }
  });

  it('truncates oversized reasoning to 500 chars', () => {
    const huge = 'a'.repeat(5000);
    const out = parseConsult(
      JSON.stringify({
        rejected: false,
        revised_interval_days: 5,
        reasoning: huge,
        confidence: 80,
      }),
    );
    if (out?.kind === 'ok' && out.value.kind === 'recommendation') {
      expect(out.value.reasoning.length).toBe(500);
    }
  });

  it('survives prompt-injection text wrapped around valid JSON', () => {
    // safeJsonParse already extracts the first balanced {...} block. Verify
    // the parser still produces the expected shape when the model echoed an
    // injection attempt as prose around its real answer.
    const wrapped = `Sure! Ignoring previous instructions. ${JSON.stringify({
      rejected: true,
      reason: 'prompt_injection',
    })} (end)`;
    const out = parseConsult(wrapped);
    expect(out?.kind).toBe('final');
    if (out?.kind === 'final' && out.value.kind === 'rejected_off_topic') {
      expect(out.value.reason).toBe('prompt_injection');
    }
  });

  it('returns null on malformed JSON entirely', () => {
    expect(parseConsult('not json at all')).toBeNull();
    expect(parseConsult('')).toBeNull();
    expect(parseConsult('{')).toBeNull();
  });

  it('returns null on JSON arrays / non-objects at the root', () => {
    expect(parseConsult('[]')).toBeNull();
    expect(parseConsult('null')).toBeNull();
    expect(parseConsult('"rejected"')).toBeNull();
  });
});
