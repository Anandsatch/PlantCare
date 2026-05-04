// Tiered LLM router shared across /api/identify, /api/diagnose, /api/consult,
// and (later) /api/review. The state machine is endpoint-agnostic;
// `createLlmRouter` parameterizes it on a system prompt + parser + fallback.
//
// Decision tree (per call):
//   1. callFree → strict-ish JSON parse via config.parse
//      - parse returns null → escalate to paid (unless escalation gate refuses)
//      - parse returns {kind:'final', value} → return value immediately. The
//        free model gave a confident structural answer that bypasses the
//        confidence gate — used by consult for off-topic rejection. Paying
//        for a paid call would be wasted: rejection is a deterministic
//        category, not a confidence problem.
//      - parse returns {kind:'ok', value} + value.confidence >= 70 → return
//      - parse returns {kind:'ok', value} + value.confidence < 70 → escalate
//        to paid; if paid also fails, return the low-confidence free parse
//        (source='free') rather than the degraded fallback.
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
  ConsultRecommendation,
  ConsultRejection,
} from '@plantcare/api-types';
import { SYSTEM_PROMPT_IDENTIFY, SYSTEM_PROMPT_DIAGNOSE, SYSTEM_PROMPT_CONSULT } from './prompts';
import { callFree, callPaid, type CallArgs } from './openrouter';
import { safeJsonParse } from './safe-json';

const CONFIDENCE_THRESHOLD = 70;
const MAX_ALTERNATIVES = 5;
const MAX_FIX_STEPS = 8;
const MAX_REASONING_LEN = 500;
const MAX_REJECTION_REASON_LEN = 200;
const MIN_INTERVAL_DAYS = 1;
const MAX_INTERVAL_DAYS = 30;

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

// E1-003 widened RouterInput to a discriminated union. Vision callers stay as
// 'vision' + imageDataUrl; text callers (consult, review) compose a single
// userMessage string from the request body before invoking the router.
export type RouterInput =
  | { kind: 'vision'; imageDataUrl: string }
  | { kind: 'text'; userMessage: string };

// Parser return contract:
//   - null         → escalate (parse fail / shape mismatch)
//   - {kind:'ok'}  → subject to the confidence gate; .value must have a
//                    numeric .confidence field at runtime.
//   - {kind:'final'} → bypass the gate, return immediately. T need not have
//                    a confidence field on the final branch (e.g. the consult
//                    rejection arm).
export type ParseResult<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'final'; value: T };

type RouterSource = 'free' | 'paid_escalated' | 'free_failed';
type RouterFinal<T> = T & { source: RouterSource; latency_ms: number };

type RouterFactoryConfig<T> = {
  systemPrompt: string;
  parse: (raw: string) => ParseResult<T> | null;
  // Degraded fallback minus source + latency_ms (the router fills those).
  fallback: () => T;
};

export function createLlmRouter<T>(
  config: RouterFactoryConfig<T>,
): (input: RouterInput, deps: RouterDeps) => Promise<RouterFinal<T>> {
  return async (input, deps) => {
    const free = deps.callFree ?? callFree;
    const paid = deps.callPaid ?? callPaid;
    const escalate = deps.tryConsumeEscalation ?? (async () => true);
    const signal = deps.signal;
    const start = Date.now();

    const freeRes = await free(toCallArgs(input, deps.apiKey, config.systemPrompt, signal));

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

    if (parsed.kind === 'final') {
      // Confident structural answer (e.g. off-topic rejection). Don't escalate.
      return { ...parsed.value, source: 'free', latency_ms: Date.now() - start };
    }

    const conf = readConfidence(parsed.value);
    if (conf < CONFIDENCE_THRESHOLD) {
      // Capture the low-conf parse as the fallback we'd want if paid also
      // fails. Latency snapshotted now so the returned shape reflects the
      // free-only wait — preserved from pre-factory router.
      const lowConfFallback: RouterFinal<T> = {
        ...parsed.value,
        source: 'free',
        latency_ms: Date.now() - start,
      };
      return tryEscalate(
        config,
        { paid, escalate, signal, apiKey: deps.apiKey, input, start },
        lowConfFallback,
      );
    }

    return { ...parsed.value, source: 'free', latency_ms: Date.now() - start };
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

async function tryEscalate<T>(
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

  const paidRes = await args.paid(
    toCallArgs(args.input, args.apiKey, config.systemPrompt, args.signal),
  );
  if (!paidRes.ok) return onFail();
  const parsed = config.parse(paidRes.content);
  if (!parsed) return onFail();
  // Both 'ok' and 'final' parse results return here as 'paid_escalated'. The
  // confidence gate does NOT re-apply on the paid path: paying twice for a
  // single user request is the worst possible outcome, and the paid model is
  // the final arbiter regardless of confidence. A 'final' result (e.g. paid
  // returning a rejection) is also terminal and rides the same return.
  return { ...parsed.value, source: 'paid_escalated', latency_ms: Date.now() - args.start };
}

function failedFallback<T>(
  config: RouterFactoryConfig<T>,
  start: number,
): RouterFinal<T> {
  return { ...config.fallback(), source: 'free_failed', latency_ms: Date.now() - start };
}

function toCallArgs(
  input: RouterInput,
  apiKey: string,
  systemPrompt: string,
  signal: AbortSignal | undefined,
): CallArgs {
  // Build CallArgs explicitly per discriminator so TS narrows correctly and a
  // future arm doesn't silently degrade to one of the existing shapes.
  if (input.kind === 'vision') {
    return { kind: 'vision', apiKey, systemPrompt, signal, imageDataUrl: input.imageDataUrl };
  }
  return { kind: 'text', apiKey, systemPrompt, signal, userMessage: input.userMessage };
}

// Defensive read: 'ok' branch values MUST have a numeric confidence per the
// parser contract, but a buggy parser could violate it. Treat missing/non-
// numeric confidence as 0 so the gate escalates rather than silently passing
// a malformed parse through to the caller.
function readConfidence(value: unknown): number {
  if (
    !value ||
    typeof value !== 'object' ||
    !('confidence' in value) ||
    typeof (value as { confidence: unknown }).confidence !== 'number' ||
    !Number.isFinite((value as { confidence: number }).confidence)
  ) {
    return 0;
  }
  return (value as { confidence: number }).confidence;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

// Adapt a "shape-only" parser (raw → T | null) into the factory's
// {kind:'ok', value} | null contract. Used by identify and diagnose, which
// have no terminal/final path.
function asOk<T>(parse: (raw: string) => T | null): (raw: string) => ParseResult<T> | null {
  return (raw) => {
    const v = parse(raw);
    return v === null ? null : { kind: 'ok', value: v };
  };
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
  parse: asOk(parseIdentify),
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
  parse: asOk(parseDiagnose),
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

// ─── /api/consult ────────────────────────────────────────────────────────

type ParsedConsultRecommendation = Omit<ConsultRecommendation, 'source' | 'latency_ms'>;
type ParsedConsultRejection = Omit<ConsultRejection, 'source' | 'latency_ms'>;
export type ParsedConsult = ParsedConsultRecommendation | ParsedConsultRejection;

// parseConsult is the first parser to use the factory's {kind:'ok'|'final'}
// contract. Rejection is 'final' (don't escalate); recommendation is 'ok'
// (subject to the confidence gate). null means "shape mismatch, escalate" —
// e.g. malformed JSON, missing 'rejected' discriminator, or a recommendation
// with non-numeric revised_interval_days.
//
// The 'rejected' boolean discriminator wins over any other keys present.
// Hostile inputs ("rejected: true, revised_interval_days: 1...") still route
// to the rejection arm.
export function parseConsult(raw: string): ParseResult<ParsedConsult> | null {
  const obj = safeJsonParse<Record<string, unknown>>(raw);
  if (!obj || typeof obj !== 'object') return null;

  // Require explicit 'rejected' boolean. Models that omit it haven't followed
  // the contract — escalate.
  if (typeof obj.rejected !== 'boolean') return null;

  if (obj.rejected === true) {
    // Default reason if missing/empty so the rejection path always has a
    // value to display. Truncate to bound UI text length.
    const rawReason = typeof obj.reason === 'string' ? obj.reason.trim() : '';
    const reason = (rawReason || 'off_topic').slice(0, MAX_REJECTION_REASON_LEN);
    return { kind: 'final', value: { kind: 'rejected_off_topic', reason } };
  }

  // Recommendation arm. All three fields required + numeric/non-empty.
  const days = obj.revised_interval_days;
  const reasoning = obj.reasoning;
  const conf = obj.confidence;
  if (typeof days !== 'number' || !Number.isFinite(days)) return null;
  if (typeof reasoning !== 'string' || !reasoning.trim()) return null;
  if (typeof conf !== 'number' || !Number.isFinite(conf)) return null;

  return {
    kind: 'ok',
    value: {
      kind: 'recommendation',
      revised_interval_days: clamp(Math.round(days), MIN_INTERVAL_DAYS, MAX_INTERVAL_DAYS),
      reasoning: reasoning.trim().slice(0, MAX_REASONING_LEN),
      confidence: clamp(Math.round(conf), 0, 100),
    },
  };
}

export const consultRouter = createLlmRouter<ParsedConsult>({
  systemPrompt: SYSTEM_PROMPT_CONSULT,
  parse: parseConsult,
  // Degraded fallback: surface as a recommendation with confidence=0 so the
  // mobile UI's "I'm not sure" path lights up the same way it does for
  // identify/diagnose free_failed. The reasoning string is the user-visible
  // copy. interval_days=7 is a safe houseplant default — never used unless
  // the UI ignores confidence (which it shouldn't).
  fallback: (): ParsedConsult => ({
    kind: 'recommendation',
    revised_interval_days: 7,
    reasoning: "I couldn't get a recommendation right now. Try again in a moment.",
    confidence: 0,
  }),
});
