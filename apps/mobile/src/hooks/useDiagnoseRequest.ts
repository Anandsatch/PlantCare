/**
 * useDiagnoseRequest — the camera-flow hook that talks to /api/diagnose.
 *
 * Surface (master plan, line 423):
 *   const { diagnose, status, lastResult } = useDiagnoseRequest({ apiClient });
 *   const result = await diagnose({ photoUri, plantContext });
 *   if (result.ok) { render data } else switch (result.kind) { ... }
 *
 * Online path: forwards to `apiClient.diagnose({ image: { uri } })` and
 * returns the same `ApiResult<DiagnoseResponse>` discriminated union the
 * client surfaces.
 *
 * Offline / network-degraded path: returns `{ ok: false, kind: 'queued' }`
 * and sets status to 'queued'. The UI fork then renders the tan banner
 * ("Diagnose queued — will run when online") instead of an error card.
 *
 * V1 scope locks honored here:
 *   - No actual sync_queue persistence in this hook. E7-001..E7-004 own that
 *     layer; the queued path is a placeholder return value that lets the
 *     camera flow ship today, lets E5-009 build the offline banner today,
 *     and lets E7 wire real persistence later without changing this hook's
 *     external contract.
 *   - No @react-native-community/netinfo dep added. The hook accepts a
 *     `netInfo` injection point with a sensible default that assumes online.
 *     E7 will swap in the real NetInfo subscription via the same prop.
 *   - No react-query / swr / tanstack-query. The hook holds its own state
 *     machine (idle | requesting | success | error | queued); the surface is
 *     small enough that a query library would be more abstraction than
 *     value. The diagnose flow is one-shot per camera capture, not a
 *     long-lived cache.
 *
 * Network → queued coercion:
 *   When `apiClient.diagnose` resolves with `kind: 'network'`, the hook
 *   coerces that to `{ ok: false, kind: 'queued' }`. Rationale: the api
 *   client emits `network` whenever fetch *throws* — connection down, DNS
 *   fail, captive portal, TLS refused. From the user's POV those are
 *   indistinguishable from "I'm offline," and the V1 desired UX (master
 *   plan, line 346) is the tan banner with "Diagnose queued — will run when
 *   online" rather than an error card with a retry button. When E7 lands,
 *   this is also the path that will trigger actual enqueue. `timeout` is
 *   NOT coerced — that means the request reached the lab and we waited too
 *   long, which is a different user intent (retry now) and a different
 *   error state in the A-3 spec.
 *
 * Race semantics:
 *   If `diagnose()` is called while a previous call is in-flight, both
 *   requests run independently. `lastResult` reflects the most recent
 *   *call* that resolved, but we tag each call with a monotonic counter so
 *   an older call resolving later cannot overwrite a newer call's result
 *   (most-recent-by-call-order, not most-recent-by-resolution).
 *
 * Unmount safety:
 *   A `mountedRef` guards setState after unmount. We considered threading
 *   AbortController through the api client's `signal` parameter, but the
 *   E2-005 client doesn't currently expose `signal` on the per-call
 *   options surface. Adding it is an api client change, not a hook change.
 *   The mountedRef approach is correct: setState is the only side effect
 *   we need to suppress; the in-flight fetch will complete and its result
 *   is just ignored.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import type { ApiClient, ApiResult, DiagnoseResponse } from '../api';

/**
 * Optional plant context attached to a diagnose request. Shape matches the
 * subset of `plants` columns relevant to a diagnosis (species and
 * nickname, both used by the LLM prompt for grounding). Defined locally —
 * not imported from `db/types` — because db/types lives behind an unmerged
 * PR and we don't want to couple two stacks. E7 / E5-008 will tighten the
 * boundary; for now, the shape is documentation.
 */
export type PlantContext = {
  species_slug?: string;
  nickname?: string;
};

/**
 * Connectivity probe. The default implementation always reports online —
 * fine for V1 because the api client itself emits `kind: 'network'` when a
 * fetch throws, and we coerce that to `queued`. E7-003 will wire a real
 * `@react-native-community/netinfo` subscription via this same prop so we
 * don't waste a fetch + 20s timeout when the radio is already off.
 */
export type NetInfoLike = {
  isConnected: () => boolean | Promise<boolean>;
};

const DEFAULT_NET_INFO: NetInfoLike = {
  isConnected: () => true,
};

export type UseDiagnoseRequestConfig = {
  /**
   * Required. The api client to call. Kept injectable rather than
   * defaulting to a singleton so callers (screens, tests) make the
   * dependency visible at the construction site. A future
   * `apps/mobile/src/api/singleton.ts` may add a default for screens to
   * import, but the hook's contract stays explicit.
   */
  apiClient: ApiClient;
  /**
   * Optional connectivity probe. Defaults to "always online" — the api
   * client's `network` kind handles the actual offline detection today.
   */
  netInfo?: NetInfoLike;
};

export type DiagnoseInput = {
  /**
   * On-device URI of the photo to diagnose. Compressed by E5-005 before
   * arriving here; the hook itself does no compression.
   */
  photoUri: string;
  /**
   * Optional context. Forwarded to the LLM via the multipart body's
   * companion fields if the api client adds them later; today the
   * diagnose endpoint takes only an image, so the context is informational
   * for now and reserved for forward-compat.
   */
  plantContext?: PlantContext;
};

export type DiagnoseStatus =
  | 'idle'
  | 'requesting'
  | 'success'
  | 'error'
  | 'queued';

export type UseDiagnoseRequestReturn = {
  diagnose: (input: DiagnoseInput) => Promise<ApiResult<DiagnoseResponse>>;
  status: DiagnoseStatus;
  lastResult: ApiResult<DiagnoseResponse> | null;
};

/**
 * Hook factory. Returns a stable `diagnose` callback (memoized via
 * useCallback against the injected apiClient + netInfo) plus the current
 * status and the most-recent result.
 */
export function useDiagnoseRequest(
  config: UseDiagnoseRequestConfig,
): UseDiagnoseRequestReturn {
  const { apiClient, netInfo = DEFAULT_NET_INFO } = config;

  const [status, setStatus] = useState<DiagnoseStatus>('idle');
  const [lastResult, setLastResult] = useState<ApiResult<DiagnoseResponse> | null>(
    null,
  );

  // Track mount state so we don't setState after unmount. React 18+ logs a
  // warning rather than throwing, but the warning is correct and we should
  // honor it.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Monotonic counter that tags each diagnose() call. When a response
  // resolves, we only commit it to state if its id is >= the most recent
  // committed id — otherwise an older call resolving after a newer one
  // would clobber the newer result (a real bug, not theoretical: a slow
  // first request + retried second request commonly resolve out of order).
  const callCounterRef = useRef(0);
  const lastCommittedCallIdRef = useRef(0);

  const diagnose = useCallback(
    async (input: DiagnoseInput): Promise<ApiResult<DiagnoseResponse>> => {
      const callId = ++callCounterRef.current;
      void input.plantContext; // currently unused on the wire; reserved for forward-compat.

      if (mountedRef.current) {
        setStatus('requesting');
      }

      const online = await netInfo.isConnected();
      if (!online) {
        // TODO(E7-004): persist to sync_queue here instead of (or in
        // addition to) returning the placeholder. Today this is a pure
        // signal — the screen sees `queued` and renders the tan banner;
        // there is no on-disk record of the queued diagnose. When E7
        // lands, this branch should call into the SyncDrainer to enqueue
        // the photo + context, and the returned result should carry a
        // `queue_id` so the UI can correlate the eventual drain.
        const queuedResult: ApiResult<DiagnoseResponse> = {
          ok: false,
          kind: 'queued',
        };
        commitResult(queuedResult, callId);
        return queuedResult;
      }

      let result: ApiResult<DiagnoseResponse>;
      try {
        result = await apiClient.diagnose({
          image: { uri: input.photoUri },
        });
      } catch (err) {
        // Defensive: the api client's contract is "never throws, always
        // returns ApiResult." If a future change breaks that contract,
        // we'd rather not crash the camera flow. Surface as `network` —
        // it's the closest match for "transport failed before producing
        // a structured response" — which then coerces to `queued` below.
        void err;
        result = { ok: false, kind: 'network' };
      }

      // Network → queued coercion. See module header.
      //
      // Codex adversarial-review tension (acknowledged, not deferred): the
      // `queued` kind currently has no persistence behind it, and `network`
      // can fire for DNS/TLS/captive-portal failures that aren't true
      // offline. The argument for surfacing those as an error and letting
      // the user retry is real. We pick coercion-to-`queued` deliberately
      // because in V1:
      //   (a) the user-visible difference between "we couldn't reach the
      //       lab right now" and "you're offline" is nil — both look like
      //       a captive-portal-ish failure to a non-technical user;
      //   (b) the desired UX (master plan, line 346) is the tan banner,
      //       not an error card with a retry button; the camera flow
      //       degrades gracefully rather than dead-ending;
      //   (c) E7-004 will wire the actual sync_queue persistence into
      //       this exact branch — no contract change needed at the hook
      //       boundary, only persistence added underneath.
      // The cost of coercion is that today, a captive-portal failure
      // shows the "queued" banner without anything actually being queued.
      // Until E7 lands, that's a small UX lie; until then it's still
      // strictly better than the alternative (an error card the user
      // can't act on without changing networks).
      if (!result.ok && result.kind === 'network') {
        const coerced: ApiResult<DiagnoseResponse> = { ok: false, kind: 'queued' };
        commitResult(coerced, callId);
        return coerced;
      }

      commitResult(result, callId);
      return result;
    },
    [apiClient, netInfo],
  );

  /**
   * Commit a result to state if (a) the component is still mounted and
   * (b) this call is the most recent (by call order, not by resolution
   * order). Otherwise drop the result silently — an older call's result
   * shouldn't overwrite a newer call's, and a setState after unmount is
   * the React warning we want to avoid.
   */
  function commitResult(
    result: ApiResult<DiagnoseResponse>,
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

  return { diagnose, status, lastResult };
}
