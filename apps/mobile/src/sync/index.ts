/**
 * `apps/mobile/src/sync/` — offline-mode persistence layer.
 *
 * E7-001 (this) ships the sync_queue CRUD module. Future tickets:
 *   - E7-002: SyncDrainer that consumes selectReadyForRetry / scheduleBackoff
 * E7-001 ships the sync_queue CRUD module. E7-002 (this) ships the
 * SyncDrainer that consumes the CRUD's typed mutators. Future tickets:
 *   - E7-003: NetInfo + AppState listeners that trigger the drainer
 *   - E7-004: wires the LLM hooks (diagnose / consult / identify) to enqueue
 *   - E7-005..006: the toast-banner + retry surfaces
 */
export {
  BACKOFF_SCHEDULE_MS,
  MAX_ATTEMPTS,
  TTL_MS,
<<<<<<< HEAD
=======
  claimInFlight,
>>>>>>> origin/Anandsatch/e7-sync-drainer
  enqueueRequest,
  markDone,
  markFailedTerminal,
  markInFlight,
  scheduleBackoff,
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
  type ScheduleBackoffInput,
  type ScheduleBackoffResult,
  type SelectReadyInput,
  type SweepStaleInput,
  type SweepStaleResult,
} from './queueCrud';
<<<<<<< HEAD
  useNetworkActivity,
  type NetworkActivitySnapshot,
  type NetworkStatus,
  type UseNetworkActivityConfig,
} from './useNetworkActivity';
=======

export {
  DRAIN_BATCH_LIMIT,
  STUCK_IN_FLIGHT_THRESHOLD_MS,
  createSyncDrainer,
  type DrainSummary,
  type StartupSweepSummary,
  type SyncDrainer,
  type SyncDrainerConfig,
} from './SyncDrainer';
>>>>>>> origin/Anandsatch/e7-sync-drainer
