/**
 * useConsultRequest — the add-note hook that talks to /api/consult.
 *
 * Parallel hook to `useDiagnoseRequest` (E5-006). Same shape, same state
 * machine, same race / unmount / coercion semantics. The two hooks are NOT
 * collapsed into a generic `useApiRequest<T>` because the input shapes
 * differ meaningfully (image URI vs free-text note + plant context), and
 * because keeping them parallel makes the call sites self-documenting.
 *
 * Surface (master plan, line 423 — same as useDiagnoseRequest):
 *   const { consult, status, lastResult } = useConsultRequest({ apiClient });
 *   const result = await consult({ note, plantContext });
 *   if (result.ok) {
 *     // result.data is ConsultRecommendation | ConsultRejection
 *     if (result.data.kind === 'recommendation') { render reasoning }
 *     else { render off-topic reject }   // see "two off-topic paths" below
 *   } else switch (result.kind) { ... }
 *
 * The discriminated union surfaced to AddNoteSheet covers every locked
 * client kind without collapsing them:
 *
 *   ok: true   → ConsultRecommendation (.data.kind = 'recommendation')
 *   ok: true   → ConsultRejection      (.data.kind = 'rejected_off_topic')
 *                                       — this path is rare; see below.
 *   layer1_reject → off-topic via the wire's `rejected_off_topic` body shape
 *                   (the api client maps wire `rejected_off_topic` → client
 *                   `layer1_reject` per its mapBackendErrorBody contract).
 *                   This is the COMMON off-topic path — every off-topic
 *                   reject the consult route returns lands here.
 *   network    → coerced to queued (offline / DNS / TLS / captive-portal)
 *   timeout    → not coerced; user retries
 *   server     → 5xx / 429
 *   parse_error → backend out of sync with mobile
 *   queued     → offline (netInfo says false) OR network coerced
 *   low_confidence → reserved for future server-side gate (not emitted today)
 *
 * Two off-topic paths — why both exist:
 *   The backend's `ConsultResponse` is a discriminated union (recommendation
 *   | rejected_off_topic) so the LLM router and the eval suite see the fork
 *   structurally. The route handler converts a *router-side* off-topic
 *   decision into the wire-level `{ ok: false, kind: 'rejected_off_topic' }`
 *   error envelope (status 200), which the api client maps to
 *   `layer1_reject`. So in practice today, off-topic reaches us as
 *   `layer1_reject`. The `data.kind === 'rejected_off_topic'` arm of
 *   `ConsultResponse` exists for forward-compat — if a future backend
 *   change emits a successful response carrying a rejection structure,
 *   AddNoteSheet still handles it without code changes.
 *
 * Network → queued coercion:
 *   Same rationale and mechanism as useDiagnoseRequest. See its module
 *   header for the full reasoning; we maintain identical semantics here so
 *   AddNoteSheet's offline UX matches the camera flow's (the tan banner).
 *   `timeout` is NOT coerced — same intent split as diagnose: timeout =
 *   "request reached the lab and we waited too long" (retry now); network =
 *   "couldn't even reach the lab" (queue + drain on reconnect).
 *
 * V1 scope locks honored:
 *   - No sync_queue persistence in this hook. E7-001..E7-004 own that
 *     layer; the queued path is a placeholder return value that lets
 *     AddNoteSheet ship today and lets E7 wire real persistence later
 *     without changing this hook's external contract.
 *   - No @react-native-community/netinfo. Injectable `netInfo` with an
 *     "always online" default; E7-003 swaps in the real subscription via
 *     the same prop.
 *   - No react-query / swr. The consult flow is one-shot per Save & analyze
 *     tap, not a long-lived cache.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import type {
  ApiClient,
  ApiResult,
  ConsultRequest,
  ConsultResponse,
} from '../api';
import {
  hashStable,
  safeEnqueue,
  type OfflineQueueConfig,
} from './offlineEnqueue';
import type { NetInfoLike } from './useDiagnoseRequest';

const DEFAULT_NET_INFO: NetInfoLike = {
  isConnected: () => true,
};

/**
 * Plant context attached to a consult request. Matches the wire shape
 * (`ConsultRequestBody['plant_context']`) so the hook is a thin pass-through;
 * the api client / route handler already enforce field-level validation.
 *
 * Defined locally as an alias rather than re-exporting the wire type so
 * AddNoteSheet's call site reads as PlantContext, not as a deeply-nested
 * indexed type.
 */
export type ConsultPlantContext = NonNullable<ConsultRequest['plant_context']>;

export type ConsultInput = {
  /**
   * The user's free-text note. Trimmed by the hook before dispatch (the
   * backend trims again defensively). Must be non-empty after trim — the
   * AddNoteSheet UI guards this with a disabled Save CTA, but the hook
   * also guards because the contract shouldn't trust caller validation.
   */
  note: string;
  /** Optional plant context forwarded verbatim to /api/consult. */
  plantContext?: ConsultPlantContext;
};

export type ConsultStatus =
  | 'idle'
  | 'requesting'
  | 'success'
  | 'error'
  | 'queued';

export type UseConsultRequestConfig = {
  /**
   * Required. The api client to call. Same dependency-injection rationale
   * as useDiagnoseRequest — making the dependency visible at the call site
   * keeps tests honest and prevents accidental coupling to a hidden
   * singleton.
   */
  apiClient: ApiClient;
  /**
   * Optional connectivity probe. Defaults to "always online"; E7-003 will
   * wire a real subscription via this same prop.
   */
  netInfo?: NetInfoLike;
  /**
   * Optional offline-queue wiring (E7-004). When provided, the offline
   * pre-flight branch and the post-call `network → queued` coercion
   * BOTH persist to `sync_queue` so the SyncDrainer can replay on
   * reconnect. When omitted, the hook keeps the legacy E5-006 behavior:
   * `kind:'queued'` is returned to the UI as a pure signal with no
   * persistence.
   */
  offlineQueue?: OfflineQueueConfig;
};

export type UseConsultRequestReturn = {
  consult: (input: ConsultInput) => Promise<ApiResult<ConsultResponse>>;
  status: ConsultStatus;
  lastResult: ApiResult<ConsultResponse> | null;
  /**
   * Reset back to the initial state. Used by AddNoteSheet's "Try again"
   * CTA on the off-topic reject card so the input view re-renders with no
   * lingering result.
   */
  reset: () => void;
};

export function useConsultRequest(
  config: UseConsultRequestConfig,
): UseConsultRequestReturn {
  const { apiClient, netInfo = DEFAULT_NET_INFO, offlineQueue } = config;

  const [status, setStatus] = useState<ConsultStatus>('idle');
  const [lastResult, setLastResult] = useState<ApiResult<ConsultResponse> | null>(
    null,
  );

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const callCounterRef = useRef(0);
  const lastCommittedCallIdRef = useRef(0);

  const consult = useCallback(
    async (input: ConsultInput): Promise<ApiResult<ConsultResponse>> => {
      const callId = ++callCounterRef.current;

      // Trim is defensive; AddNoteSheet's empty-submit guard already strips
      // pure-whitespace input. Empty after trim is a programming error from
      // the call site (the UI shouldn't have allowed it), but coercing to
      // a parse_error result is friendlier than throwing — the screen sees
      // a structured error and recovers without a crash.
      const note = input.note.trim();
      if (!note) {
        const empty: ApiResult<ConsultResponse> = { ok: false, kind: 'parse_error' };
        commitResult(empty, callId);
        return empty;
      }

      if (mountedRef.current) {
        setStatus('requesting');
      }

      // Build the wire body once so pre-flight enqueue and online-path
      // dispatch use the byte-identical payload. The drainer JSON.parse's
      // this on replay; constructing in one place keeps the dedupe hash
      // and the dispatched body in lockstep.
      //
      // The api client's ConsultRequest is `ConsultRequestBody`. We
      // forward `note` (trimmed) and `plant_context` if present, omitting
      // it entirely when undefined so the wire body stays minimal — the
      // backend's parser tolerates absence but not a key with `undefined`.
      const body: ConsultRequest = input.plantContext
        ? { note, plant_context: input.plantContext }
        : { note };
      // Hash the trimmed note + plantContext as a stable identity. Two
      // taps with the same note (and same plant context) collapse to one
      // sync_queue row. Different plants → different plantContext →
      // different hash → not deduped (correct).
      const inputHash = hashStable(body);

      const online = await netInfo.isConnected();
      if (!online) {
        // E7-004: persist to sync_queue. Pre-flight short-circuit; do
        // NOT call apiClient.consult since the radio is down.
        if (offlineQueue) {
          await safeEnqueue(offlineQueue, {
            endpoint: 'consult',
            payload: body,
            inputHash,
          });
        }
        const queuedResult: ApiResult<ConsultResponse> = {
          ok: false,
          kind: 'queued',
        };
        commitResult(queuedResult, callId);
        return queuedResult;
      }

      let result: ApiResult<ConsultResponse>;
      try {
        result = await apiClient.consult(body);
      } catch (err) {
        // Defensive: api client contract is "never throws." If a future
        // change breaks that, surface as `network` so the network → queued
        // coercion below routes us to the tan banner instead of a crash.
        void err;
        result = { ok: false, kind: 'network' };
      }

      // Network → queued coercion. See module header.
      // E7-004: real persistence — enqueue on the post-call network path
      // so the drainer replays once we reconnect. The (endpoint,
      // inputHash) tuple is the same as the pre-flight branch, so a
      // double-tap that races past pre-flight collapses at the CRUD
      // layer.
      if (!result.ok && result.kind === 'network') {
        if (offlineQueue) {
          await safeEnqueue(offlineQueue, {
            endpoint: 'consult',
            payload: body,
            inputHash,
          });
        }
        const coerced: ApiResult<ConsultResponse> = { ok: false, kind: 'queued' };
        commitResult(coerced, callId);
        return coerced;
      }

      commitResult(result, callId);
      return result;
    },
    [apiClient, netInfo, offlineQueue],
  );

  const reset = useCallback(() => {
    if (!mountedRef.current) return;
    // Bumping the committed call id ensures any in-flight call resolving
    // after reset() doesn't overwrite the freshly-cleared state.
    lastCommittedCallIdRef.current = ++callCounterRef.current;
    setStatus('idle');
    setLastResult(null);
  }, []);

  function commitResult(
    result: ApiResult<ConsultResponse>,
    callId: number,
  ): void {
    if (!mountedRef.current) return;
    if (callId < lastCommittedCallIdRef.current) return;
    lastCommittedCallIdRef.current = callId;
    setLastResult(result);
    if (result.ok) {
      setStatus('success');
    } else if (result.kind === 'queued') {
      setStatus('queued');
    } else {
      setStatus('error');
    }
  }

  return { consult, status, lastResult, reset };
}
