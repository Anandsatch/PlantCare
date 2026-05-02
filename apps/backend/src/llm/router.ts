// Tiered LLM router for /api/identify (and structurally identical for
// /api/diagnose, /api/consult, /api/review which land later in E1).
//
// Decision tree:
//   1. callFree → strict JSON parse
//      - parse fail → escalate to paid (unless escalation gate refuses)
//      - parse ok + confidence >= 70 → return free result
//      - parse ok + confidence < 70 → escalate to paid (unless gate refuses)
//   2. paid result returned with source='paid_escalated'
//   3. on full failure: degraded { species_slug:'unknown', confidence:0,
//      source:'free_failed' } so callers always get a typed response.
//
// V1 scope lock: escalation gate is a no-op (always true). Per-device daily
// budget tracking is client-side in SQLite. The seam exists so we can wire
// KV in post-MVP without restructuring the router.

import type { IdentifyResponse, IdentifyAlternative } from '@plantcare/api-types';
import { SYSTEM_PROMPT_IDENTIFY } from './prompts';
import { callFree, callPaid, type CallResult } from './openrouter';
import { safeJsonParse } from './safe-json';

const CONFIDENCE_THRESHOLD = 70;

export type RouterDeps = {
  apiKey: string;
  callFree?: typeof callFree;
  callPaid?: typeof callPaid;
  // Returns true if a paid call is allowed. V1: always true. Hook for KV later.
  tryConsumeEscalation?: () => Promise<boolean>;
  // Caller's request abort signal. Threaded into both free + paid HTTP calls
  // so a disconnected client doesn't burn the full free+paid timeout budget.
  signal?: AbortSignal;
};

export type RouterInput = {
  imageDataUrl: string;
};

export async function identifyRouter(
  input: RouterInput,
  deps: RouterDeps,
): Promise<IdentifyResponse> {
  const free = (deps.callFree ?? callFree);
  const paid = (deps.callPaid ?? callPaid);
  const escalate = deps.tryConsumeEscalation ?? (async () => true);
  const signal = deps.signal;

  const start = Date.now();
  const freeRes = await free({
    apiKey: deps.apiKey,
    systemPrompt: SYSTEM_PROMPT_IDENTIFY,
    imageDataUrl: input.imageDataUrl,
    signal,
  });

  // Caller-aborted: skip escalation entirely (paid call would just burn
  // budget for a response no one will read).
  if (!freeRes.ok && freeRes.reason === 'aborted') {
    return freeFailedFallback(Date.now() - start);
  }

  // Free model errored or returned empty → try escalation
  if (!freeRes.ok) {
    return tryEscalate({
      paid,
      escalate,
      signal,
      apiKey: deps.apiKey,
      input,
      startedAt: start,
      freeLatency: freeRes.latency_ms,
    });
  }

  const parsed = parseIdentify(freeRes.content);
  if (!parsed) {
    return tryEscalate({
      paid,
      escalate,
      signal,
      apiKey: deps.apiKey,
      input,
      startedAt: start,
      freeLatency: freeRes.latency_ms,
    });
  }

  if (parsed.confidence < CONFIDENCE_THRESHOLD) {
    const escalated = await tryEscalate({
      paid,
      escalate,
      signal,
      apiKey: deps.apiKey,
      input,
      startedAt: start,
      freeLatency: freeRes.latency_ms,
      // If paid escalation also fails, we still have the (low-confidence)
      // free parse — return it instead of the unknown fallback.
      fallback: { ...parsed, source: 'free' as const, latency_ms: Date.now() - start },
    });
    return escalated;
  }

  return { ...parsed, source: 'free', latency_ms: Date.now() - start };
}

type EscalateArgs = {
  paid: typeof callPaid;
  escalate: () => Promise<boolean>;
  signal: AbortSignal | undefined;
  apiKey: string;
  input: RouterInput;
  startedAt: number;
  freeLatency: number;
  fallback?: IdentifyResponse;
};

async function tryEscalate(args: EscalateArgs): Promise<IdentifyResponse> {
  // If the caller already disconnected, don't even ask the budget gate —
  // paying for a response no one reads is the worst outcome.
  if (args.signal?.aborted) {
    return args.fallback ?? freeFailedFallback(Date.now() - args.startedAt);
  }
  const allowed = await args.escalate();
  if (!allowed) {
    return args.fallback ?? freeFailedFallback(Date.now() - args.startedAt);
  }
  const paidRes = await args.paid({
    apiKey: args.apiKey,
    systemPrompt: SYSTEM_PROMPT_IDENTIFY,
    imageDataUrl: args.input.imageDataUrl,
    signal: args.signal,
  });
  if (!paidRes.ok) {
    return args.fallback ?? freeFailedFallback(Date.now() - args.startedAt);
  }
  const parsed = parseIdentify(paidRes.content);
  if (!parsed) {
    return args.fallback ?? freeFailedFallback(Date.now() - args.startedAt);
  }
  return { ...parsed, source: 'paid_escalated', latency_ms: Date.now() - args.startedAt };
}

function freeFailedFallback(latency_ms: number): IdentifyResponse {
  return {
    species_slug: 'unknown',
    species_label: 'Unknown',
    confidence: 0,
    alternatives: [],
    source: 'free_failed',
    latency_ms,
  };
}

// Validate + coerce a model JSON blob into the IdentifyResponse shape minus
// `source` and `latency_ms` (the router fills those). Rejects anything that
// doesn't have the required fields with the right primitive types.
type ParsedIdentify = Omit<IdentifyResponse, 'source' | 'latency_ms'>;

export function parseIdentify(raw: string): ParsedIdentify | null {
  const obj = safeJsonParse<Record<string, unknown>>(raw);
  if (!obj || typeof obj !== 'object') return null;

  const slug = obj.species_slug;
  const label = obj.species_label ?? obj.species_slug; // tolerate missing label
  const conf = obj.confidence;

  if (typeof slug !== 'string' || !slug) return null;
  if (typeof conf !== 'number' || !Number.isFinite(conf)) return null;
  if (typeof label !== 'string') return null;

  const confidence = clamp(Math.round(conf), 0, 100);

  // Cap with early-exit so a hostile model returning 100k alternatives doesn't
  // force us to validate every one before slicing.
  const alternatives: IdentifyAlternative[] = [];
  const MAX_ALTERNATIVES = 5;
  if (Array.isArray(obj.alternatives)) {
    for (const a of obj.alternatives) {
      if (alternatives.length >= MAX_ALTERNATIVES) break;
      if (!a || typeof a !== 'object') continue;
      const alt = a as Record<string, unknown>;
      if (typeof alt.species_slug !== 'string' || !alt.species_slug) continue;
      if (typeof alt.confidence !== 'number' || !Number.isFinite(alt.confidence)) continue;
      const altLabel =
        typeof alt.species_label === 'string' ? alt.species_label : alt.species_slug;
      alternatives.push({
        species_slug: alt.species_slug,
        species_label: altLabel,
        confidence: clamp(Math.round(alt.confidence), 0, 100),
      });
    }
  }

  return {
    species_slug: slug,
    species_label: label,
    confidence,
    alternatives,
  };
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}
