// Tiered LLM router shared across /api/identify, /api/diagnose, and (later)
// /api/consult and /api/review. The state machine is endpoint-agnostic;
// `createLlmRouter` parameterizes it on a system prompt + parser + fallback.
//
// Decision tree (per call):
//   1. callFree → strict-ish JSON parse
//      - parse fail → escalate to paid (unless escalation gate refuses)
//      - parse ok + confidence >= 70 → return free result
//      - parse ok + confidence < 70 → escalate to paid; if paid also fails,
//        return the low-confidence free parse (source='free') rather than
//        the degraded unknown fallback.
//   2. paid result returned with source='paid_escalated'.
//   3. on full failure: degraded fallback with source='free_failed' so
//      callers always get a typed response.
//
// V1 scope lock: escalation gate is a no-op (always true). Per-device daily
// budget tracking is client-side in SQLite. The seam exists so we can wire
// KV in post-MVP without restructuring the router.

import type {
  IdentifyResponse,
  IdentifyAlternative,
  DiagnoseResponse,
  DiagnoseAlternative,
  DiagnoseSeverity,
} from '@plantcare/api-types';
import { SYSTEM_PROMPT_IDENTIFY, SYSTEM_PROMPT_DIAGNOSE } from './prompts';
import { callFree, callPaid } from './openrouter';
import { safeJsonParse } from './safe-json';

const CONFIDENCE_THRESHOLD = 70;
const MAX_ALTERNATIVES = 5;
const MAX_FIX_STEPS = 8;

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

// Every parsed body must expose `confidence` so the threshold check is
// universal across endpoints.
type WithConfidence = { confidence: number };

type RouterSource = 'free' | 'paid_escalated' | 'free_failed';
type RouterFinal<T extends WithConfidence> = T & { source: RouterSource; latency_ms: number };

type RouterFactoryConfig<T extends WithConfidence> = {
  systemPrompt: string;
  parse: (raw: string) => T | null;
  // Degraded fallback minus source + latency_ms (the router fills those).
  fallback: () => T;
};

export function createLlmRouter<T extends WithConfidence>(
  config: RouterFactoryConfig<T>,
): (input: RouterInput, deps: RouterDeps) => Promise<RouterFinal<T>> {
  return async (input, deps) => {
    const free = deps.callFree ?? callFree;
    const paid = deps.callPaid ?? callPaid;
    const escalate = deps.tryConsumeEscalation ?? (async () => true);
    const signal = deps.signal;
    const start = Date.now();

    const freeRes = await free({
      apiKey: deps.apiKey,
      systemPrompt: config.systemPrompt,
      imageDataUrl: input.imageDataUrl,
      signal,
    });

    // Caller-aborted: skip escalation entirely (paid call would just burn
    // budget for a response no one will read).
    if (!freeRes.ok && freeRes.reason === 'aborted') {
      return failedFallback(config, start);
    }

    if (!freeRes.ok) {
      return tryEscalate(config, { paid, escalate, signal, apiKey: deps.apiKey, input, start });
    }

    const parsed = config.parse(freeRes.content);
    if (!parsed) {
      return tryEscalate(config, { paid, escalate, signal, apiKey: deps.apiKey, input, start });
    }

    if (parsed.confidence < CONFIDENCE_THRESHOLD) {
      // Capture the low-conf parse as the fallback we'd want if paid also
      // fails. Latency snapshotted now so the returned shape reflects the
      // free-only wait — preserved from pre-factory router.
      const lowConfFallback: RouterFinal<T> = {
        ...parsed,
        source: 'free',
        latency_ms: Date.now() - start,
      };
      return tryEscalate(
        config,
        { paid, escalate, signal, apiKey: deps.apiKey, input, start },
        lowConfFallback,
      );
    }

    return { ...parsed, source: 'free', latency_ms: Date.now() - start };
  };
}

type EscalateArgs = {
  paid: typeof callPaid;
  escalate: () => Promise<boolean>;
  signal: AbortSignal | undefined;
  apiKey: string;
  input: RouterInput;
  start: number;
};

async function tryEscalate<T extends WithConfidence>(
  config: RouterFactoryConfig<T>,
  args: EscalateArgs,
  lowConfFallback?: RouterFinal<T>,
): Promise<RouterFinal<T>> {
  const onFail = (): RouterFinal<T> =>
    lowConfFallback ?? failedFallback(config, args.start);

  // If the caller already disconnected, don't even ask the budget gate —
  // paying for a response no one reads is the worst outcome.
  if (args.signal?.aborted) return onFail();
  const allowed = await args.escalate();
  if (!allowed) return onFail();

  const paidRes = await args.paid({
    apiKey: args.apiKey,
    systemPrompt: config.systemPrompt,
    imageDataUrl: args.input.imageDataUrl,
    signal: args.signal,
  });
  if (!paidRes.ok) return onFail();
  const parsed = config.parse(paidRes.content);
  if (!parsed) return onFail();
  return { ...parsed, source: 'paid_escalated', latency_ms: Date.now() - args.start };
}

function failedFallback<T extends WithConfidence>(
  config: RouterFactoryConfig<T>,
  start: number,
): RouterFinal<T> {
  return { ...config.fallback(), source: 'free_failed', latency_ms: Date.now() - start };
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

// ─── /api/identify ───────────────────────────────────────────────────────

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

export const identifyRouter = createLlmRouter<ParsedIdentify>({
  systemPrompt: SYSTEM_PROMPT_IDENTIFY,
  parse: parseIdentify,
  fallback: () => ({
    species_slug: 'unknown',
    species_label: 'Unknown',
    confidence: 0,
    alternatives: [],
  }),
});

// ─── /api/diagnose ───────────────────────────────────────────────────────

type ParsedDiagnose = Omit<DiagnoseResponse, 'source' | 'latency_ms'>;

// Severity drift handling — Option C from the E1-002 design discussion:
// tolerate common synonyms / casing, default to 'medium' (NOT 'low') on
// garbage so we don't silently downgrade serious diagnoses. See PV1-001
// in WORKBACK.md for the planned post-V1 verifier-model upgrade.
const SEVERITY_SYNONYMS: Record<string, DiagnoseSeverity> = {
  low: 'low',
  mild: 'low',
  minor: 'low',
  medium: 'medium',
  moderate: 'medium',
  mod: 'medium',
  high: 'high',
  severe: 'high',
  critical: 'high',
};

function normalizeSeverity(raw: unknown): DiagnoseSeverity {
  if (typeof raw !== 'string') return 'medium';
  // Extract the first run of ASCII letters, regardless of surrounding
  // punctuation or whitespace. Robust against drift like "severe,",
  // "(severe)", "high — likely fatal", "...severe...". ASCII-only by
  // design: the system prompt instructs English-only output, so accented
  // forms ("sévère") fall through to the 'medium' default.
  const head = raw.toLowerCase().match(/^[^a-z]*([a-z]+)/)?.[1];
  if (!head) return 'medium';
  return SEVERITY_SYNONYMS[head] ?? 'medium';
}

export function parseDiagnose(raw: string): ParsedDiagnose | null {
  const obj = safeJsonParse<Record<string, unknown>>(raw);
  if (!obj || typeof obj !== 'object') return null;

  const slug = obj.disease_slug;
  const label = obj.disease_label ?? obj.disease_slug;
  const conf = obj.confidence;

  if (typeof slug !== 'string' || !slug) return null;
  if (typeof conf !== 'number' || !Number.isFinite(conf)) return null;
  if (typeof label !== 'string') return null;

  const confidence = clamp(Math.round(conf), 0, 100);
  const severity = normalizeSeverity(obj.severity);

  const fix_steps: string[] = [];
  if (Array.isArray(obj.fix_steps)) {
    for (const step of obj.fix_steps) {
      if (fix_steps.length >= MAX_FIX_STEPS) break;
      if (typeof step !== 'string') continue;
      const trimmed = step.trim();
      if (!trimmed) continue;
      fix_steps.push(trimmed);
    }
  }

  const alternatives: DiagnoseAlternative[] = [];
  if (Array.isArray(obj.alternatives)) {
    for (const a of obj.alternatives) {
      if (alternatives.length >= MAX_ALTERNATIVES) break;
      if (!a || typeof a !== 'object') continue;
      const alt = a as Record<string, unknown>;
      if (typeof alt.disease_slug !== 'string' || !alt.disease_slug) continue;
      if (typeof alt.confidence !== 'number' || !Number.isFinite(alt.confidence)) continue;
      const altLabel =
        typeof alt.disease_label === 'string' ? alt.disease_label : alt.disease_slug;
      alternatives.push({
        disease_slug: alt.disease_slug,
        disease_label: altLabel,
        confidence: clamp(Math.round(alt.confidence), 0, 100),
      });
    }
  }

  return {
    disease_slug: slug,
    disease_label: label,
    confidence,
    severity,
    fix_steps,
    alternatives,
  };
}

export const diagnoseRouter = createLlmRouter<ParsedDiagnose>({
  systemPrompt: SYSTEM_PROMPT_DIAGNOSE,
  parse: parseDiagnose,
  fallback: () => ({
    disease_slug: 'unknown',
    disease_label: 'Unknown',
    confidence: 0,
    // 'medium' (not 'low') matches the same anti-silent-downgrade rule as
    // normalizeSeverity: when we have no information, don't bias the user
    // toward complacency. Free_failed surfaces an "I'm not sure" UI where
    // the badge is typically hidden, but if anything reads severity it
    // should reflect uncertainty, not low urgency.
    severity: 'medium',
    fix_steps: [],
    alternatives: [],
  }),
});
