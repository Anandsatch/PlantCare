/**
 * `<BudgetBanner>` — Plants list 40+ / 50+ banner (E11-006).
 *
 * Renders a `<ToastBanner type='warn'>` with copy that switches at the
 * hard threshold:
 *
 *   - `40 <= used < 50` → "Approaching daily limit — N/50 used today."
 *   - `used >= 50`      → "Daily LLM limit reached. Resets at midnight UTC."
 *
 * Below 40 → returns `null` (banner unmounted entirely).
 *
 * # Why one banner, two copies (not two banner variants)
 *
 * The DESIGN.md "warn" surface is one token — tan accent surface, fixed
 * deep ink (`#2A2A2A`) regardless of theme. Inventing a second variant
 * for the hard-limit state would (a) create a token nobody asked for
 * and (b) churn the ToastBanner primitive's surface for one screen's
 * use. Same primitive, same colors, content swap by threshold.
 *
 * # Reduce-motion (E10-001 / E9-003 lesson)
 *
 * The ToastBanner primitive's `'warn'` variant has NO entry animation
 * — `pulseOpacity` is initialized at end-state (1.0) and only the
 * `'pending'` variant fires `Animated.timing`. That means there's no
 * mount-time fade-in that needs reduce-motion gating here either: the
 * banner snaps in. The `useReduceMotion()` honor is structural in the
 * primitive; this wrapper doesn't add any motion of its own.
 *
 * # Auto-dismiss
 *
 * The banner is PERSISTENT — `autoDismissMs={0}`. The default for
 * `'warn'` is 4000ms (transient errors), but the budget banner's
 * lifetime is tied to the meter, not a one-shot event: once mounted at
 * `>=40`, it stays mounted until the count drops back below 40 (only
 * happens at UTC midnight rollover — the AppState 'active' listener
 * inside `useLlmBudget` re-queries and the parent's `>=40` gate
 * unmounts the banner).
 *
 * # A11y
 *
 * - `accessibilityRole='alert'` (set by ToastBanner's `'warn'` mapping).
 * - On Android, `accessibilityLiveRegion='assertive'` (also from the
 *   primitive). Meaning: VoiceOver / TalkBack announces the banner the
 *   first time it appears. Re-announce on copy change (40+ → 50+) is
 *   driven by ToastBanner's `useEffect([type, message, ...])` — a new
 *   message identity restarts the auto-dismiss timer and re-announces.
 *
 * # V1 scope locks
 *
 *   - DO NOT use `theme.colors.text` — Wave 2 E10-001 codex catch: tan
 *     surface is theme-invariant, the deep ink is fixed at #2A2A2A.
 *     The ToastBanner primitive enforces this internally.
 *   - DO NOT add an "X tomorrow" countdown — copy is enough.
 *   - DO NOT add a swipe-to-dismiss — the banner is persistent for a
 *     reason (the gate is still on; dismissing the banner would hide
 *     the cause).
 *   - DO NOT add a "Tap for details" affordance — the copy is the detail.
 *   - DO NOT add a notification on threshold cross — banner-only UX.
 */
import {
  LLM_BUDGET_HARD_THRESHOLD,
  LLM_BUDGET_LOW_THRESHOLD,
  LLM_DAILY_LIMIT,
} from '../lib/constants';
import { ToastBanner } from './primitives';

export interface BudgetBannerProps {
  /** Live LLM-call count from `useLlmBudget()`. */
  readonly used: number;
  /** Daily limit (`LLM_DAILY_LIMIT`). Pass-through for copy formatting. */
  readonly limit?: number;
  readonly testID?: string;
}

/**
 * Compute the banner copy. Pure — exported for tests so the boundary
 * (39 → null, 40 → "approaching", 49 → "approaching", 50 → "reached",
 * 51 → "reached") is asserted independently of the React tree.
 */
export function resolveBudgetBannerCopy(
  used: number,
  limit: number = LLM_DAILY_LIMIT,
): string | null {
  if (used < LLM_BUDGET_LOW_THRESHOLD) {
    return null;
  }
  if (used >= LLM_BUDGET_HARD_THRESHOLD) {
    return 'Daily LLM limit reached. Resets at midnight UTC.';
  }
  return `Approaching daily limit — ${used}/${limit} used today.`;
}

export function BudgetBanner(props: BudgetBannerProps): JSX.Element | null {
  const { used, limit = LLM_DAILY_LIMIT, testID } = props;

  const message = resolveBudgetBannerCopy(used, limit);
  if (message === null) {
    return null;
  }

  return (
    <ToastBanner
      type="warn"
      message={message}
      // 0 = persistent. The banner stays visible while `used >= 40`;
      // the parent unmounts it (returns null from this component) when
      // the count drops below the low threshold (UTC midnight rollover).
      autoDismissMs={0}
      testID={testID ?? 'budget-banner'}
    />
  );
}
