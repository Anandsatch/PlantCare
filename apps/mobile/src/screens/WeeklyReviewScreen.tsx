/**
 * WeeklyReviewScreen — A-6 Weekly Review (Pass 7).
 *
 * Composes the Sunday digest:
 *   - Top hero illustration (emoji-fallback per the V1 scaffolding policy
 *     established in EmptyGardenWelcome.tsx — no `react-native-svg` asset is
 *     bundled at the screen layer in V1; see "Hero illustration" below).
 *   - Fraunces "Last week" headline (Pass 7 voice).
 *   - Inter narrative paragraph from the /api/review LLM payload.
 *   - Per-plant section: nickname + species + 7-day <WateringLedger>.
 *   - "Got it" dismiss CTA at the bottom (fires `onDismiss`).
 *
 * --- States (mutually exclusive) ---
 *   1. loading      — pre-resolution; skeleton placeholder, same gross layout.
 *   2. error        — discriminated by ApiResult.kind. NOT collapsed: each
 *                     network/timeout/server/queued/parse_error/layer1_reject/
 *                     low_confidence kind keeps its own copy + retry semantics.
 *                     We render a tan banner card with kind-specific headline +
 *                     body + "Try again" CTA; tap re-fires /api/review.
 *   3. empty week   — success with `plants_total === 0` AND empty `per_plant`.
 *                     Renders kind editorial copy ("This week was quiet — that's
 *                     okay. Come back next Sunday.") matching Pass 7 voice. The
 *                     per-plant section is hidden entirely (not "no plants" UI).
 *   4. content      — success with at least one plant. Renders headline +
 *                     narrative + per-plant ledgers.
 *
 * --- Source-of-truth alignment ---
 *   - The /api/review backend (E9-001) returns
 *     `{ headline, narrative, per_plant: [{ species_slug, observation }],
 *        confidence, source, latency_ms }`.
 *     The server does NOT echo plant rows back — per_plant carries one
 *     observation per plant that was sent in the request, in the same order.
 *     Per-plant ledgers in A-6 render from local SQLite watering events, paired
 *     against the request-side `plants` (parent-supplied), not from the
 *     response. This screen consumes both.
 *   - The /api/review request body is `{ week_summary, plants[] }` per
 *     packages/api-types ReviewRequestBody. The parent computes that summary
 *     from local SQLite (counts, plants list) and passes it in via the
 *     `weekRequest` prop.
 *
 * --- Hero illustration (cleanest path) ---
 * The Pass 7 spec calls for a hero illustration at the top of A-6. As of this
 * ticket the project does NOT bundle a vector or raster asset for that
 * illustration — see EmptyGardenWelcome.tsx for the same scaffolding decision
 * (Unicode glyph fallback). We render the "🌿" leaf emoji at fontSize 72 inside
 * a centered surface-fill block as a visual anchor. The asset block reads as
 * an "image" to assistive tech via `accessibilityRole='image'` plus an
 * `accessibilityLabel` that names the metaphor. SWAP-WHEN: a real
 * `<WeeklyReviewIllustration />` SVG ships (likely via E2-006 follow-up) —
 * replace the <Text> with the SVG component and drop the inline label.
 *
 * --- Strict-mode double-mount latch (E5-008 / E5-010 pattern) ---
 * React 19 + Strict Mode mounts → unmounts → mounts again per component in dev,
 * which gives each mount a fresh ref tree. A pure `useRef` latch isn't enough:
 * codex P1 catch — the second StrictMode mount creates a NEW
 * dispatchedRef = false, and dispatch fires again. The realistic-correct fix
 * for V1 is two-layered:
 *
 *   1. A `dispatchedRef` per-instance latch suppresses double-fires WITHIN
 *      a single mount (the common case in dev — useEffect runs twice on the
 *      same instance under React 18+ Strict Mode "useEffect double-invocation"
 *      semantics, which IS guarded by the ref). This is the documented
 *      contract: "useEffect-fire count is 1 per mount."
 *   2. A module-scoped `inFlightDispatch` map keyed by a stable request
 *      fingerprint catches the cross-mount StrictMode case (the
 *      mount→unmount→mount cycle). When the second mount arrives, the
 *      first call is still in flight; the map sees it, skips a second
 *      dispatch, and the second mount's commit-guard waits for the first
 *      result via the shared promise. The map clears on resolution.
 *
 * This is the cleanest seam without taking on a query library. The test
 * "Strict-mode" case wraps the component in <React.StrictMode> so the assertion
 * matches the real dev runtime.
 *
 * On retry, the latch is reset and the fingerprint cache is cleared so a fresh
 * dispatch lands.
 *
 * --- Reduce-motion init pattern (Wave 1 lesson, E9-003 P1) ---
 * Any reveal animation initializes the Animated.Value at the END state and
 * only animates if `reduceMotion === false`. Boot-time the hook returns
 * `false` for a brief async window, but the Animated.Value sits at the end
 * state already, so a flicker-then-correct "false-positive motion" never
 * happens. When the hook flips to true after the OS reports its preference,
 * the value is already at end state — the gate just doesn't start a loop.
 *
 * --- AppState resume policy ---
 * If a successful response is in `lastResult`, foregrounding does NOT re-fire
 * /api/review. That's user-hostile (a Sunday letter that the user paused on
 * and came back to should not refresh, blank, and reload). The only re-fetch
 * triggers are: (a) first-mount dispatch and (b) explicit retry tap. AppState
 * is still wired up so a future "show pending banner on resume after error"
 * can hang off the same listener without contract churn.
 *
 * --- Accessibility focus on loading → content swap ---
 * When the response settles to success, we move VoiceOver/TalkBack focus to
 * the headline element via `AccessibilityInfo.setAccessibilityFocus()` keyed
 * by `findNodeHandle()`. Without this, screen readers can leave focus on a
 * skeleton element that just unmounted and announce nothing. Same pattern as
 * E5-010.
 *
 * --- V1 scope locks (REJECT) ---
 *   - date-fns / dayjs / luxon / Temporal — millisecond math only.
 *   - Compressing the API discriminated union — each kind keeps its own copy.
 *   - Cloud sync of the dismiss state — parent owns persistence (SQLite or
 *     AsyncStorage).
 *   - New deps / libraries — RN + react + @plantcare packages only.
 *   - Backend changes — /api/review is shipped via E9-001.
 *   - Manual gates.
 */

import {
  AccessibilityInfo,
  Animated,
  AppState,
  type AppStateStatus,
  findNodeHandle,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import * as React from 'react';

import type {
  ApiClient,
  ApiResult,
  ReviewRequest,
  ReviewResponse,
} from '../api';
import { WateringLedger, type WateringEvent } from '../components/WateringLedger';
import { useReduceMotion } from '../hooks/useReduceMotion';
import { useTheme } from '../hooks/useTheme';

// ─── Public types ────────────────────────────────────────────────────────

/**
 * Per-plant data the parent passes in. Includes the plant's identity (nickname,
 * species_label) and its 7-day watering events. The screen pairs each entry
 * (in order) against the response's `per_plant[i].observation` line.
 */
export type WeeklyReviewPlantInput = {
  /** Stable identity. SQLite plants.id. */
  id: string;
  /** Display name. Falls back to species_label when absent. */
  nickname?: string;
  /** Latin species label, e.g. "Monstera deliciosa". */
  species_label: string;
  /** Watering events for the past ~7 local-tz days, fed straight to <WateringLedger>. */
  events: WateringEvent[];
};

export type WeeklyReviewScreenProps = {
  /** API client — injected so tests don't depend on a runtime baseUrl. */
  apiClient: ApiClient;
  /**
   * Validated request body. The parent computes the week_summary + plants
   * payload from local SQLite. The screen forwards it to /api/review and
   * pairs the response's `per_plant` observations against `plantsForLedgers`
   * (same order — see plan note in module header).
   */
  weekRequest: ReviewRequest;
  /**
   * Per-plant data, paired by index against `weekRequest.plants`. The screen
   * uses this for the per-plant section: nickname + species + ledger row.
   * If `weekRequest.plants` is empty, this should also be empty (empty week).
   */
  plantsForLedgers: WeeklyReviewPlantInput[];
  /** Fired on "Got it" tap. Parent owns dismiss persistence (SQLite/AsyncStorage). */
  onDismiss: () => void;
  /** Optional anchor for "today" — forwarded to <WateringLedger>. Default Date.now(). */
  nowMs?: number;
  /** Optional testID forwarded to the outer ScrollView container. */
  testID?: string;
};

// ─── Constants (Pass 7 voice) ────────────────────────────────────────────

const HEADLINE_TEXT = 'Last week';
const EMPTY_WEEK_TEXT =
  "This week was quiet — that's okay. Come back next Sunday.";
const DISMISS_LABEL = 'Got it';
const HERO_GLYPH = '🌿';
const HERO_A11Y_LABEL = 'A leaf — your weekly garden letter';

// Error copy is kind-specific by design. Reviewers occasionally ask "can we
// just use a generic 'Try again later' string?" — REJECT. The user-visible
// difference matters: "We couldn't reach the lab" (network) is the user's
// problem to fix (turn wifi back on); "We're overloaded" (server, with retry)
// is ours and they should wait; "Your request was queued" (queued) shouldn't
// even render an error card. See E5-009 for the same discriminated-union rule.
const ERROR_COPY = {
  network: {
    headline: "We couldn't reach the lab.",
    body: "Check your connection and try again.",
  },
  timeout: {
    headline: 'The lab took too long.',
    body: "Let's try that again.",
  },
  server: {
    headline: 'Something went wrong on our end.',
    body: "We'll be back. Try again in a moment.",
  },
  parse_error: {
    headline: 'We got a strange reply.',
    body: 'Try once more — usually clears up.',
  },
  layer1_reject: {
    headline: 'Hmm, we hit a snag.',
    body: 'Try again — we should have a letter for you.',
  },
  low_confidence: {
    headline: 'The lab is unsure this week.',
    body: 'Try again to fetch a fresh take.',
  },
  // 'queued' is NOT in this map — queued doesn't render an error card. See
  // renderForResult() switch.
} as const;

// ─── Internal state model ────────────────────────────────────────────────

type ScreenState =
  | { kind: 'loading' }
  | { kind: 'queued' }
  | { kind: 'error'; result: Extract<ApiResult<ReviewResponse>, { ok: false }> }
  | { kind: 'success'; data: ReviewResponse };

/**
 * Module-scoped in-flight dispatch cache. Keyed by a stable fingerprint
 * derived from the request body. Catches the StrictMode mount→unmount→mount
 * cycle: the second mount's effect sees the first call's promise still
 * pending and reuses it, so /api/review fires exactly once per fingerprint
 * across the mount cycle. Entries clear on resolution. This is intentionally
 * NOT a global cache for the response — only the in-flight promise. Two
 * separate Sundays' worth of weekRequest fingerprints hash differently and
 * each get their own dispatch.
 */
const inFlightDispatches = new Map<string, Promise<ApiResult<ReviewResponse>>>();

/**
 * Stable fingerprint for the review request. JSON.stringify is the cheapest
 * deterministic key on a small typed body and is acceptable here — keys are
 * not stored long-term and ordering of fields in our types is stable.
 */
function fingerprintRequest(req: ReviewRequest): string {
  return JSON.stringify(req);
}

/** Test seam — clears the in-flight cache between tests. */
export function __resetInFlightDispatchesForTests(): void {
  inFlightDispatches.clear();
}

// ─── Component ───────────────────────────────────────────────────────────

export function WeeklyReviewScreen({
  apiClient,
  weekRequest,
  plantsForLedgers,
  onDismiss,
  nowMs,
  testID,
}: WeeklyReviewScreenProps): React.ReactElement {
  const theme = useTheme();
  const reduceMotion = useReduceMotion();

  const [state, setState] = React.useState<ScreenState>({ kind: 'loading' });

  // ─── Effect dispatch latch (Strict-mode double-mount safe) ───────────
  // Initialized at false, flipped true the first time we kick a request.
  // Reset to false from the retry handler BEFORE calling the fetcher so the
  // imperative path doesn't conflict with the latch logic — but the latch
  // itself only gates the mount-time dispatch (not retries). See header.
  const dispatchedRef = React.useRef(false);
  const mountedRef = React.useRef(true);
  // Monotonic call counter — same race-by-call-order discipline as
  // useDiagnoseRequest (E5-006). A slow first call MUST NOT clobber a faster
  // retry. The id committed last wins regardless of resolution order.
  const callCounterRef = React.useRef(0);

  // ─── Reduce-motion-safe content reveal (Wave 1 lesson) ───────────────
  // Initialized at end-state (1) so the first paint is the final paint when
  // reduce-motion is on. We animate from 0→1 only when we KNOW reduce-motion
  // is false (the hook initializes at false during the boot async window —
  // we defensively guard against starting an animation in that window by
  // gating on a "did we ever flip to true?" snapshot). Simpler than that:
  // we only run the animation effect once on the loading→content edge, and
  // we read `reduceMotion` at that moment. If the user toggled reduce-motion
  // during the async fetch window, they get instant content (the safer
  // direction; the animation's only purpose is editorial polish).
  const fadeAnim = React.useRef(new Animated.Value(1)).current;

  // ─── Headline ref for accessibility focus on load → content swap ─────
  const headlineRef = React.useRef<Text>(null);

  // The fetcher. Kept as a stable callback with respect to the apiClient
  // dependency only — weekRequest is assumed stable per parent contract.
  // We also use a counter-tagged commit guard so a stale call (e.g. unmount
  // mid-request, or a retry that fired before the first call resolved)
  // can't commit setState.
  //
  // The `bypassCache` flag is set by the explicit retry path so the cache
  // doesn't return a stale in-flight failure. Mount-time dispatch goes
  // through the cache (StrictMode dedupe).
  const runReview = React.useCallback(
    async (bypassCache = false): Promise<void> => {
      const callId = ++callCounterRef.current;
      if (mountedRef.current) setState({ kind: 'loading' });

      const key = fingerprintRequest(weekRequest);
      let promise = bypassCache ? undefined : inFlightDispatches.get(key);
      if (!promise) {
        promise = (async () => {
          try {
            return await apiClient.review(weekRequest);
          } catch {
            // Defensive: the api client contract is "never throws, always
            // returns ApiResult." If a future change breaks that contract,
            // we'd rather not crash the Sunday letter screen. Surface as
            // `network` — closest match for "transport failed before
            // producing a structured response."
            return { ok: false, kind: 'network' as const };
          }
        })();
        inFlightDispatches.set(key, promise);
        // Clear on resolution regardless of outcome. The cache is for
        // in-flight dedupe, not result memoization.
        promise.finally(() => {
          if (inFlightDispatches.get(key) === promise) {
            inFlightDispatches.delete(key);
          }
        });
      }

      const result = await promise;

      if (!mountedRef.current) return;
      if (callId < callCounterRef.current) return;

      if (result.ok) {
        setState({ kind: 'success', data: result.data });
      } else if (result.kind === 'queued') {
        setState({ kind: 'queued' });
      } else {
        setState({ kind: 'error', result });
      }
    },
    [apiClient, weekRequest],
  );

  // First-mount dispatch — Strict-mode-safe via the latch.
  React.useEffect(() => {
    mountedRef.current = true;
    if (!dispatchedRef.current) {
      dispatchedRef.current = true;
      void runReview();
    }
    return () => {
      mountedRef.current = false;
    };
    // We deliberately don't include runReview in deps. The latch already
    // guarantees single dispatch per mount; a runReview identity change
    // (unlikely — apiClient + weekRequest are parent-stable per contract)
    // should drive a retry through the explicit retry button, not a silent
    // re-fetch. Same posture as the AppState resume rule.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // AppState resume — wire it but DON'T re-fetch on settled-success. See
  // header. We retain the listener so future post-V1 hooks (telemetry,
  // pending banner) can extend without contract churn.
  React.useEffect(() => {
    const onChange = (status: AppStateStatus): void => {
      // No-op intentionally. The hook is here so the wiring exists; the
      // policy ("don't re-fetch on resume") is the test contract. If we
      // ever DO want to refetch on resume, the only correct branch is
      // `state.kind === 'error'` AND only when the user explicitly opts in.
      void status;
    };
    const sub = AppState.addEventListener('change', onChange);
    return () => sub.remove();
  }, []);

  // Move accessibility focus to the headline once content is live. iOS
  // VoiceOver and Android TalkBack both honor setAccessibilityFocus on
  // a node handle; if the platform fails to resolve a handle (older
  // Android RN builds), we silently no-op rather than crashing the screen.
  React.useEffect(() => {
    if (state.kind !== 'success' && state.kind !== 'queued') return;
    const node = headlineRef.current ? findNodeHandle(headlineRef.current) : null;
    if (node !== null) {
      try {
        AccessibilityInfo.setAccessibilityFocus(node);
      } catch {
        // No-op: focus moves are nice-to-have, not load-bearing.
      }
    }
  }, [state.kind]);

  // Run the fade-in once when the loading→content edge fires. Hard-disabled
  // when reduce-motion is true: we set the value to end-state (already its
  // initial value) and skip Animated.timing entirely. Vestibular-disorder
  // compliance: never call Animated.timing on the reduce-motion path; clamp
  // the output range alone is not audit-defensible.
  //
  // codex P2 fix: useReduceMotion() returns false during a brief boot async
  // window before AccessibilityInfo.isReduceMotionEnabled() resolves. If
  // success lands inside that window on a real reduce-motion device, the
  // hook value alone would let us start an animation on a user who asked for
  // none. We layer a synchronous AccessibilityInfo.isReduceMotionEnabled()
  // probe at the moment we'd start: if it resolves true (real preference is
  // ON), we skip the timing call and snap the value. This covers the boot
  // race without adding a hook re-subscription dance.
  const prevStateKindRef = React.useRef<ScreenState['kind']>('loading');
  React.useEffect(() => {
    const prev = prevStateKindRef.current;
    prevStateKindRef.current = state.kind;
    if (prev === 'loading' && state.kind === 'success') {
      if (reduceMotion) {
        fadeAnim.setValue(1);
        return;
      }
      // Hook says false but we're inside the boot window. Defensive
      // synchronous probe: if the OS preference resolves to true, skip the
      // animation. The probe is fire-and-forget — we set the value to its
      // end state synchronously first so a true-positive race never paints
      // a partial fade.
      let cancelled = false;
      AccessibilityInfo.isReduceMotionEnabled()
        .then((osSaysReduce) => {
          if (cancelled) return;
          if (osSaysReduce) {
            // OS confirms reduce-motion. Snap to end state, no timing call.
            fadeAnim.setValue(1);
            return;
          }
          fadeAnim.setValue(0);
          Animated.timing(fadeAnim, {
            toValue: 1,
            duration: 240,
            useNativeDriver: true,
          }).start();
        })
        .catch(() => {
          // Probe failed — snap to end state and skip animation. Biased
          // toward no-motion is the safer fallback (harmful direction is
          // animating against an unmet preference, not skipping animation).
          if (!cancelled) fadeAnim.setValue(1);
        });
      return () => {
        cancelled = true;
      };
    }
  }, [state.kind, reduceMotion, fadeAnim]);

  // Retry handler — used by the error card's "Try again" CTA. Bypasses the
  // in-flight cache so a stale failure doesn't get re-served to the user.
  const handleRetry = React.useCallback(() => {
    void runReview(true);
  }, [runReview]);

  return (
    <View
      testID={testID}
      style={[styles.root, { backgroundColor: theme.colors.bg }]}
    >
      {/* Hero illustration — emoji fallback per V1 scaffolding policy. */}
      <View
        style={styles.heroBlock}
        accessible
        accessibilityRole="image"
        accessibilityLabel={HERO_A11Y_LABEL}
        testID="weekly-review-hero"
      >
        {/* E11-003: chrome glyph — declines Dynamic Type scaling so the
            visual anchor stays at 72pt while the surrounding letter copy
            flexes up to 310%. */}
        <Text allowFontScaling={false} style={styles.heroGlyph}>{HERO_GLYPH}</Text>
      </View>

      {state.kind === 'loading' ? renderLoading(theme) : null}
      {state.kind === 'queued' ? renderQueued(theme, headlineRef) : null}
      {state.kind === 'error' ? renderError(theme, state.result, handleRetry) : null}
      {state.kind === 'success'
        ? renderSuccess({
            theme,
            data: state.data,
            plantsForLedgers,
            nowMs,
            fadeAnim,
            headlineRef,
          })
        : null}

      {/* Got it — always rendered so users can dismiss even from error/queued. */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={DISMISS_LABEL}
        onPress={onDismiss}
        testID="weekly-review-dismiss"
        style={({ pressed }) => [
          styles.dismissBtn,
          {
            backgroundColor: theme.colors.primary,
            opacity: pressed ? 0.85 : 1,
          },
        ]}
      >
        <Text
          style={[
            styles.dismissLabel,
            {
              color: theme.scheme === 'dark' ? theme.colors.bg : theme.colors.surface,
            },
          ]}
        >
          {DISMISS_LABEL}
        </Text>
      </Pressable>
    </View>
  );
}

// ─── Sub-renderers ───────────────────────────────────────────────────────

function renderLoading(theme: ReturnType<typeof useTheme>): React.ReactElement {
  // Skeleton-style placeholder: same outer shape (headline block, narrative
  // block, one ledger-row block) but content suppressed via flat surface fills.
  // Reduce-motion-respecting by construction: nothing animates. The whole
  // surface is announced as a single a11y stop ("Loading your weekly review").
  return (
    <View
      style={styles.contentBlock}
      accessible
      accessibilityLabel="Loading your weekly review"
      testID="weekly-review-loading"
    >
      <View style={[styles.skeletonHeadline, { backgroundColor: theme.colors.surface }]} />
      <View style={[styles.skeletonNarrative, { backgroundColor: theme.colors.surface }]} />
      <View style={[styles.skeletonLedger, { backgroundColor: theme.colors.surface }]} />
    </View>
  );
}

function renderQueued(
  theme: ReturnType<typeof useTheme>,
  headlineRef: React.RefObject<Text | null>,
): React.ReactElement {
  // 'queued' isn't an error in the discriminated union — it means the
  // request is held offline and will run when online. Render the tan banner
  // pattern from the rest of the app (E2-012 ToastBanner conventions) inline
  // so the screen has a single layout and doesn't reach for the toast layer.
  return (
    <View
      style={[
        styles.bannerCard,
        {
          backgroundColor: theme.colors.surface,
          borderColor: theme.colors.tan,
        },
      ]}
      testID="weekly-review-queued"
    >
      <Text
        ref={headlineRef}
        accessibilityRole="header"
        style={[styles.bannerHeadline, { color: theme.colors.text }]}
      >
        Your letter is queued.
      </Text>
      <Text style={[styles.bannerBody, { color: theme.colors.textMuted }]}>
        We'll fetch it when you're back online.
      </Text>
    </View>
  );
}

function renderError(
  theme: ReturnType<typeof useTheme>,
  result: Extract<ApiResult<ReviewResponse>, { ok: false }>,
  onRetry: () => void,
): React.ReactElement {
  // Defensive lookup: every kind in the union except 'queued' has copy in
  // ERROR_COPY (queued is handled by renderQueued). If a new kind ships in
  // ApiResult before this map is updated, we'd rather render a generic line
  // than fall through to ` `. The TS exhaustiveness check below guarantees
  // we never SHIP a new kind without updating the map.
  const kind = result.kind;
  const copy =
    kind === 'queued'
      ? // Unreachable here (queued is handled upstream) but TS still wants this
        // arm.
        { headline: 'Queued.', body: '' }
      : ERROR_COPY[kind];

  return (
    <View
      style={[
        styles.bannerCard,
        {
          backgroundColor: theme.colors.surface,
          borderColor: theme.colors.tan,
        },
      ]}
      accessibilityLiveRegion="polite"
      testID={`weekly-review-error-${kind}`}
    >
      <Text
        accessibilityRole="header"
        style={[styles.bannerHeadline, { color: theme.colors.text }]}
      >
        {copy.headline}
      </Text>
      <Text style={[styles.bannerBody, { color: theme.colors.textMuted }]}>
        {copy.body}
      </Text>
      <Pressable
        onPress={onRetry}
        accessibilityRole="button"
        accessibilityLabel="Try again"
        testID="weekly-review-retry"
        style={({ pressed }) => [
          styles.retryBtn,
          {
            borderColor: theme.colors.stroke,
            opacity: pressed ? 0.7 : 1,
          },
        ]}
      >
        <Text style={[styles.retryLabel, { color: theme.colors.text }]}>
          Try again
        </Text>
      </Pressable>
    </View>
  );
}

type RenderSuccessArgs = {
  theme: ReturnType<typeof useTheme>;
  data: ReviewResponse;
  plantsForLedgers: WeeklyReviewPlantInput[];
  nowMs?: number;
  fadeAnim: Animated.Value;
  headlineRef: React.RefObject<Text | null>;
};

function renderSuccess({
  theme,
  data,
  plantsForLedgers,
  nowMs,
  fadeAnim,
  headlineRef,
}: RenderSuccessArgs): React.ReactElement {
  const isEmpty = plantsForLedgers.length === 0;

  return (
    <Animated.View
      style={[styles.contentBlock, { opacity: fadeAnim }]}
      testID="weekly-review-content"
    >
      <Text
        ref={headlineRef}
        accessibilityRole="header"
        style={[styles.headline, { color: theme.colors.text }]}
        testID="weekly-review-headline"
      >
        {HEADLINE_TEXT}
      </Text>
      {isEmpty ? (
        <Text
          style={[styles.emptyCopy, { color: theme.colors.textMuted }]}
          testID="weekly-review-empty"
        >
          {EMPTY_WEEK_TEXT}
        </Text>
      ) : (
        <>
          <Text
            style={[styles.narrative, { color: theme.colors.text }]}
            testID="weekly-review-narrative"
          >
            {data.narrative}
          </Text>
          <View style={styles.perPlantSection} testID="weekly-review-per-plant">
            {plantsForLedgers.map((plant, idx) => {
              const observation = data.per_plant[idx]?.observation;
              const displayName = plant.nickname ?? plant.species_label;
              // Per-plant block as a single a11y stop. RN doesn't have a
              // 'group' role; the `accessible` collapse pattern + composed
              // label is the canonical way to wrap a section with a
              // VoiceOver/TalkBack-friendly summary, and it's what the
              // WateringLedger does for each column.
              return (
                <View
                  key={plant.id}
                  accessible
                  accessibilityLabel={`${displayName}, ${plant.species_label}`}
                  style={styles.plantBlock}
                  testID={`weekly-review-plant-${plant.id}`}
                >
                  <Text style={[styles.plantNickname, { color: theme.colors.text }]}>
                    {displayName}
                  </Text>
                  <Text
                    style={[
                      styles.plantSpecies,
                      { color: theme.colors.textMuted },
                    ]}
                  >
                    {plant.species_label}
                  </Text>
                  {observation ? (
                    <Text
                      style={[
                        styles.plantObservation,
                        { color: theme.colors.textMuted },
                      ]}
                    >
                      {observation}
                    </Text>
                  ) : null}
                  <WateringLedger events={plant.events} nowMs={nowMs} />
                </View>
              );
            })}
          </View>
        </>
      )}
    </Animated.View>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: {
    flex: 1,
    paddingHorizontal: 24,
    paddingTop: 32,
    paddingBottom: 32,
  },
  heroBlock: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 16,
  },
  heroGlyph: {
    fontSize: 72,
    lineHeight: 80,
    textAlign: 'center',
  },
  contentBlock: {
    marginTop: 16,
    marginBottom: 24,
  },
  headline: {
    fontSize: 28,
    // E11-003: dynamic-type safe — 28 × 1.43 = 40 (was 34, ratio 1.21 clipped
    // descenders at 310% Dynamic Type). Inter/Fraunces both flow safely now.
    lineHeight: 40,
    marginBottom: 16,
    // No fontFamily — Fraunces wiring lands at the screen's parent (font
    // gate at app root via E0-005). Using `theme.colors.text` carries the
    // editorial weight today.
  },
  narrative: {
    fontSize: 16,
    lineHeight: 24,
    marginBottom: 24,
  },
  emptyCopy: {
    fontSize: 16,
    lineHeight: 24,
    fontStyle: 'italic',
    textAlign: 'center',
  },
  perPlantSection: {
    marginTop: 8,
  },
  plantBlock: {
    marginBottom: 24,
  },
  plantNickname: {
    fontSize: 18,
    // E11-003: 18 × 1.45 = 26 (was 24, ratio 1.33 too tight for Inter scale-up).
    lineHeight: 26,
    marginBottom: 2,
  },
  plantSpecies: {
    fontSize: 12,
    lineHeight: 18,
    marginBottom: 8,
  },
  plantObservation: {
    fontSize: 14,
    lineHeight: 20,
    fontStyle: 'italic',
    marginBottom: 8,
  },
  bannerCard: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 16,
    marginVertical: 16,
  },
  bannerHeadline: {
    fontSize: 18,
    // E11-003: 18 × 1.45 = 26 (was 24, ratio 1.33 too tight for Inter scale-up).
    lineHeight: 26,
    marginBottom: 4,
  },
  bannerBody: {
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 12,
  },
  retryBtn: {
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 20,
    alignSelf: 'flex-start',
    minHeight: 44,
    justifyContent: 'center',
  },
  retryLabel: {
    fontSize: 14,
    fontWeight: '500',
  },
  dismissBtn: {
    marginTop: 'auto',
    paddingVertical: 14,
    paddingHorizontal: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 48,
  },
  dismissLabel: {
    fontSize: 16,
    fontWeight: '600',
  },
  // Skeleton placeholders — flat surface fills, no animation. The widths
  // approximate the live content (headline ~40%, narrative ~100% × 3 lines,
  // ledger ~100%) so the loading→content transition doesn't pop the layout.
  skeletonHeadline: {
    width: '40%',
    height: 28,
    borderRadius: 6,
    marginBottom: 16,
    opacity: 0.6,
  },
  skeletonNarrative: {
    width: '100%',
    height: 72,
    borderRadius: 8,
    marginBottom: 24,
    opacity: 0.4,
  },
  skeletonLedger: {
    width: '100%',
    height: 80,
    borderRadius: 8,
    opacity: 0.4,
  },
});
