// Shared types between mobile and backend.
// Endpoint shapes: E1-001 added identify; E1-002 added diagnose; E1-003 added
// consult; E1-004 adds review.

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

// ─── /api/review (E1-004) ────────────────────────────────────────────────
// Text-only endpoint. Mobile computes a 7-day summary locally from SQLite
// (plant counts, watering events, skip events, diagnoses) and posts it; the
// server returns the editorial voice for the A-6 weekly review screen — a
// short Fraunces headline plus a one-paragraph narrative. Per-plant ledgers
// in A-6 render from local data; the server does NOT echo plant rows back.
//
// Why no off-topic rejection arm (unlike consult): the user can't inject
// text into review. It fires from an in-app button on data the app owns,
// so the parser is asOk-shaped and parses the same response shape always.
export type ReviewSource = IdentifySource;

// One observation line per plant the user submitted, in the same order they
// were sent. Mobile renders these alongside each plant's local ledger in A-6.
// Empty array is valid (zero plants in the request → zero observations).
export type ReviewPlantObservation = {
  species_slug: string;
  observation: string; // ≤ 200 chars after trim
};

export type ReviewResponse = {
  headline: string; // ≤ 80 chars after trim
  narrative: string; // ≤ 400 chars after trim — test plan spec is 100-400
  per_plant: ReviewPlantObservation[]; // 0..50, paired with request.plants
  confidence: number; // 0-100
  source: ReviewSource;
  latency_ms: number;
};

// Per-plant row in the request. nickname optional (a freshly-added plant
// may not have one yet); counts are non-negative integers, ≤ 30.
export type ReviewPlantSummary = {
  species_slug: string;
  nickname?: string;
  watering_count: number; // 0..30
  skip_count: number; // 0..30
  had_diagnosis: boolean;
};

// Mobile request body for POST /api/review. plants is capped at 50 entries
// — V1 doesn't have multi-garden users; 50 is a generous ceiling that bounds
// the prompt length. Counts in week_summary are 0..300 to allow several
// plants to contribute, still bounded so a hostile body can't blow up the
// prompt token count.
export type ReviewRequestBody = {
  week_summary: {
    plants_total: number; // 0..50
    watering_events: number; // 0..300
    skip_events: number; // 0..300
    diagnoses: number; // 0..50
  };
  plants: ReviewPlantSummary[]; // 0..50
};
