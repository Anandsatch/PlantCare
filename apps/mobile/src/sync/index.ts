/**
 * `apps/mobile/src/sync/` — offline-mode persistence layer.
 *
 * E7-001 ships the sync_queue CRUD module. E7-002 ships the SyncDrainer
 * that consumes the CRUD's typed mutators. E7-003 ships the unified
 * NetInfo + AppState listener. E7-006 ships the tap-to-retry surface
 * (resetForRetry CRUD + useFailedQueue + QueueRetryBanner). Future:
 *   - E7-004: wires the LLM hooks (diagnose / consult / identify) to enqueue
 *   - E7-005: toast-banner pending surface (already shipped via E7-005 PR)
 */
export {
  BACKOFF_SCHEDULE_MS,
  MAX_ATTEMPTS,
  TTL_MS,
  claimInFlight,
  enqueueRequest,
  markDone,
  markFailedTerminal,
  markInFlight,
  resetForRetry,
  scheduleBackoff,
  selectFailedRows,
  selectReadyForRetry,
  sweepStaleEntries,
  type DedupeKey,
  type EnqueueRequestInput,
  type EnqueueResult,
  type QueueBindValue,
  type QueueExecutor,
  type QueueKind,
  type QueueRow,
  type QueueStatus,
  type ResetForRetryInput,
  type ResetForRetryResult,
  type ScheduleBackoffInput,
  type ScheduleBackoffResult,
  type SelectReadyInput,
  type SweepStaleInput,
  type SweepStaleResult,
} from './queueCrud';

export {
  useNetworkActivity,
  type NetworkActivitySnapshot,
  type NetworkStatus,
  type UseNetworkActivityConfig,
} from './useNetworkActivity';

export {
  DRAIN_BATCH_LIMIT,
  STUCK_IN_FLIGHT_THRESHOLD_MS,
  createSyncDrainer,
  type DrainSummary,
  type StartupSweepSummary,
  type SyncDrainer,
  type SyncDrainerConfig,
} from './SyncDrainer';

export {
  useFailedQueue,
  type FailedRow,
  type UseFailedQueueConfig,
  type UseFailedQueueReturn,
  type UseFailedQueueStatus,
} from './useFailedQueue';
