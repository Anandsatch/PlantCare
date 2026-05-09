/**
 * `useLlmBudgetGate()` — gate helper for LLM-firing CTAs (E11-006).
 *
 * Composes `useLlmBudget()` and surfaces a single boolean
 * (`disabled`) plus the remaining quota. Every CTA in the app that
 * fires an LLM call passes through this hook:
 *
 *   - FAB tap (camera in identify mode)
 *   - "Quick diagnose" popover item
 *   - AddNoteSheet's "Save & analyze" CTA
 *
 * # Why a separate hook (not a screen-local boolean)
 *
 * Three CTAs across two screens + one sheet need to read the same gate.
 * Inlining the threshold check at each call site would (a) duplicate the
 * `>=` logic three places (codex risk #2: somebody writes `===` somewhere
 * and a 51st row silently re-enables the CTAs), (b) make a future
 * threshold change touch three files, and (c) tangle the budget hook's
 * status lifecycle into every gated component. Centralizing here means
 * one source of truth, one place to test the boundary.
 *
 * # disabled semantics (locked)
 *
 *   - `disabled = true`   when `status === 'ready'` AND `used >= 50`
 *   - `disabled = false`  in every other case, including `'idle'` and
 *                         `'loading'`
 *
 * Why default-enabled while the read is in flight: the user's first tap
 * after launch shouldn't be silently rejected by a phantom gate that
 * hasn't proven 50 calls have happened. The cost of one over-fire while
 * loading is one extra LLM call (≈1¢ at the free-tier escalation rate);
 * the cost of default-disabled is a frustrating "the app feels broken"
 * tap that the user has no signal to recover from.
 *
 * # remaining semantics
 *
 *   - `remaining = max(0, LLM_DAILY_LIMIT - used)` when status='ready'
 *   - `remaining = LLM_DAILY_LIMIT` while loading (no over-promise; no
 *     under-promise either — we don't know yet, default to "lots left")
 *
 * # refresh()
 *
 * Forwards to `useLlmBudget`'s `refresh`. Useful after a CTA fires its
 * LLM call: the call site does `await consult(...); recordLlmCall(...);
 * gate.refresh();` so the meter + gate update without waiting for the
 * AppState resume listener. The hook's underlying call-counter still
 * drops stale reads, so a refresh issued mid-fire doesn't race a
 * subsequent insertion.
 *
 * # V1 scope locks
 *
 *   - DO NOT add an "X tomorrow at midnight UTC" countdown — copy
 *     ("Resets at midnight UTC") is enough; a rolling clock would be a
 *     decorative blob the master plan rejects.
 *   - DO NOT cache `disabled` in module state — every gated CTA reads
 *     it from the hook so a refresh propagates uniformly.
 *   - DO NOT add a hysteresis (e.g. require 2 consecutive reads above
 *     50 before flipping). One read is enough; the hook's race guard
 *     already prevents stale reads from committing.
 *   - DO NOT add a feature flag — the gate is the same in dev + prod.
 */
import { LLM_BUDGET_HARD_THRESHOLD, LLM_DAILY_LIMIT } from '../lib/constants';
import {
  useLlmBudget,
  type UseLlmBudgetConfig,
  type UseLlmBudgetReturn,
} from './useLlmBudget';

export interface UseLlmBudgetGateReturn {
  /** True when the daily limit is reached. False while loading or below. */
  disabled: boolean;
  /** `LLM_DAILY_LIMIT - used`, clamped to >= 0. Defaults to the limit while loading. */
  remaining: number;
  /** Re-query the count. Forwarded from `useLlmBudget`. */
  refresh: UseLlmBudgetReturn['refresh'];
  /** The raw budget read, exposed for callers that want to render the meter copy. */
  used: number;
  /** `LLM_DAILY_LIMIT`. Pass-through for ergonomics. */
  limit: number;
  /** Lifecycle status from `useLlmBudget` — `'idle' | 'loading' | 'ready'`. */
  status: UseLlmBudgetReturn['status'];
}

/**
 * Reads the live LLM-call count and surfaces a gate boolean. Same `db`
 * + `now` injection as `useLlmBudget` (this hook is a thin
 * specialization — it does NOT duplicate the SQLite read).
 */
export function useLlmBudgetGate(
  config: UseLlmBudgetConfig,
): UseLlmBudgetGateReturn {
  const budget = useLlmBudget(config);

  // Default-enabled until the read proves we crossed the threshold.
  // See file header for the "loading default-enabled" rationale.
  const disabled =
    budget.status === 'ready' && budget.used >= LLM_BUDGET_HARD_THRESHOLD;

  const remaining =
    budget.status === 'ready'
      ? Math.max(0, LLM_DAILY_LIMIT - budget.used)
      : LLM_DAILY_LIMIT;

  return {
    disabled,
    remaining,
    refresh: budget.refresh,
    used: budget.used,
    limit: budget.limit,
    status: budget.status,
  };
}
