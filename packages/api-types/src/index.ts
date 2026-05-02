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
