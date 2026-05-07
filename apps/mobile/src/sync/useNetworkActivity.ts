/**
 * useNetworkActivity — unified online/offline + foreground/background hook.
 *
 * E7-003. The single signal source the upcoming SyncDrainer (E7-002) consumes
 * to decide when to drain the sync_queue. Master plan, line 631:
 *   "Drainer trigger: on app foreground (NetInfo + AppState listeners), and on
 *    every successful HTTP response (drain next pending row)."
 *
 * Why a unified hook (instead of two separate AppState + NetInfo subscriptions
 * in the drainer): the drainer should ONLY drain when the device is BOTH
 * online AND active. Draining while backgrounded risks partial state on
 * background termination (iOS can kill at any time once we're not foreground)
 * and burns radio battery for results the user can't see anyway. Draining
 * while offline burns request budget on doomed fetches. The single combined
 * status keeps that decision in one place; the drainer just listens for
 * `'online_active'`.
 *
 * Surface:
 *   const { status, lastTransitionAt } = useNetworkActivity({ onChange? });
 *
 * `status` is one of:
 *   - 'resolving'         — initial mount; both subscriptions haven't fired yet
 *   - 'online_active'     — connected + foreground (the drain trigger)
 *   - 'online_background' — connected + backgrounded (don't drain, but don't
 *                           queue; the next 'active' will fire onChange)
 *   - 'offline_active'    — disconnected + foreground (queue, don't drain)
 *   - 'offline_background' — disconnected + backgrounded (queue, don't drain)
 *
 * `lastTransitionAt` is a unix-ms timestamp of the last status change; the
 * drainer can use it to skip work if the foreground transition is "very recent"
 * (e.g. < 250ms ago — debounce against fast app-switcher peeks).
 *
 * `onChange(next, prev)` fires synchronously on every status transition AFTER
 * the initial 'resolving' → first-real-status transition. We intentionally
 * suppress that first transition because a `(prev = 'resolving') → ('online_active')`
 * edge isn't a "real" change in connectivity / lifecycle — it's just the hook
 * waking up. The drainer cares about real transitions (offline→online,
 * background→active) not initial subscription noise.
 *
 * Debounce:
 *   Network state change events are debounced 500ms. Rapid offline→online→
 *   offline within 500ms collapses to one effective transition. Rationale:
 *   captive portals, brief carrier handoffs, and Wi-Fi roaming flap
 *   isConnected several times in <100ms; we don't want to fire onChange (and
 *   wake the drainer) for every flap. AppState transitions are NOT debounced —
 *   they're user-driven and discrete; iOS / Android emit one event per real
 *   foreground or background change.
 *
 *   The 500ms window is the master-plan-implied default (no other window is
 *   specified). Consumers can override via `debounceMs` prop on this hook.
 *
 *   The pending NetInfo value is committed to `netOnlineRef` immediately on
 *   the listener call, NOT inside the debounce closure. Debouncing the
 *   ref-write would let an AppState event mid-window read a stale net value
 *   (e.g. NetInfo says offline at t=0, AppState says active at t=200ms — if
 *   the ref hadn't been updated yet, the commit would emit `online_active`
 *   off the prior value). Writing the ref synchronously and debouncing only
 *   `commit()` collapses status flapping while keeping the latest known net
 *   value visible to AppState-driven commits inside the same window. (Codex
 *   adversarial review P2, addressed before ship.)
 *
 * Cleanup:
 *   Unmount removes both NetInfo and AppState subscriptions and clears the
 *   debounce timer. After unmount, any pending debounce callback is a no-op
 *   (the timer is cleared and a `mountedRef` guard wraps state updates).
 *
 * Strict-mode double-mount:
 *   React 18 strict mode mounts effects twice in dev. We accept the 2-subscribe
 *   / 2-unsubscribe symmetry rather than latching with a ref. Each subscription
 *   call is balanced by its own returned unsubscribe function; the timer ref
 *   cleanup is idempotent. Strict-mode behavior is dev-only and the test suite
 *   asserts the production semantics: one mount → one subscribe → one
 *   unsubscribe per teardown.
 *
 * iOS 'inactive' state:
 *   iOS emits 'inactive' during the app-switcher slide-up, incoming-call
 *   peek, and Control Center pull-down. The master plan doesn't specify, so
 *   we treat 'inactive' as 'background' (conservative — don't drain during
 *   the gesture). When the user dismisses the gesture without leaving, the
 *   AppState event fires 'active' again and we transition back. Net: one
 *   spurious background→active round-trip during a brief peek, which the
 *   debounce on the drainer side (E7-002) will smooth.
 *
 * V1 scope locks honored:
 *   - No connectivity abstraction layer beyond NetInfo + AppState.
 *   - No date-fns / luxon / Temporal — just `Date.now()` for the timestamp.
 *   - No AsyncStorage — state lives in-memory only, lost on app kill.
 *   - No wiring into existing components — that's E7-004's job.
 */

import NetInfo, { type NetInfoState } from '@react-native-community/netinfo';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, type AppStateStatus, type NativeEventSubscription } from 'react-native';

export type NetworkStatus =
  | 'resolving'
  | 'online_active'
  | 'online_background'
  | 'offline_active'
  | 'offline_background';

export type NetworkActivitySnapshot = {
  status: NetworkStatus;
  lastTransitionAt: number;
};

export type UseNetworkActivityConfig = {
  /**
   * Fires synchronously on every status transition AFTER the initial
   * 'resolving' → first-real-status edge. Stable identity is the caller's
   * responsibility — wrap in `useCallback` if used inside a screen.
   */
  onChange?: (next: NetworkStatus, prev: NetworkStatus) => void;
  /**
   * Network-side debounce window in ms. Default 500ms per the master-plan-
   * implied default. AppState transitions are never debounced (see file
   * header).
   */
  debounceMs?: number;
};

const DEFAULT_DEBOUNCE_MS = 500;

/**
 * Map an AppState raw status to "active" vs "background".
 *
 * iOS emits: 'active' | 'inactive' | 'background'.
 * Android emits: 'active' | 'background'.
 * RN typings also include 'unknown' and 'extension' on some platforms.
 *
 * We treat anything other than 'active' as backgrounded (conservative).
 */
function isAppStateActive(state: AppStateStatus): boolean {
  return state === 'active';
}

/**
 * Convert NetInfoState into a binary online flag. A connection is treated as
 * online when `isConnected === true` AND `isInternetReachable !== false`. We
 * check `!== false` (not `=== true`) because `isInternetReachable` is `null`
 * before NetInfo has finished probing reachability — being conservative there
 * (treating null as offline) would briefly flap us to offline_* on every
 * fresh launch even on a connected device.
 *
 * `isConnected` itself can be `null` on the unknown state; we coerce that to
 * `false` (no link layer at all).
 */
function isNetInfoOnline(state: NetInfoState | null): boolean {
  if (state == null) return false;
  if (state.isConnected !== true) return false;
  return state.isInternetReachable !== false;
}

/**
 * Combine the two raw signals into a NetworkStatus. While either signal is
 * still 'resolving' (i.e. we haven't received the first event from that
 * subscription), the combined status is 'resolving'.
 */
function deriveStatus(
  appActive: boolean | null,
  netOnline: boolean | null,
): NetworkStatus {
  if (appActive == null || netOnline == null) return 'resolving';
  if (netOnline && appActive) return 'online_active';
  if (netOnline && !appActive) return 'online_background';
  if (!netOnline && appActive) return 'offline_active';
  return 'offline_background';
}

export function useNetworkActivity(
  config: UseNetworkActivityConfig = {},
): NetworkActivitySnapshot {
  const { onChange, debounceMs = DEFAULT_DEBOUNCE_MS } = config;

  const [snapshot, setSnapshot] = useState<NetworkActivitySnapshot>({
    status: 'resolving',
    lastTransitionAt: Date.now(),
  });

  // Refs that track the most recent raw signals. `null` = "we haven't heard
  // from this subscription yet"; deriveStatus collapses any null to 'resolving'.
  const appActiveRef = useRef<boolean | null>(null);
  const netOnlineRef = useRef<boolean | null>(null);

  // Mirror of the current committed status so we can compute (next, prev) for
  // onChange without depending on stale closures. Updated synchronously inside
  // commit().
  const currentStatusRef = useRef<NetworkStatus>('resolving');

  // Mounted guard so any in-flight debounce callback that fires after unmount
  // becomes a no-op.
  const mountedRef = useRef(true);

  // The latest `onChange` callback. We don't include `onChange` in the effect
  // deps below so the subscriptions aren't torn down + rebuilt every render
  // (the caller may not have wrapped it in useCallback).
  const onChangeRef = useRef<UseNetworkActivityConfig['onChange']>(undefined);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  // Debounce timer for NetInfo updates. AppState updates bypass this and
  // commit synchronously.
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * Commit a fresh combined status if it differs from the currently committed
   * one. Fires onChange with (next, prev) when:
   *   - we're transitioning away from 'resolving' for the first time AND prev
   *     was already a real status (impossible — covered for completeness), OR
   *   - both prev and next are real (non-resolving) statuses.
   *
   * The 'resolving' → first-real-status edge is intentionally NOT reported via
   * onChange (see file header).
   */
  const commit = useCallback(() => {
    if (!mountedRef.current) return;
    const next = deriveStatus(appActiveRef.current, netOnlineRef.current);
    const prev = currentStatusRef.current;
    if (next === prev) return;

    currentStatusRef.current = next;
    setSnapshot({ status: next, lastTransitionAt: Date.now() });

    // Suppress the initial 'resolving' → real-status edge. Real transitions
    // (any status pair where neither side is 'resolving') always fire.
    if (prev !== 'resolving' && next !== 'resolving') {
      onChangeRef.current?.(next, prev);
    }
  }, []);

  // NetInfo + AppState subscriptions. Both effects intentionally have empty
  // deps: they capture refs, not props, so they only set up once per mount
  // (twice under React 18 strict mode dev, which we accept — see file header).
  useEffect(() => {
    mountedRef.current = true;

    // NetInfo: addEventListener returns the unsubscribe function directly.
    const unsubscribeNet = NetInfo.addEventListener((state) => {
      // Update the ref synchronously so an AppState-driven commit inside the
      // debounce window reads the freshest net value. Only the commit() call
      // is debounced — see the file header on debounce semantics.
      netOnlineRef.current = isNetInfoOnline(state);

      if (debounceTimerRef.current != null) {
        clearTimeout(debounceTimerRef.current);
      }
      debounceTimerRef.current = setTimeout(() => {
        debounceTimerRef.current = null;
        if (!mountedRef.current) return;
        commit();
      }, debounceMs);
    });

    // AppState: addEventListener returns a NativeEventSubscription with
    // .remove(). We do NOT debounce AppState because it's user-driven.
    const appStateSub: NativeEventSubscription = AppState.addEventListener(
      'change',
      (state) => {
        appActiveRef.current = isAppStateActive(state);
        commit();
      },
    );

    // Seed the AppState side from the synchronous current value. RN doesn't
    // emit a 'change' event on subscribe; without this, an app that's
    // already foregrounded on mount would sit at 'resolving' until the first
    // background round-trip. NetInfo, by contrast, fires its initial state
    // shortly after subscribe, so we let the listener handle that side.
    appActiveRef.current = isAppStateActive(AppState.currentState);
    commit();

    return () => {
      mountedRef.current = false;
      unsubscribeNet();
      appStateSub.remove();
      if (debounceTimerRef.current != null) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: subs set up once per mount; commit + debounceMs captured at mount time, see file header.
  }, []);

  return snapshot;
}
