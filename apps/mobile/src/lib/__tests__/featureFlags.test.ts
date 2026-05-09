/**
 * Feature flag tests (E4-007).
 *
 * Locks the V1 contract:
 *   - `FEATURE_FLAGS.addNote` defaults to `false` (E8-004 will flip).
 *   - `isFeatureEnabled('addNote')` returns the constant value.
 *   - `isFeatureEnabled` rejects unknown keys at compile time
 *     (`// @ts-expect-error` — guards the type-narrowing helper).
 *
 * The default-false test exists specifically to trip if a future PR (NOT
 * E8-004) accidentally flips the default. E8-004 will edit BOTH this test
 * AND `featureFlags.ts` in one diff so the assertion follows the flip.
 */
import {
  FEATURE_FLAGS,
  isFeatureEnabled,
  type FeatureFlagKey,
} from '../featureFlags';

describe('FEATURE_FLAGS', () => {
  it('addNote defaults to false (E4-007 contract — E8-004 flips it)', () => {
    // Asserted at the constant level so a config drift trips here even if
    // every consumer was migrated to read via the helper.
    expect(FEATURE_FLAGS.addNote).toBe(false);
  });

  it('every flag value is a boolean (no string variants, no payloads in V1)', () => {
    // Locks the V1 scope: flags are booleans, period. A future PR that adds
    // a string-variant or shape-shifting flag has to widen this assertion
    // (and explain why), keeping the surface small by default.
    for (const value of Object.values(FEATURE_FLAGS)) {
      expect(typeof value).toBe('boolean');
    }
  });
});

describe('isFeatureEnabled', () => {
  it('returns the current value of a known flag (false today)', () => {
    expect(isFeatureEnabled('addNote')).toBe(false);
  });

  it('returns the same value as a direct constant read for known keys', () => {
    // Round-trip pin: helper and direct read must agree, otherwise the
    // helper would be hiding a divergence and consumers reading via the
    // helper would diverge from tests asserting the constant.
    const keys = Object.keys(FEATURE_FLAGS) as FeatureFlagKey[];
    for (const key of keys) {
      expect(isFeatureEnabled(key)).toBe(FEATURE_FLAGS[key]);
    }
  });

  it('rejects unknown keys at compile time (type-level test)', () => {
    // The body of this test is the @ts-expect-error directive — if the
    // signature ever loosens to `(key: string) => boolean`, the error
    // disappears and the directive itself becomes a compile error,
    // tripping the type-checker. That is the locking mechanism.
    //
    // We DON'T expect the runtime call to throw — `FEATURE_FLAGS['nope']`
    // is just `undefined` in JS — but the TYPE error is what guards the
    // contract. Wrap in a function so the unused expression doesn't get
    // optimized out before tsc sees it.
    const probe = () =>
      // @ts-expect-error — 'notAFlag' is not a FeatureFlagKey
      isFeatureEnabled('notAFlag');
    // Ensure the function exists at runtime — proves the @ts-expect-error
    // line is reachable code, not stripped by the bundler.
    expect(typeof probe).toBe('function');
  });
});
