// Shared types between mobile and backend.
// Endpoint shapes: E1-001 added identify; E1-002 added diagnose; E1-003 adds
// consult. Review lands in E1-004.

// Note on `ok` semantics: `ok: true` means "the request was accepted and the
// caller does NOT need to retry." `queued` is `ok: true` because the work was
// successfully accepted for async processing — naive `if (!result.ok) retry`
// callers would otherwise duplicate queued jobs. `rate_limited` and
// `rejected_off_topic` are `ok: false` because the request was NOT accepted.
export type ApiResult<T> =
  | { ok: true; kind: 'success'; data: T }
  | { ok: true; kind: 'queued'; queue_id: string }
  | { ok: false; kind: 'error'; message: string }
  | { ok: false; kind: 'rate_limited'; retry_after_seconds: number }
  | { ok: false; kind: 'rejected_off_topic'; message: string };

// ─── /api/identify (E1) ──────────────────────────────────────────────────
// Source = which model produced the response.
//   'free'           — free model parsed cleanly with confidence >= 70.
//   'paid_escalated' — paid model returned a usable parse after free was
//                      unavailable, unparseable, or low-confidence.
//   'free_failed'    — degraded fallback (species_slug='unknown', confidence=0).
//                      Returned whenever the router could not produce a usable
//                      model result: free + paid HTTP errors, free unparseable
//                      AND paid unparseable, free unparseable AND escalation
//                      gate refused, or caller aborted before any model
//                      replied. Mobile callers MUST check this discriminator
//                      to render the A-3 "I'm not sure" UI rather than a
//                      confident identification.
export type IdentifySource = 'free' | 'paid_escalated' | 'free_failed';

export type IdentifyAlternative = {
  species_slug: string;
  species_label: string;
  confidence: number; // 0-100
};

export type IdentifyResponse = {
  species_slug: string; // snake_case, or 'unknown'
  species_label: string;
  confidence: number; // 0-100
  alternatives: IdentifyAlternative[];
  source: IdentifySource;
  latency_ms: number;
};

// ─── /api/diagnose (E1-002) ──────────────────────────────────────────────
// Same router contract as identify — `source` discriminator is identical.
// Healthy plant convention: disease_slug='healthy', severity='low', fix_steps=[].
// Cannot tell convention: disease_slug='unknown', confidence<30 (mirrors identify).
export type DiagnoseSource = IdentifySource;

// Severity drives the A-3 result UI badge tone (low=cream, medium=tan,
// high=warning). Default coercion is 'medium' when the model returns garbage,
// not 'low' — defaulting low would silently downgrade serious problems. See
// PV1-001 in WORKBACK.md for the post-V1 verifier-model followup.
export type DiagnoseSeverity = 'low' | 'medium' | 'high';

export type DiagnoseAlternative = {
  disease_slug: string;
  disease_label: string;
  confidence: number; // 0-100
};

export type DiagnoseResponse = {
  disease_slug: string; // snake_case, or 'healthy', or 'unknown'
  disease_label: string;
  confidence: number; // 0-100
  severity: DiagnoseSeverity;
  fix_steps: string[]; // 0..8 short imperative bullets
  alternatives: DiagnoseAlternative[];
  source: DiagnoseSource;
  latency_ms: number;
};

// ─── /api/consult (E1-003) ──────────────────────────────────────────────
// Text-only endpoint: user note + plant context → revised watering rec, OR
// a structural off-topic rejection. Same router contract as identify/diagnose
// (free → paid escalation, same source discriminator), but introduces a
// second valid response shape.
//
// Why two arms in ConsultResponse rather than only the wire-level
// ApiResult.rejected_off_topic: the parser sees the fork before the route
// handler does, the router has to know not to escalate a rejection (it's a
// confident answer, not a low-confidence one), and the eval suite (E1-005)
// needs the structural shape to assert against. The route handler maps
// kind:'rejected_off_topic' to ApiResult.rejected_off_topic at the boundary.
export type ConsultSource = IdentifySource;

export type ConsultRecommendation = {
  kind: 'recommendation';
  revised_interval_days: number; // clamped to [1, 30]
  reasoning: string; // ≤ 500 chars after trim
  confidence: number; // 0-100
  source: ConsultSource;
  latency_ms: number;
};

export type ConsultRejection = {
  kind: 'rejected_off_topic';
  reason: string; // ≤ 200 chars after trim
  source: ConsultSource;
  latency_ms: number;
};

export type ConsultResponse = ConsultRecommendation | ConsultRejection;

// Mobile request body for POST /api/consult.
// note: 1-2000 chars after trim; plant_context optional.
export type ConsultRequestBody = {
  note: string;
  plant_context?: {
    species_slug?: string;
    is_indoor?: boolean;
    override_interval_days?: number | null;
    watering_history?: { day_offset: number; watered: boolean }[]; // ≤ 7 entries
  };
};
