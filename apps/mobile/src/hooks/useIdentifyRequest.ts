/**
 * useIdentifyRequest — mirror of `useDiagnoseRequest` (E5-006) for
 * `/api/identify`. Same architecture (state machine, monotonic call
 * counter for race-by-call-order, mounted-ref guard for unmount safety,
 * injectable `netInfo` probe, network → queued coercion); only the
 * dispatched method differs.
 *
 * Why a parallel hook instead of parameterizing `useDiagnoseRequest`:
 *   - V1 scope lock: "Renaming `useDiagnoseRequest` interface" is rejected.
 *     Keeping the diagnose hook stable means the camera-result screen
 *     (E5-008) can ship without churn.
 *   - The diagnose hook's contract is a public surface (its types are
 *     re-exported from `apps/mobile/src/hooks/index.ts`); adding a `mode`
 *     parameter would either be a breaking change or a stutter overload.
 *   - Identify and diagnose differ in response shape and in how callers
 *     interpret the result (top-3 candidates vs disease_slug + severity).
 *     A shared hook would force callers to narrow `lastResult` against the
 *     wrong response type half the time.
 *
 * Identical contract to E5-006:
 *   - Online + apiClient.identify resolves ok    → status='success'.
 *   - Online + apiClient.identify resolves with `kind: 'network'` → coerced
 *     to `{ ok:false, kind:'queued' }` and status='queued'. Same UX
 *     rationale as the diagnose hook (master plan, line 346).
 *   - `timeout` / `low_confidence` / `parse_error` / `layer1_reject` /
 *     `server` are NOT coerced — the discriminated union stays distinct.
 *   - Offline (`netInfo.isConnected()` returns false) short-circuits
 *     without calling apiClient and returns `{ ok:false, kind:'queued' }`.
 *   - apiClient throwing is defensively coerced to `{ ok:false, kind:'network' }`
 *     and then to `queued`.
 *   - Most-recent-by-call-order race semantics: an older call's result
 *     never overwrites a newer call's `lastResult`.
 *   - mountedRef guards setState after unmount.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import type { ApiClient, ApiResult, IdentifyRequest, IdentifyResponse } from '../api';
import {
  hashStable,
  safeEnqueue,
  type OfflineQueueConfig,
} from './offlineEnqueue';

export type NetInfoLike = {
  isConnected: () => boolean | Promise<boolean>;
};

const DEFAULT_NET_INFO: NetInfoLike = {
  isConnected: () => true,
};

export type UseIdentifyRequestConfig = {
  apiClient: ApiClient;
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

export type IdentifyInput = {
  /** On-device URI of the (already-compressed by E5-005) photo to identify. */
  photoUri: string;
};

export type IdentifyStatus =
  | 'idle'
  | 'requesting'
  | 'success'
  | 'error'
  | 'queued';

export type UseIdentifyRequestReturn = {
  identify: (input: IdentifyInput) => Promise<ApiResult<IdentifyResponse>>;
  status: IdentifyStatus;
  lastResult: ApiResult<IdentifyResponse> | null;
};

export function useIdentifyRequest(
  config: UseIdentifyRequestConfig,
): UseIdentifyRequestReturn {
  const { apiClient, netInfo = DEFAULT_NET_INFO, offlineQueue } = config;

  const [status, setStatus] = useState<IdentifyStatus>('idle');
  const [lastResult, setLastResult] = useState<ApiResult<IdentifyResponse> | null>(
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

  const identify = useCallback(
    async (input: IdentifyInput): Promise<ApiResult<IdentifyResponse>> => {
      const callId = ++callCounterRef.current;

      if (mountedRef.current) {
        setStatus('requesting');
      }

      // Build the request body once so pre-flight enqueue and online
      // dispatch use byte-identical payloads. The drainer JSON.parse's
      // this on replay; constructing in one place keeps dedupe and
      // dispatch in lockstep.
      const requestBody: IdentifyRequest = {
        image: { uri: input.photoUri },
      };
      // Hash the photoUri only — same rationale as useDiagnoseRequest.
      // Cross-endpoint collisions are excluded because the dedupe key's
      // refTable carries the endpoint.
      const inputHash = hashStable({ photoUri: input.photoUri });

      const online = await netInfo.isConnected();
      if (!online) {
        if (offlineQueue) {
          await safeEnqueue(offlineQueue, {
            endpoint: 'identify',
            payload: requestBody,
            inputHash,
          });
        }
        const queuedResult: ApiResult<IdentifyResponse> = {
          ok: false,
          kind: 'queued',
        };
        commitResult(queuedResult, callId);
        return queuedResult;
      }

      let result: ApiResult<IdentifyResponse>;
      try {
        result = await apiClient.identify(requestBody);
      } catch (err) {
        // Defensive: api client contract is "never throws." If a future
        // change breaks that, surface as `network` (which then coerces to
        // `queued` below). Same handling as useDiagnoseRequest.
        void err;
        result = { ok: false, kind: 'network' };
      }

      if (!result.ok && result.kind === 'network') {
        // E7-004: real persistence — enqueue post-call so the drainer
        // replays once we reconnect. Same (endpoint, inputHash) tuple
        // as pre-flight, so the CRUD layer dedupes a double-tap that
        // raced past pre-flight.
        if (offlineQueue) {
          await safeEnqueue(offlineQueue, {
            endpoint: 'identify',
            payload: requestBody,
            inputHash,
          });
        }
        const coerced: ApiResult<IdentifyResponse> = { ok: false, kind: 'queued' };
        commitResult(coerced, callId);
        return coerced;
      }

      commitResult(result, callId);
      return result;
    },
    [apiClient, netInfo, offlineQueue],
  );

  function commitResult(
    result: ApiResult<IdentifyResponse>,
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

  return { identify, status, lastResult };
}
