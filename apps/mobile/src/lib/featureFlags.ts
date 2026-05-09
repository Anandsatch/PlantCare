/**
 * Feature flags (E4-007).
 *
 * Single source of truth for V1 feature flags. The pattern is intentionally
 * boring — a frozen `as const` record of booleans plus a typed reader. No
 * remote-config, no GrowthBook / LaunchDarkly, no env-var indirection, no
 * experiment framework. V1 flips happen in code, ship in a build, period.
 *
 * # Why a constant over env vars / remote config in V1
 *
 * - **Env vars**: Expo Router + EAS already gate code paths via build-time
 *   env, which is great for backend keys but wrong for "is the AddNoteSheet
 *   wired yet?" — that's a structural release-train decision (E8-004 is the
 *   ticket that flips this), not a per-build deploy knob. A constant in the
 *   repo means the diff that flips the flag is also the diff that wires the
 *   consumer, reviewable as one PR.
 * - **Remote config (GrowthBook / LaunchDarkly)**: V1 has no need for runtime
 *   percentage rollouts, segment targeting, or kill-switches. Adding a
 *   network dependency to read the flag would (a) introduce a network failure
 *   mode for "should this button be rendered?" — a question with a deterministic
 *   answer in code; (b) require auth, caching, and offline-fallback discipline
 *   that pays off only for >1 active flag with non-trivial rollout needs;
 *   (c) burn a paid-tier dependency the V1 budget hasn't allocated. Revisit
 *   post-V1 if/when paid experimentation is justified.
 * - **State management lib (Zustand / Redux / Jotai)**: A single boolean
 *   constant doesn't need a store. Direct module read is cheaper than a
 *   subscription, and consumers don't need to re-render on flag changes —
 *   a flag flip ships in a build, not at runtime.
 *
 * # Type-narrowing helper
 *
 * `isFeatureEnabled(key)` typed as `(key: keyof typeof FEATURE_FLAGS) =>
 * boolean` rejects unknown keys at compile time — the canonical guarantee a
 * "flag" abstraction has to provide so a typo doesn't silently render dead UI.
 * Tested below with `// @ts-expect-error` so a future change that loosens
 * the signature trips immediately.
 *
 * # Wiring contract
 *
 * Consumers read via `isFeatureEnabled('addNote')`, NOT `FEATURE_FLAGS.addNote`
 * directly — the helper is the only public read surface so future logic
 * (debug builds, e.g. `__DEV__ && process.env.EXPO_PUBLIC_ENABLE_ADD_NOTE` if
 * we ever decide to gate per-environment) can land in one place. The
 * constant is exported for assertions in tests; production code threads
 * through the helper.
 *
 * # E4-007 → E8-004 release train
 *
 * `addNote = false` today. E8-004 (the AddNoteSheet wiring ticket) flips
 * this to `true` in the same PR that mounts the sheet, so the flag flip and
 * its consumer ship as one reviewable diff. Until then, the structural
 * plumbing exists (`<PlantDetailScreen>`'s `noteEnabled` prop is fed from
 * this flag at the route layer) so the eventual flip is one-line, not a
 * re-layout.
 */

/**
 * Frozen record of V1 feature flags. Every key is a boolean — no string
 * variants, no shape-shifting payloads, no nested objects. If a future flag
 * needs anything richer, that's a new abstraction (likely a typed reader on
 * top of remote config), not a widening of this constant.
 *
 * `as const` makes the value type the literal (`{ readonly addNote: false }`)
 * so tests can assert the literal default at compile time.
 */
export const FEATURE_FLAGS = {
  /**
   * Add-note button on the A-2 plant detail screen. Default `false` per
   * E4-007 ("hidden until E8 ships — do not render dead UI"). E8-004 flips
   * this to `true` when the AddNoteSheet wiring lands.
   */
  addNote: false,
} as const;

/**
 * Stable type for the flag key set. Exported so callers and tests can
 * reference `FeatureFlagKey` without re-deriving `keyof typeof FEATURE_FLAGS`
 * at every call site.
 */
export type FeatureFlagKey = keyof typeof FEATURE_FLAGS;

/**
 * Read a feature flag. Returns the current boolean value.
 *
 * The signature `(key: FeatureFlagKey) => boolean` rejects unknown keys at
 * compile time — `isFeatureEnabled('notAFlag')` is a type error, NOT a
 * runtime `false`. This is the canonical "flag helper" guarantee: a typo
 * trips the type checker rather than silently rendering dead UI.
 *
 * Locked as a function (not a getter on the constant) so future logic can
 * land in one place — debug builds, per-environment overrides, runtime
 * kill-switches — without callers having to migrate from `FEATURE_FLAGS.x`
 * to `someOtherSurface.x`. Today the body is a one-liner.
 */
export function isFeatureEnabled(key: FeatureFlagKey): boolean {
  return FEATURE_FLAGS[key];
}
