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
