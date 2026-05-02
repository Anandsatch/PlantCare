// Shared types between mobile and backend.
// Endpoint shapes are added in E1 (identify), E5 (diagnose), E8 (consult), E9 (review).

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
