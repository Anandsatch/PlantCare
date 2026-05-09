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

import type { ApiClient, ApiResult, IdentifyResponse } from '../api';
import {
  recordLlmCall,
  shouldRecordLlmCallResult,
  type LlmCallWriter,
} from '../lib/llmBudget';

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
   * E11-006 insertion path. When provided, the hook calls
   * `recordLlmCall(budgetDb, 'identify')` AFTER any `ApiResult` whose
   * kind consumed upstream LLM quota. Same policy as `useDiagnoseRequest`.
   * Optional — tests of the identify surface itself omit this.
   */
  budgetDb?: LlmCallWriter | (() => Promise<LlmCallWriter>);
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
  const { apiClient, netInfo = DEFAULT_NET_INFO, budgetDb } = config;

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

  // E11-006 insertion path. Same pattern as useDiagnoseRequest.
  const budgetDbRef = useRef(budgetDb);
  useEffect(() => {
    budgetDbRef.current = budgetDb;
  }, [budgetDb]);

  async function resolveBudgetDb(): Promise<LlmCallWriter | null> {
    const current = budgetDbRef.current;
    if (current === undefined) return null;
    try {
      return typeof current === 'function' ? await current() : current;
    } catch {
      return null;
    }
  }

  async function recordIfBillable(result: ApiResult<IdentifyResponse>): Promise<void> {
    if (!shouldRecordLlmCallResult(result)) return;
    const writer = await resolveBudgetDb();
    if (!writer) return;
    await recordLlmCall(writer, 'identify');
  }

  const identify = useCallback(
    async (input: IdentifyInput): Promise<ApiResult<IdentifyResponse>> => {
      const callId = ++callCounterRef.current;

      if (mountedRef.current) {
        setStatus('requesting');
      }

      const online = await netInfo.isConnected();
      if (!online) {
        const queuedResult: ApiResult<IdentifyResponse> = {
          ok: false,
          kind: 'queued',
        };
        commitResult(queuedResult, callId);
        return queuedResult;
      }

      let result: ApiResult<IdentifyResponse>;
      try {
        result = await apiClient.identify({
          image: { uri: input.photoUri },
        });
      } catch (err) {
        // Defensive: api client contract is "never throws." If a future
        // change breaks that, surface as `network` (which then coerces to
        // `queued` below). Same handling as useDiagnoseRequest.
        void err;
        result = { ok: false, kind: 'network' };
      }

      if (!result.ok && result.kind === 'network') {
        // E11-006: do NOT record. `network` means the fetch threw before
        // reaching the provider; no quota was billed.
        const coerced: ApiResult<IdentifyResponse> = { ok: false, kind: 'queued' };
        commitResult(coerced, callId);
        return coerced;
      }

      // E11-006 insertion path. Fire-and-forget; never throws.
      void recordIfBillable(result);
      commitResult(result, callId);
      return result;
    },
    [apiClient, netInfo],
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
