/**
 * PlantDetailRoute — A-2 plant detail mount + Add-note wiring (E8-004).
 *
 * The structural seam between V1's feature-flag constant (`FEATURE_FLAGS.addNote
 * = false`, locked at the source per E4-007) and the live A-2 detail composite.
 * E4-007 shipped this wrapper as a "read the flag and thread it" stub. E8-004
 * promotes the wrapper into the call site that actually owns the front-door
 * AddNoteSheet wiring: `noteEnabled` is now hard-`true` here, the FAB's
 * "Add note" button mounts `<AddNoteSheet>` on press, and the sheet's `onSave`
 * persists through `usePersistNote(plantId)`.
 *
 * # Why the route layer is the flip seam (not the FEATURE_FLAGS constant)
 *
 * The V1 contract from the brief is explicit: the `FEATURE_FLAGS.addNote`
 * constant stays `false` so the helper test (`featureFlags.test.ts`) keeps
 * pinning the locked default. Flipping the constant to `true` would land
 * the un-hide path on every consumer, but in V1 there's exactly ONE consumer
 * (this wrapper) — and the wrapper is the only place the AddNoteSheet wiring
 * lives. Threading `noteEnabled={true}` here is the single-PR flip:
 *
 *   - Constant stays `false` → `featureFlags.test.ts` and `lib` tests
 *     continue to assert the locked default.
 *   - Wrapper passes `true` directly + mounts the sheet → users get the live
 *     button.
 *   - Production navigator (E0-008 hasn't shipped) imports `<PlantDetailRoute>`,
 *     not `<PlantDetailScreen>`, so this is the only mount path that ships
 *     to users.
 *
 * # Sheet mount lifecycle
 *
 * Local `addNoteOpen: boolean` lives on this wrapper, not on the screen.
 * Press "Add note" → `addNoteOpen=true` → `<AddNoteSheet open={true}>` mounts.
 * `onCancel` (or backdrop / swipe-dismiss) → `addNoteOpen=false` → the sheet
 * conditionally unmounts. `onSave` → persist runs synchronously inside the
 * handler (await) → `addNoteOpen=false`.
 *
 * The conditional-render wrapper (`addNoteOpen && <AddNoteSheet ...>`) is
 * intentional. RN's Modal lifecycle is portal-rooted — leaving it mounted
 * with `open={false}` keeps the Modal in the tree (and its event listeners
 * subscribed). Unmount-on-close keeps the surface area small and matches
 * the EditorialBottomSheet's own state-reset semantics: when `open` flips
 * `true → false`, the sheet's internal cleanup (`useEffect` in
 * AddNoteSheet:226-234) runs once on the closing edge; the next open is a
 * fresh tree.
 *
 * # `usePersistNote(plantId)` is hoisted to the wrapper, not the sheet
 *
 * The sheet is a pure UI surface (E8-003 module header: "This sheet COLLECTS
 * + EMITS. It never writes to SQLite — E8-005 owns the notes table write").
 * Hoisting `usePersistNote` here means the persist hook is mounted with the
 * SAME plant id that the user opened — verified twice over: the hook is
 * called with `plant.id` (which re-binds when the prop changes), AND a
 * session-id snapshot taken at open time guards against a mid-flow plant
 * swap that keeps the route mounted (e.g. a future swipe-between-siblings
 * detail pager).
 *
 * # Two unmount guards (codex P2 from E8-004 review)
 *
 * The sheet's queued/offline path awaits `consult()` then calls onSave from
 * the resolved branch. Two failure modes the wrapper has to defend:
 *   1. Wrapper unmounts (user navigates back) before onSave resolves. The
 *      sheet's Modal portal tears down on the next render cycle, but the
 *      in-flight consult promise still resolves and fires onSave. Without
 *      a `mountedRef` guard the wrapper would still issue `persist(...)`,
 *      writing a zombie row for a screen the user can't see. The
 *      `mountedRef` flips false on unmount; handleSave skips the persist.
 *   2. The route is reused for plant A → plant B without remounting. The
 *      sheet's note text was composed FOR plant A; `usePersistNote(plant.id)`
 *      re-binds when the prop changes, so the closed-over `persist` now
 *      targets plant B. Persisting would write A's note against B's row.
 *      The session-id snapshot (`sessionPlantIdRef`) captures `plant.id`
 *      at sheet-open and refuses persist on mismatch.
 *
 * # Persist input mapping
 *
 * `<AddNoteSheet>` emits `AddNoteSavedPayload`; `usePersistNote` accepts
 * `PersistNoteInput`. The mapper (`payloadToPersistInput`) was exported from
 * the persist hook in E8-005 specifically so this call site is one import:
 * `persist(payloadToPersistInput(payload))`. The wrapper does not transform
 * the payload — it forwards verbatim. The persist layer's `kind` field is
 * the broader `NoteConsultStatus` union (E8-005 brief), so a future "save
 * the user's text even when the LLM declined" wiring drops in without
 * reshaping this site.
 *
 * # E11-006 budget gate (NOT wired in this PR)
 *
 * E11-006 (PR #61, currently open) adds a `budgetGate` prop to
 * `<AddNoteSheet>` that the Save & analyze CTA respects when the user is at
 * the daily LLM cap. As of this PR's branch base
 * (`Anandsatch/v1-wave3b-orchestrator` at v0.1.56.0), AddNoteSheet does NOT
 * yet expose a `budgetGate` prop — wiring one would be ahead of the
 * dependency contract and would force a no-op cast. The wire-up of
 * `budgetGate={useLlmBudgetGate(budgetDb)}` lands as a follow-up commit
 * after PR #61 merges and this branch auto-rebases. Until then this PR
 * stays scoped to the front-door enable.
 *
 * # V1 scope locks (rejected)
 *
 * - **No flipping `FEATURE_FLAGS.addNote` to `true`.** The constant stays
 *   `false`; `featureFlags.test.ts` keeps pinning the locked default. The
 *   route-layer thread is the flip seam, by design.
 * - **No `useFeatureFlag()` hook.** The flag is build-time-static.
 * - **No global state library (zustand/redux/jotai).** Local route state for
 *   `addNoteOpen` is a single boolean.
 * - **No new SQLite migration.** The `notes` table shipped in E2-002.
 * - **No `theme.warn` reference.** The token doesn't exist; AddNoteSheet
 *   uses `theme.colors.tan` per its DESIGN.md cross-check.
 * - **No `date-fns` / `dayjs` / `luxon` / `Temporal`.** UTC ms only.
 * - **No mounting a Modal portal while closed.** Conditional-render the
 *   sheet so the Modal is unmounted between sessions.
 * - **No passing `budgetGate` yet** — see "E11-006 budget gate" above.
 */
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';

import { AddNoteSheet, type AddNoteSavedPayload } from '../components/AddNoteSheet';
import { payloadToPersistInput, usePersistNote } from '../hooks/usePersistNote';
import {
  PlantDetailScreen,
  type PlantDetailScreenProps,
  resolveSpeciesHeadline,
} from './PlantDetailScreen';
import type { ApiClient } from '../api';

/**
 * Props for the route wrapper. Mirrors `<PlantDetailScreen>` MINUS:
 *   - `noteEnabled` — the wrapper passes `true` directly. Removing this
 *     prop from the wrapper API enforces "the route is the flip seam";
 *     a caller that wanted to render the screen with the button hidden
 *     should mount `<PlantDetailScreen>` directly (E4-005's existing tests
 *     cover that path).
 *   - `onAddNote` — the wrapper owns the callback (it opens the local
 *     sheet). Letting a caller override it would defeat the purpose of
 *     hoisting the AddNoteSheet wiring here.
 *
 * PLUS:
 *   - `apiClient` — required, forwarded to `<AddNoteSheet>` for the
 *     `/api/consult` request. The wrapper does not own client construction;
 *     the parent (production navigator → screen tree) injects it so the
 *     same client instance powers every API call this user session makes.
 *   - `netInfo` — optional connectivity probe. Forwarded to `<AddNoteSheet>`
 *     so the offline path coerces to `queued` per E1-003 / useConsultRequest.
 */
export type PlantDetailRouteProps = Omit<
  PlantDetailScreenProps,
  'noteEnabled' | 'onAddNote'
> & {
  /**
   * The api client. Required because the AddNoteSheet's Save & analyze CTA
   * dispatches `/api/consult`. The wrapper does not synthesize a default —
   * a missing client at the call site is a wiring bug that should fail
   * loudly at compile time, not produce a sheet whose Save button silently
   * routes to a stub.
   */
  apiClient: ApiClient;
  /**
   * Connectivity probe. Forwarded to `<AddNoteSheet>` → `useConsultRequest`
   * for offline detection. When omitted, the consult hook treats every
   * request as online (its own default). Optional here so test mounts can
   * skip the probe; production callers should always pass one.
   */
  netInfo?: { isConnected: () => boolean | Promise<boolean> };
};

export function PlantDetailRoute(props: PlantDetailRouteProps): ReactElement {
  const { apiClient, netInfo, ...screenProps } = props;
  const { plant } = screenProps;

  // Local sheet open state. Lives on the wrapper, not the screen, so the
  // screen stays a pure prop surface (E4-005 contract: "The parent owns the
  // data channel and re-renders this screen with new props"). Per-press
  // boolean — no enum / state machine / discriminated union needed for a
  // visibility flip.
  const [addNoteOpen, setAddNoteOpen] = useState(false);

  // Persist hook hoisted to the wrapper so the plant id is captured at the
  // route layer, not at handler-invocation time. The wrapper re-renders
  // when `plant` changes; `usePersistNote(plant.id)` re-binds at that
  // edge. The session-id snapshot below is the additional belt-and-braces
  // for the case where the route is reused for plant A → plant B WITHOUT
  // a remount (e.g. a future shared-element transition that swaps `plant`
  // inside the same route mount).
  const { persist } = usePersistNote(plant.id);

  // Plant id snapshot captured at sheet-open time (codex P2 fix). The
  // sheet's note text was composed FOR the plant the user opened; if the
  // parent swaps `plant` mid-flow without remounting (a navigator that
  // pushes-and-pops the same route, or a future detail-pager that swipes
  // between siblings), persisting against `plant.id` from the latest
  // render would write to the wrong row. The snapshot fences the session.
  // Mismatch → close the sheet and refuse to persist; the user's text is
  // dropped, but a write to the wrong plant is the worse failure mode.
  const sessionPlantIdRef = useRef<string | null>(null);

  // Mounted ref (codex P2 fix). The sheet's queued/offline path awaits
  // `consult()` then calls onSave from inside that resolved branch. If the
  // user navigates back from the screen while consult is pending, the
  // wrapper unmounts, the sheet's Modal portal tears down on the next
  // render cycle, but the in-flight consult promise still resolves and
  // fires onSave. `usePersistNote.mountedRef` gates the hook's own
  // setState calls but does NOT skip the SQL INSERT — so without a guard
  // here, a "navigated away" sheet still writes a row. The mounted flag
  // skips persist after unmount.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Open the sheet. Stable identity via useCallback so a future memoized
  // child (PlantDetailScreen could memoize action handlers) doesn't re-render
  // on every wrapper render. Snapshots the current plant id into the
  // session-id ref so a mid-flow plant swap (see sessionPlantIdRef
  // comment) is detectable in handleSave.
  const handleAddNote = useCallback(() => {
    sessionPlantIdRef.current = plant.id;
    setAddNoteOpen(true);
  }, [plant.id]);

  // Cancel path: backdrop tap, swipe-dismiss, or Cancel CTA. No persist
  // call — just close. AddNoteSheet's own cleanup effect (component:226-234)
  // resets its internal state on the close edge.
  const handleCancel = useCallback(() => {
    setAddNoteOpen(false);
    sessionPlantIdRef.current = null;
  }, []);

  // Save path: the sheet emits the typed payload (recommendation Done OR
  // queued auto-fire). We map → persist → close. Persistence is fire-and-
  // forget from the user's perspective — the close happens immediately so
  // the user isn't held in a sheet while SQLite writes (which finishes in
  // sub-millisecond on local disk).
  //
  // Two guards (codex P2):
  //   - mountedRef: a queued/offline onSave that fires AFTER the route
  //     unmounts skips the SQL INSERT. The user navigated away; their
  //     note is gone. Persisting against an unmounted route would write a
  //     row to a screen the user can't see and a hook tree that's torn
  //     down — a silent zombie row.
  //   - session-id check: if `plant.id` has shifted between sheet-open
  //     and onSave (a route reused for plant A → B without remount), the
  //     onSave is dropped. `usePersistNote(plant.id)` re-binds when
  //     `plant.id` changes, so the closed-over `persist` would target the
  //     NEW plant's id — writing the user's note for plant A against
  //     plant B's row. Refusal is the safe default; future callers that
  //     truly need cross-plant note saves should snapshot earlier.
  const handleSave = useCallback(
    async (payload: AddNoteSavedPayload) => {
      // Close first so the sheet unmounts immediately. The persist promise
      // resolves on a torn-down tree; `usePersistNote.mountedRef` gates
      // the hook's setState so no React warning fires. The actual SQL
      // INSERT still commits because it's issued inside the await.
      setAddNoteOpen(false);
      const sessionId = sessionPlantIdRef.current;
      sessionPlantIdRef.current = null;
      if (!mountedRef.current) return;
      if (sessionId !== plant.id) return;
      await persist(payloadToPersistInput(payload));
    },
    [persist, plant.id],
  );

  return (
    <>
      <PlantDetailScreen
        {...screenProps}
        // E8-004 flip seam: the route layer threads noteEnabled=true
        // directly. FEATURE_FLAGS.addNote stays `false` per E4-007;
        // featureFlags.test.ts keeps pinning the locked default. The
        // un-hide path lives at the route, where the AddNoteSheet wiring
        // lives — single PR, single diff.
        noteEnabled={true}
        onAddNote={handleAddNote}
      />
      {addNoteOpen ? (
        <AddNoteSheet
          open={true}
          onCancel={handleCancel}
          onSave={handleSave}
          apiClient={apiClient}
          {...(netInfo ? { netInfo } : {})}
          {...(plant.nickname ? { plantNickname: plant.nickname } : {})}
          plantSpecies={resolveSpeciesHeadline(plant)}
        />
      ) : null}
    </>
  );
}
