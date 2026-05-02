// Shared types between mobile and backend.
// Endpoint shapes are added in E1 (identify), E5 (diagnose), E8 (consult), E9 (review).

export type ApiResult<T> =
  | { ok: true; kind: 'success'; data: T }
  | { ok: false; kind: 'error'; message: string }
  | { ok: false; kind: 'rate_limited'; retry_after_seconds: number }
  | { ok: false; kind: 'queued'; queue_id: string }
  | { ok: false; kind: 'rejected_off_topic'; message: string };
