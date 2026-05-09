/**
 * PlantDetailRoute — flag-aware mount wrapper for `<PlantDetailScreen>` (E4-007).
 *
 * The structural seam between the V1 feature-flag constant and the A-2 detail
 * composite. The route layer (E0-008 will wire Expo Router; today there's no
 * production navigator yet) imports this wrapper, NOT the raw screen, so the
 * `noteEnabled` prop is fed from `isFeatureEnabled('addNote')` in exactly one
 * place. When E8-004 flips the flag to `true`, no route-layer change is
 * needed — the wrapper picks up the new value on next build.
 *
 * # Why a wrapper instead of reading the flag inside `<PlantDetailScreen>`
 *
 * The screen accepts `noteEnabled` as a prop on purpose: the test harness
 * already drives both `false` (E4-007 default — button hidden) and `true`
 * (E8-004 un-hide path) via prop overrides without having to mock the flag
 * module. Pulling the flag read inside the screen would either (a) force
 * every test to mock the flag module to exercise both branches, or (b) leave
 * the screen with a hardcoded read that diverges from the route layer.
 * Keeping the flag read at the call site preserves the screen's pure-prop
 * surface and gives tests a clean seam.
 *
 * # The `onAddNote` coupling
 *
 * `<PlantDetailScreen>` warns in dev when `noteEnabled === true` and
 * `onAddNote` is undefined (codex P2 from E4-005 review). The wrapper
 * accepts `onAddNote` as an optional prop and forwards it unchanged — when
 * E8-004 lands, that ticket adds the AddNoteSheet wiring at the call site
 * that mounts `<PlantDetailRoute>` and threads `onAddNote` here. Until then
 * the prop is omitted; the flag is `false`, the button doesn't render, and
 * the dev-warn doesn't trip.
 *
 * # V1 scope locks (rejected reviewer suggestions)
 *
 * - No `useFeatureFlag()` hook. The flag is build-time-static; a hook would
 *   imply runtime mutability and force consumers into a `useState` /
 *   `useEffect` dance for a value that never changes inside a session.
 * - No prop override for `noteEnabled` on this wrapper. The whole point is
 *   that the route layer doesn't make per-mount flag decisions — the flag
 *   is the single source of truth. Tests that need to drive the prop
 *   directly mount `<PlantDetailScreen>`, not this wrapper.
 * - No memoization of the flag read. `isFeatureEnabled` is a property
 *   lookup; the optimizer eliminates any pretend cost.
 */
import type { ReactElement } from 'react';

import { isFeatureEnabled } from '../lib/featureFlags';
import {
  PlantDetailScreen,
  type PlantDetailScreenProps,
} from './PlantDetailScreen';

/**
 * Props mirror `<PlantDetailScreen>` minus `noteEnabled` — that prop is
 * sourced exclusively from the feature flag at this layer. The route layer
 * (E0-008 / direct deep-link / future tab navigator) calls this with the
 * remaining props; the flag is plumbed in here.
 */
export type PlantDetailRouteProps = Omit<PlantDetailScreenProps, 'noteEnabled'>;

export function PlantDetailRoute(props: PlantDetailRouteProps): ReactElement {
  // Single source of truth for the noteEnabled prop. E8-004 flips
  // `FEATURE_FLAGS.addNote` to `true` in the same PR that wires
  // AddNoteSheet at the parent route, so the flag flip and the
  // `onAddNote` callback land together — no orphan window where the
  // button renders without a working callback.
  const noteEnabled = isFeatureEnabled('addNote');
  return <PlantDetailScreen {...props} noteEnabled={noteEnabled} />;
}
