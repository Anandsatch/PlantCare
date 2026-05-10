/**
 * Mobile-side V1 constants. Keep this file tiny and type-pure (no imports
 * from app modules) so any layer can read a constant without dragging the
 * dependency graph along.
 */

/**
 * Daily LLM call budget. Counts cross-endpoint inserts into `llm_calls`
 * (identify / diagnose / consult / review) within a UTC day. The master
 * plan locks the budget to a client-side SQLite counter — there is NO
 * `/api/budget` endpoint and NO KV-backed budget; see WORKBACK.md cross-
 * cutting note (line 590) and the master plan's "free → escalate router"
 * section. The number 50 mirrors the OpenRouter free-tier daily quota
 * the master plan calls out for V1 dogfooding.
 *
 * UTC-day math, not calendar-day math. The budget meter and any future
 * 40+/50+ banner (E11-006) round the day boundary on `Math.floor(nowMs /
 * 86_400_000) * 86_400_000`. NO date-fns / dayjs / luxon / Temporal — UTC
 * ms only (project-wide lock; same as the watering engine's E4-002 DST
 * critical regression).
 */
export const LLM_DAILY_LIMIT = 50;

/**
 * Soft warning threshold. When `used >= LLM_BUDGET_LOW_THRESHOLD` the
 * Plants list mounts a tan `<ToastBanner type='warn'>` ("Approaching daily
 * limit — N/50 used today"). Below the threshold the banner is unmounted
 * (returns null). The banner is informational only — CTAs remain enabled
 * up through `used = 49`.
 *
 * 40 mirrors the master plan's "approaching daily limit" point — at 80% of
 * `LLM_DAILY_LIMIT` we still want the user to be able to fire 10 more
 * calls before the hard gate (`LLM_BUDGET_HARD_THRESHOLD`) clamps shut.
 *
 * E11-006 lock: this value is exported here (not buried in the banner
 * file) so the banner copy + the test harness + any future analytics
 * emitter all read from one source of truth. No date math, no calendar
 * walking — same UTC-ms regime as the rest of the budget surface.
 */
export const LLM_BUDGET_LOW_THRESHOLD = 40;

/**
 * Hard disable threshold. When `used >= LLM_BUDGET_HARD_THRESHOLD` every
 * LLM-firing CTA in the app passes through `useLlmBudgetGate()` and
 * receives `disabled = true`. Specifically:
 *
 *   - the bottom-right FAB (camera in identify mode)
 *   - the popover "Quick diagnose" item
 *   - AddNoteSheet's "Save & analyze" CTA
 *
 * The banner stays mounted at `>= 50` (it was already mounted at `>= 40`).
 * Tapping a disabled CTA shows the same banner — there is no second
 * "limit reached" surface in V1.
 *
 * The threshold is exactly `LLM_DAILY_LIMIT` because the OpenRouter free-
 * tier quota is 50/day. Allowing the 51st call would burn a paid-router
 * escalation (the master plan's "free → escalate router") without the
 * user understanding that a soft cap had been crossed. Hard-stop at 50.
 *
 * Note: the gate uses `>=`, not `===`. A 51st row landing in the table
 * (e.g. via a follow-up SyncDrainer terminal-success while the gate is
 * in the loading state and a stale read advanced past 50) MUST also be
 * disabled — `===` would silently re-enable CTAs at exactly 51.
 */
export const LLM_BUDGET_HARD_THRESHOLD = LLM_DAILY_LIMIT;

/**
 * One UTC day in milliseconds. Exported so the hook + any future caller
 * shares a single literal — a typo on either side would silently desync
 * the rollover.
 */
export const ONE_UTC_DAY_MS = 86_400_000;

/**
 * Floor `nowMs` to the start of the UTC day it falls in. Pure, side-
 * effect-free, allocation-free. The hook uses this to compute the
 * `called_at_ms >= startOfTodayUtcMs(now)` predicate; tests use it to
 * pin rollover-at-midnight assertions without re-deriving the math.
 *
 * This is deliberately UTC-day, not local-day. The budget number maps to
 * an OpenRouter quota that resets at UTC midnight, so a "todayLocal"
 * window would either over-count (allowing 100 across a UTC midnight
 * roll) or under-count (cutting the user off early in some timezones)
 * relative to the real upstream. See WORKBACK.md and master plan §
 * "free → escalate router".
 */
export function startOfTodayUtcMs(nowMs: number): number {
  return Math.floor(nowMs / ONE_UTC_DAY_MS) * ONE_UTC_DAY_MS;
}
