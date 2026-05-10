/**
 * AddNoteSheet — A-2 Add Note flow (E8-003).
 *
 * Composes <EditorialBottomSheet> (E2-011) for the focus-trap +
 * swipe-to-close + reduce-motion-gated transition. Wraps a multi-line
 * <TextInput> + Save & analyze CTA + Cancel CTA. On Save, fires a
 * `useConsultRequest` against /api/consult and forks the rendered phase
 * by the resolved kind.
 *
 * Phases (a small state machine driven by useConsultRequest's status +
 * lastResult — NOT a separate useState, to keep the source of truth in
 * one place):
 *
 *   input        — text input + Save + Cancel. Default phase.
 *   loading      — "Listening…" copy + small inline spinner. Reduce-motion
 *                  gated (the spinner becomes a static dot). Cancel still
 *                  swipe-dismissible; the in-flight request continues but
 *                  its result is discarded by the sheet (the consult hook's
 *                  unmount-safe / reset-safe semantics handle it).
 *   ok           — kind='recommendation' inline reasoning card with a
 *                  forest "Done" CTA → emits onSave({ note, response,
 *                  timestamp }) then closes.
 *   reject       — kind='layer1_reject' OR (rare forward-compat path)
 *                  ok:true with data.kind='rejected_off_topic'. Renders
 *                  the Layer-1 reject editorial card with a "Try again"
 *                  CTA that resets the hook + returns to the input phase
 *                  WITH the note text preserved (kinder default).
 *   low_conf     — kind='low_confidence'. Distinct copy: "Not confident
 *                  in that one — could you add more detail?". Try-again
 *                  preserves note. Reserved per the master plan; not
 *                  emitted by the consult router today, but the union
 *                  fork is wired so future server-side gating doesn't
 *                  need a sheet release.
 *   network      — coerced to queued by the hook. Renders pending toast
 *                  copy + emits onSave with a queued response so the
 *                  parent (E8-005) can persist with consult_status='pending'.
 *   timeout      — distinct error card; Try again retries.
 *   server       — distinct error card; Try again retries (retry_after
 *                  surfaced if present).
 *   parse_error  — distinct error card; Try again retries.
 *   queued       — pending toast copy.
 *
 * Persistence boundary:
 *   This sheet COLLECTS + EMITS. It never writes to SQLite — E8-005 owns
 *   the `notes` table write. On a successful consult, onSave receives the
 *   note (trimmed) + the LLM response + a timestamp. The parent decides
 *   what to do with it. On a queued result, onSave still fires with a
 *   discriminated payload so the parent can persist a pending row that
 *   E7's drainer will resolve later.
 *
 * V1 scope locks honored:
 *   - No @gorhom/bottom-sheet — the E2-011 PanResponder primitive is the
 *     V1 lock. We compose it; we do not replace it.
 *   - No date-fns / dayjs / luxon. `Date.now()` is sufficient for the
 *     onSave timestamp; relative-date formatting (if ever needed) is
 *     already in PhotoTimeline's formatRelativeDate helper.
 *   - No SQLite writes. E8-005 owns persistence.
 *   - No backend changes. /api/consult shipped with E1-003.
 *   - No 4-chip suggestion row in this PR. The master plan describes
 *     chips, but the E8-003 brief scopes this ticket to the TextInput +
 *     CTA pair. Chips can land as a small follow-up without a primitive
 *     change.
 *
 * Strict-mode double-mount latch:
 *   `inFlightRef` debounces a synchronous double-tap on Save (two presses
 *   in the same tick that both pass the disabled check). Cleared after
 *   the consult promise settles OR on reset. React 18 Strict Mode
 *   double-mounts dev components; the latch is per-press, not per-mount,
 *   so it stays correct across the double-mount.
 *
 * AppState resume:
 *   If the user backgrounds the app mid-consult and resumes, no second
 *   consult fires. The mounted-ref + call-counter inside useConsultRequest
 *   already drops stale results; this component does NOT re-fire on
 *   foreground because Save is user-driven. Test 'AppState resume'
 *   verifies the no-double-fire contract.
 *
 * Accessibility:
 *   - The TextInput has `accessibilityLabel` (default "Note about your
 *     plant"; overridable per plant).
 *   - The inner editorial sheet announces as `role='dialog'` via E2-011.
 *     Focus trap is owned by Modal + accessibilityViewIsModal in that
 *     primitive.
 *   - The reject / low-confidence / error cards carry
 *     `accessibilityRole='alert'` so VoiceOver/TalkBack announces them on
 *     phase transition.
 *   - The pending toast carries `accessibilityRole='status'` (less
 *     interruptive than alert, matches ToastBanner type='pending'
 *     semantics in E2-012).
 *
 * Token verification (DESIGN.md cross-check):
 *   - theme.colors.surface — used for sheet bg, card bg ✓
 *   - theme.colors.text    — used for body, headlines, primary CTA fill ✓
 *   - theme.colors.textMuted — used for caption / secondary copy ✓
 *   - theme.colors.tan     — used for the reject + queued accent line.
 *                            (DESIGN.md tan = #C9A873 in both light + dark.)
 *                            Note: there is NO `theme.colors.warn` token —
 *                            tan is the closest design-system accent for
 *                            "soft warning / pending / off-topic" surfaces,
 *                            per the Wave 1 lesson captured in the
 *                            orchestrator brief.
 *   - theme.colors.stroke  — used for input + card hairline borders ✓
 *   - theme.colors.water   — NOT used here.
 *   - theme.colors.sage    — NOT used here.
 *   Every used token is verified against DESIGN.md / packages/theme/colors.ts.
 */

import { fonts } from '@plantcare/theme';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { useReduceMotion } from '../hooks/useReduceMotion';
import { useTheme } from '../hooks/useTheme';
import {
  useConsultRequest,
  type ConsultPlantContext,
} from '../hooks/useConsultRequest';
import type { LlmCallWriter } from '../lib/llmBudget';
import type { ApiClient, ApiResult, ConsultResponse } from '../api';
import {
  EditorialBottomSheet,
  EditorialButton,
} from './primitives';

// ─── Public types ───────────────────────────────────────────────────────

export type AddNoteSavedPayload = {
  /** The user's note, trimmed. */
  note: string;
  /**
   * The LLM response, when one was produced. `null` when the request was
   * queued offline (the parent persists with consult_status='pending'
   * per the master-plan schema; E7 drains and updates later).
   */
  llmResponse: ConsultResponse | null;
  /** Local-clock timestamp of the save. ms since epoch. */
  timestamp: number;
  /**
   * Discriminator the parent uses to decide what to write. 'ok' = a
   * recommendation arrived; 'queued' = offline, persist as pending.
   */
  status: 'ok' | 'queued';
};

export type AddNoteSheetProps = {
  readonly open: boolean;
  /** Fires when the user taps Cancel or swipe-dismisses with no save. */
  readonly onCancel: () => void;
  /**
   * Fires after a successful consult OR a queued offline submission. The
   * parent decides what to persist; this sheet does not touch SQLite.
   * After onSave fires, the parent should set `open=false`.
   */
  readonly onSave: (payload: AddNoteSavedPayload) => void;
  /**
   * Required: the api client. Injected so the sheet stays testable and
   * doesn't reach into a hidden singleton. Mirrors useDiagnoseRequest's
   * dependency-visibility convention.
   */
  readonly apiClient: ApiClient;
  /** Optional plant context forwarded to /api/consult. */
  readonly plantContext?: ConsultPlantContext;
  /** Optional netInfo probe (E7-003 will swap real one in via this). */
  readonly netInfo?: { isConnected: () => boolean | Promise<boolean> };
  /**
   * Plant nickname for the headline. "How is {nickname} doing?" matches
   * the master plan's editorial voice. Falls back to the species when
   * absent, then to a neutral "How is your plant doing?".
   */
  readonly plantNickname?: string;
  readonly plantSpecies?: string;
  /**
   * E11-006 LLM-budget gate. When `disabled === true`, the Save & analyze
   * CTA renders with the limit-reached label, the disabled flag is
   * forced true regardless of input, and a tap is a no-op (defense-in-
   * depth in case the rendered disabled state desyncs). The parent
   * (PlantDetailRoute when E8-004 lands) is expected to read
   * `useLlmBudgetGate()` and pass the resulting `disabled` here. The
   * persistent <BudgetBanner> in the Plants list is the user-facing
   * "why" — there is no second limit-reached surface inside the sheet.
   *
   * Optional: when omitted, the sheet behaves identically to the pre-
   * E11-006 surface (back-compat for tests + E8-004's pre-flag-flip
   * window). The wire-up arrives when E8-004 mounts the sheet from the
   * route layer with the gate plumbed through.
   */
  readonly budgetGate?: { readonly disabled: boolean };
  /**
   * E11-006 insertion path. When the consult call resolves with
   * `ok:true` (terminal-success), the hook fires
   * `recordLlmCall(budgetDb, 'consult')` to advance the SQLite
   * counter `useLlmBudget()` reads. Wired all the way through so
   * the budget meter on the Plants list reflects consult successes.
   * Optional — when omitted (older callers, isolated tests of the
   * sheet itself) the hook is a no-op on the budget side.
   */
  readonly budgetDb?: LlmCallWriter | (() => Promise<LlmCallWriter>);
  readonly accessibilityLabel?: string;
  readonly testID?: string;
};

// ─── Component ──────────────────────────────────────────────────────────

const HEADLINE_NEUTRAL = 'How is your plant doing?';

export function AddNoteSheet(props: AddNoteSheetProps) {
  const {
    open,
    onCancel,
    onSave,
    apiClient,
    plantContext,
    netInfo,
    plantNickname,
    plantSpecies,
    budgetGate,
    budgetDb,
    accessibilityLabel,
    testID,
  } = props;

  // E11-006: when the daily LLM budget is exhausted, the Save & analyze
  // CTA flips to a disabled limit-reached label. The persistent
  // <BudgetBanner> in the Plants list is the explanatory surface; this
  // sheet just refuses to fire consult().
  const budgetDisabled = budgetGate?.disabled === true;

  const theme = useTheme();
  const reduceMotion = useReduceMotion();
  const { consult, status, lastResult, reset } = useConsultRequest({
    apiClient,
    ...(netInfo ? { netInfo } : {}),
    ...(budgetDb ? { budgetDb } : {}),
  });

  const [note, setNote] = useState('');
  // inFlightRef debounces synchronous double-presses on Save. The
  // useConsultRequest hook itself accepts back-to-back calls (call-counter
  // semantics), but the parent's onSave should fire exactly once per
  // user-perceived submit. The latch flips on the first press and clears
  // when the consult settles OR when the sheet closes.
  const inFlightRef = useRef(false);
  // The note that was actually dispatched. Snapshot at submit time so the
  // recommendation phase's Done CTA emits the same note the user submitted,
  // even if they edit the local state field afterwards (defensive — the
  // input is read-only in the recommendation phase, but the snapshot also
  // covers the queued path where onSave fires from the press handler).
  const submittedNoteRef = useRef('');

  // Reset local state when the sheet closes so a re-open starts fresh.
  // The hook's own reset() clears its committed call id; the local note
  // state clears here. We clear on close-transition (open going from
  // true → false), not on every open=false, to avoid clobbering state
  // before the parent has reacted to onSave.
  const wasOpenRef = useRef(open);
  useEffect(() => {
    if (wasOpenRef.current && !open) {
      // Closing.
      setNote('');
      inFlightRef.current = false;
      reset();
    }
    wasOpenRef.current = open;
  }, [open, reset]);

  const trimmedNote = note.trim();
  const canSubmit =
    trimmedNote.length > 0 && status !== 'requesting' && !budgetDisabled;

  const handleSavePress = useCallback(async () => {
    // E11-006 belt-and-braces: the rendered CTA is already disabled when
    // budgetDisabled, but a programmatic press (or a brief render-window
    // race after the gate flips) MUST not fire consult(). The
    // useConsultRequest hook would happily call /api/consult — the gate
    // lives here, at the user-intent boundary, not at the network
    // boundary. Same pattern Identify/Diagnose's outer screens follow.
    if (budgetDisabled) return;
    if (!canSubmit) return;
    if (inFlightRef.current) return;
    inFlightRef.current = true;

    const submittedNote = trimmedNote;
    submittedNoteRef.current = submittedNote;
    const result = await consult({
      note: submittedNote,
      ...(plantContext ? { plantContext } : {}),
    });

    inFlightRef.current = false;

    // Recommendation success: do NOT auto-fire onSave. The recommendation
    // phase renders the inline reasoning per the master plan ("Response is
    // displayed inline above the buttons as a Fraunces italic line"), and
    // the user taps Done to proceed. Giving the user a beat to read is
    // why we have a sheet at all — the value is the inline response, not
    // the persistence event.
    //
    // Queued: fire onSave from the press handler. The pending toast still
    // renders because status='queued' drives derivePhase, and the parent
    // persists with consult_status='pending' so E7's drainer can resolve
    // it later. We don't make the user dismiss a "we'll save later" card —
    // the toast is reassurance, not a gating affordance.
    if (!result.ok && result.kind === 'queued') {
      onSave({
        note: submittedNote,
        llmResponse: null,
        timestamp: Date.now(),
        status: 'queued',
      });
      return;
    }
    // Other kinds (recommendation, layer1_reject, low_confidence, server,
    // timeout, parse_error, or the rare ok+rejected_off_topic forward-compat)
    // stay in the sheet for the user to retry, dismiss, or tap Done.
    // Status / lastResult already reflect them; the render switch handles
    // the UI.
  }, [budgetDisabled, canSubmit, consult, onSave, plantContext, trimmedNote]);

  const handleDonePress = useCallback(() => {
    // Recommendation phase Done CTA. Read the success-data from lastResult
    // and emit onSave; the parent will persist + close the sheet.
    if (!lastResult || !lastResult.ok) return;
    if (lastResult.data.kind !== 'recommendation') return;
    onSave({
      note: submittedNoteRef.current,
      llmResponse: lastResult.data,
      timestamp: Date.now(),
      status: 'ok',
    });
  }, [lastResult, onSave]);

  const handleTryAgain = useCallback(() => {
    // Try again preserves the note text (kinder default — the user just
    // wrote it; making them retype is hostile). Reset the hook so the
    // input phase re-renders.
    inFlightRef.current = false;
    reset();
  }, [reset]);

  const headline = useMemo(() => {
    if (plantNickname && plantNickname.trim()) return `How is ${plantNickname.trim()} doing?`;
    if (plantSpecies && plantSpecies.trim()) return `How is your ${plantSpecies.trim()} doing?`;
    return HEADLINE_NEUTRAL;
  }, [plantNickname, plantSpecies]);

  const phase = derivePhase(status, lastResult);

  return (
    <EditorialBottomSheet
      open={open}
      onDismiss={onCancel}
      accessibilityLabel={accessibilityLabel ?? 'Add a note about your plant'}
      testID={testID ?? 'add-note-sheet'}
      heightFraction={0.7}
    >
      <View
        style={styles.container}
        testID={testID ? `${testID}-body` : 'add-note-sheet-body'}
      >
        <Text
          style={[styles.headline, { color: theme.colors.text }]}
          accessibilityRole="header"
          testID="add-note-sheet-headline"
        >
          {headline}
        </Text>

        {phase === 'input' || phase === 'loading' ? (
          <InputView
            note={note}
            onChangeNote={setNote}
            onSavePress={handleSavePress}
            onCancelPress={onCancel}
            canSubmit={canSubmit}
            loading={phase === 'loading'}
            reduceMotion={reduceMotion}
            theme={theme}
            // E11-006: when budget is exhausted, swap the CTA label and
            // force the disabled flag true. The persistent
            // <BudgetBanner> on the Plants list is the explanatory
            // surface — there is no second limit-reached card inside
            // the sheet.
            budgetDisabled={budgetDisabled}
            testID={testID ?? 'add-note-sheet'}
          />
        ) : null}

        {phase === 'recommendation' &&
        lastResult &&
        lastResult.ok &&
        lastResult.data.kind === 'recommendation' ? (
          <RecommendationCard
            recommendation={lastResult.data}
            onDone={handleDonePress}
            theme={theme}
            testID={testID ?? 'add-note-sheet'}
          />
        ) : null}

        {phase === 'reject' ? (
          <RejectCard
            onTryAgain={handleTryAgain}
            onCancel={onCancel}
            theme={theme}
            testID={testID ?? 'add-note-sheet'}
          />
        ) : null}

        {phase === 'low_confidence' ? (
          <LowConfidenceCard
            onTryAgain={handleTryAgain}
            onCancel={onCancel}
            theme={theme}
            testID={testID ?? 'add-note-sheet'}
          />
        ) : null}

        {phase === 'timeout' ? (
          <ErrorCard
            kind="timeout"
            onTryAgain={handleTryAgain}
            onCancel={onCancel}
            theme={theme}
            testID={testID ?? 'add-note-sheet'}
          />
        ) : null}

        {phase === 'server' ? (
          <ErrorCard
            kind="server"
            onTryAgain={handleTryAgain}
            onCancel={onCancel}
            theme={theme}
            testID={testID ?? 'add-note-sheet'}
            retryAfter={
              lastResult && !lastResult.ok && 'retry_after' in lastResult
                ? lastResult.retry_after
                : undefined
            }
          />
        ) : null}

        {phase === 'parse_error' ? (
          <ErrorCard
            kind="parse_error"
            onTryAgain={handleTryAgain}
            onCancel={onCancel}
            theme={theme}
            testID={testID ?? 'add-note-sheet'}
          />
        ) : null}

        {phase === 'queued' ? (
          <QueuedCard theme={theme} testID={testID ?? 'add-note-sheet'} />
        ) : null}
      </View>
    </EditorialBottomSheet>
  );
}

// ─── Phase derivation ───────────────────────────────────────────────────

type Phase =
  | 'input'
  | 'loading'
  | 'recommendation'
  | 'reject'
  | 'low_confidence'
  | 'timeout'
  | 'server'
  | 'parse_error'
  | 'queued';

/**
 * Pure mapping from hook state to render phase. Every locked client kind
 * gets its own phase — codex P1 lock: no collapsing the discriminated
 * union into a generic "error" bucket.
 *
 * Notes:
 *   - `success` + data.kind === 'rejected_off_topic' (forward-compat,
 *     not emitted today) routes to 'reject'. The common off-topic path
 *     comes through as `layer1_reject` and lands here too.
 *   - `success` + data.kind === 'recommendation' renders the inline
 *     recommendation card per the master plan (line 333: "Response is
 *     displayed inline above the buttons as a Fraunces italic line").
 *     The user taps Done to fire onSave — this gives the user a chance
 *     to actually read the response before the sheet closes.
 *     (Codex P2 fix: the union is NOT collapsed; success has its own
 *     distinct phase + UI.)
 */
export function derivePhase(
  status: 'idle' | 'requesting' | 'success' | 'error' | 'queued',
  lastResult: ApiResult<ConsultResponse> | null,
): Phase {
  if (status === 'requesting') return 'loading';
  if (status === 'queued') return 'queued';

  if (lastResult && lastResult.ok) {
    // ConsultResponse is a discriminated union; rejected-off-topic shape
    // can only land via the forward-compat path described in the hook.
    if (lastResult.data.kind === 'rejected_off_topic') return 'reject';
    return 'recommendation';
  }

  if (lastResult && !lastResult.ok) {
    switch (lastResult.kind) {
      case 'layer1_reject':
        return 'reject';
      case 'low_confidence':
        return 'low_confidence';
      case 'timeout':
        return 'timeout';
      case 'server':
        return 'server';
      case 'parse_error':
        return 'parse_error';
      case 'queued':
        return 'queued';
      // 'network' is coerced to 'queued' inside the hook before commit;
      // nothing should reach this branch carrying kind='network'. If it
      // somehow does, defensive fall-through to input phase prevents a
      // dead screen.
      case 'network':
      default:
        return 'input';
    }
  }

  return 'input';
}

// ─── Phase views ────────────────────────────────────────────────────────

type Theme = ReturnType<typeof useTheme>;

function InputView(props: {
  note: string;
  onChangeNote: (s: string) => void;
  onSavePress: () => void;
  onCancelPress: () => void;
  canSubmit: boolean;
  loading: boolean;
  reduceMotion: boolean;
  theme: Theme;
  /**
   * E11-006: budget exhausted? Swap the Save CTA label, force-disable.
   * The parent already folds this into `canSubmit`; this prop drives
   * the cosmetic copy + accessibility-state change.
   */
  budgetDisabled: boolean;
  testID: string;
}) {
  const {
    note,
    onChangeNote,
    onSavePress,
    onCancelPress,
    canSubmit,
    loading,
    reduceMotion,
    theme,
    budgetDisabled,
    testID,
  } = props;

  // CTA copy resolution. When budgetDisabled is true the user-perceived
  // affordance is "the analyze step is unavailable today" — surfacing
  // that in the button itself (rather than in a tooltip the user can't
  // discover) keeps the screen comprehensible without a second
  // explanatory card. The ToastBanner in the Plants list is the
  // authoritative "why."
  const saveLabel = budgetDisabled ? 'Daily limit reached' : 'Save & analyze';
  const saveAccessibilityLabel = budgetDisabled
    ? 'Daily LLM limit reached. Save and analyze unavailable until midnight UTC.'
    : 'Save note and analyze';

  return (
    <View>
      <TextInput
        value={note}
        onChangeText={onChangeNote}
        placeholder="Just repotted, leaves drooping, moved to brighter spot…"
        placeholderTextColor={theme.colors.textMuted}
        multiline
        editable={!loading}
        accessibilityLabel="Note about your plant"
        testID={`${testID}-input`}
        style={[
          styles.input,
          {
            color: theme.colors.text,
            backgroundColor: theme.colors.surface,
            borderColor: theme.colors.stroke,
          },
        ]}
      />

      {loading ? (
        <View
          style={styles.loadingRow}
          // 'status' is a valid AccessibilityRole on iOS / web ('alert' /
          // 'status' are real WAI-ARIA values RN exposes via the platform
          // bridge). The shipped @types/react-native enum is conservative;
          // we cast to keep the types quiet without losing the runtime
          // behavior. Same trick the E2-011 EditorialBottomSheet uses for
          // 'dialog'.
          accessibilityRole={'status' as 'none'}
          accessibilityLabel="Listening — analyzing your note"
          testID={`${testID}-loading`}
        >
          {reduceMotion ? (
            <View
              style={[styles.staticDot, { backgroundColor: theme.colors.text }]}
              testID={`${testID}-loading-static`}
            />
          ) : (
            <ActivityIndicator
              size="small"
              color={theme.colors.text}
              testID={`${testID}-loading-spinner`}
            />
          )}
          <Text
            style={[styles.loadingCopy, { color: theme.colors.textMuted }]}
          >
            Listening…
          </Text>
        </View>
      ) : null}

      <View style={styles.ctaRow}>
        <View style={styles.ctaSpacerSmall} />
        <View style={styles.ctaCancel}>
          <EditorialButton
            variant="outline"
            label="Cancel"
            onPress={onCancelPress}
            disabled={loading}
            testID={`${testID}-cancel`}
            accessibilityLabel="Cancel and close"
          />
        </View>
        <View style={styles.ctaSpacerSmall} />
        <View style={styles.ctaSave}>
          <EditorialButton
            variant="filled"
            label={saveLabel}
            onPress={onSavePress}
            disabled={!canSubmit}
            loading={loading}
            testID={`${testID}-save`}
            accessibilityLabel={saveAccessibilityLabel}
          />
        </View>
      </View>
    </View>
  );
}

function RecommendationCard(props: {
  recommendation: Extract<ConsultResponse, { kind: 'recommendation' }>;
  onDone: () => void;
  theme: Theme;
  testID: string;
}) {
  const { recommendation, onDone, theme, testID } = props;
  return (
    <View
      style={[
        styles.card,
        { borderColor: theme.colors.stroke, backgroundColor: theme.colors.surface },
      ]}
      // 'status' (live region, polite) is the right semantic — the
      // recommendation is information the screen reader should pick up
      // when the phase swaps in, but it isn't an error/alert.
      accessibilityRole={'status' as 'none'}
      accessibilityLiveRegion="polite"
      testID={`${testID}-recommendation`}
    >
      <Text
        style={[
          styles.cardBody,
          {
            color: theme.colors.text,
            fontFamily: fonts.display.italic,
            fontSize: 16,
            lineHeight: 24,
          },
        ]}
        testID={`${testID}-recommendation-reasoning`}
      >
        {recommendation.reasoning}
      </Text>
      <View style={styles.cardCtaRow}>
        <View style={styles.ctaSpacerSmall} />
        <View style={styles.ctaSave}>
          <EditorialButton
            variant="filled"
            label="Done"
            onPress={onDone}
            testID={`${testID}-recommendation-done`}
            accessibilityLabel="Done — save this note"
          />
        </View>
      </View>
    </View>
  );
}

function RejectCard(props: {
  onTryAgain: () => void;
  onCancel: () => void;
  theme: Theme;
  testID: string;
}) {
  const { onTryAgain, onCancel, theme, testID } = props;
  return (
    <View
      style={[
        styles.card,
        { borderColor: theme.colors.tan, backgroundColor: theme.colors.surface },
      ]}
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      testID={`${testID}-reject`}
    >
      <Text style={[styles.cardHeadline, { color: theme.colors.text }]}>
        Let’s keep this about your plants
      </Text>
      <Text style={[styles.cardBody, { color: theme.colors.textMuted }]}>
        We’re focused on plant care for now — try asking about your plants!
      </Text>
      <View style={styles.cardCtaRow}>
        <View style={styles.ctaCancel}>
          <EditorialButton
            variant="outline"
            label="Cancel"
            onPress={onCancel}
            testID={`${testID}-reject-cancel`}
          />
        </View>
        <View style={styles.ctaSpacerSmall} />
        <View style={styles.ctaSave}>
          <EditorialButton
            variant="filled"
            label="Try again"
            onPress={onTryAgain}
            testID={`${testID}-reject-try-again`}
          />
        </View>
      </View>
    </View>
  );
}

function LowConfidenceCard(props: {
  onTryAgain: () => void;
  onCancel: () => void;
  theme: Theme;
  testID: string;
}) {
  const { onTryAgain, onCancel, theme, testID } = props;
  return (
    <View
      style={[
        styles.card,
        { borderColor: theme.colors.stroke, backgroundColor: theme.colors.surface },
      ]}
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      testID={`${testID}-low-confidence`}
    >
      <Text style={[styles.cardHeadline, { color: theme.colors.text }]}>
        I’m not sure about this one
      </Text>
      <Text style={[styles.cardBody, { color: theme.colors.textMuted }]}>
        Could you add a little more detail? Symptoms, recent changes, or what
        prompted the note all help.
      </Text>
      <View style={styles.cardCtaRow}>
        <View style={styles.ctaCancel}>
          <EditorialButton
            variant="outline"
            label="Cancel"
            onPress={onCancel}
            testID={`${testID}-low-confidence-cancel`}
          />
        </View>
        <View style={styles.ctaSpacerSmall} />
        <View style={styles.ctaSave}>
          <EditorialButton
            variant="filled"
            label="Try again"
            onPress={onTryAgain}
            testID={`${testID}-low-confidence-try-again`}
          />
        </View>
      </View>
    </View>
  );
}

function ErrorCard(props: {
  kind: 'timeout' | 'server' | 'parse_error';
  onTryAgain: () => void;
  onCancel: () => void;
  theme: Theme;
  testID: string;
  retryAfter?: number;
}) {
  const { kind, onTryAgain, onCancel, theme, testID, retryAfter } = props;
  const copy = ERROR_COPY[kind];
  const body =
    kind === 'server' && typeof retryAfter === 'number' && retryAfter > 0
      ? `${copy.body} Try again in ~${retryAfter} seconds.`
      : copy.body;
  return (
    <View
      style={[
        styles.card,
        { borderColor: theme.colors.stroke, backgroundColor: theme.colors.surface },
      ]}
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      testID={`${testID}-error-${kind}`}
    >
      <Text style={[styles.cardHeadline, { color: theme.colors.text }]}>
        {copy.headline}
      </Text>
      <Text style={[styles.cardBody, { color: theme.colors.textMuted }]}>
        {body}
      </Text>
      <View style={styles.cardCtaRow}>
        <View style={styles.ctaCancel}>
          <EditorialButton
            variant="outline"
            label="Cancel"
            onPress={onCancel}
            testID={`${testID}-error-${kind}-cancel`}
          />
        </View>
        <View style={styles.ctaSpacerSmall} />
        <View style={styles.ctaSave}>
          <EditorialButton
            variant="filled"
            label="Try again"
            onPress={onTryAgain}
            testID={`${testID}-error-${kind}-try-again`}
          />
        </View>
      </View>
    </View>
  );
}

function QueuedCard(props: { theme: Theme; testID: string }) {
  const { theme, testID } = props;
  return (
    <View
      style={[
        styles.card,
        { borderColor: theme.colors.tan, backgroundColor: theme.colors.surface },
      ]}
      accessibilityRole={'status' as 'none'}
      accessibilityLiveRegion="polite"
      testID={`${testID}-queued`}
    >
      <Text style={[styles.cardHeadline, { color: theme.colors.text }]}>
        We’ll save when you’re back online
      </Text>
      <Text style={[styles.cardBody, { color: theme.colors.textMuted }]}>
        Your note is saved on this device. We’ll ask the lab as soon as
        you’re reconnected.
      </Text>
    </View>
  );
}

const ERROR_COPY: Record<
  'timeout' | 'server' | 'parse_error',
  { headline: string; body: string }
> = {
  timeout: {
    headline: 'That took longer than expected',
    body: 'The lab didn’t answer in time. Tap Try again to retry.',
  },
  server: {
    headline: 'Couldn’t reach the lab',
    body: 'Something’s off on our side.',
  },
  parse_error: {
    headline: 'Something didn’t come back right',
    body: 'We got a response but couldn’t read it. Tap Try again to retry.',
  },
};

// ─── Styles ─────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    paddingTop: 8,
    paddingBottom: 8,
  },
  headline: {
    fontFamily: fonts.display.semibold,
    fontSize: 22,
    lineHeight: 28,
    marginBottom: 16,
  },
  input: {
    minHeight: 96,
    maxHeight: 200,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontFamily: fonts.body.regular,
    fontSize: 15,
    lineHeight: 22,
    textAlignVertical: 'top',
  },
  loadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 12,
  },
  loadingCopy: {
    fontFamily: fonts.body.regular,
    fontStyle: 'italic',
    fontSize: 14,
    lineHeight: 20,
    marginLeft: 8,
  },
  staticDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  ctaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 16,
  },
  ctaSpacerSmall: {
    width: 8,
  },
  ctaCancel: {
    flex: 1,
  },
  ctaSave: {
    flex: 2,
  },
  card: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 16,
    marginTop: 4,
  },
  cardHeadline: {
    fontFamily: fonts.display.semibold,
    fontSize: 18,
    lineHeight: 24,
    marginBottom: 8,
  },
  cardBody: {
    fontFamily: fonts.body.regular,
    fontSize: 14,
    lineHeight: 20,
  },
  cardCtaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 16,
  },
});
