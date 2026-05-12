/**
 * EditPlantDetailsSheet — bottom sheet on plant detail (A-2) that lets the
 * user toggle `is_indoor` and set a custom `override_interval_days` on a
 * plant. Composes E2-011's `<EditorialBottomSheet>` (focus trap +
 * swipe-to-close primitive) and adds two interactive rows + Save / Cancel
 * CTAs.
 *
 * --- WHY A CALLBACK INTERFACE INSTEAD OF WIRING `usePlants().update()` ---
 *
 * The sheet emits `onSave({ is_indoor, override_interval_days })` and lets
 * the parent screen (PlantDetailScreen, E4-005, not yet shipped) own the
 * persistence. Two reasons:
 *   1. Parents already hold the `Plant` row they fetched via `usePlants()`;
 *      threading the same hook in here would re-call `usePlants()` and
 *      duplicate the executor across the same render tree.
 *   2. Tests stay pure — no SQLite mocking on the component layer. The
 *      `usePlants` adapter is exhaustively tested at E2-003.
 *
 * --- VALIDATION (custom watering interval) ---
 *
 * Empty / blank → null override → "use the default species interval".
 * Otherwise must be a positive integer in [1, 365]. Decimals, negatives,
 * leading zeros, and non-digit characters are all invalid → inline copy in
 * `theme.colors.tan` (Conservatory accent). Save CTA disabled while invalid.
 *
 * Codex briefing surfaces the gnarlier inputs explicitly:
 *   - paste of "1.5"        → invalid (decimal not allowed)
 *   - paste of "0"          → invalid (below the [1, 365] range)
 *   - paste of "365.0"      → invalid (decimal even though value rounds in)
 *   - paste of "365.99"     → invalid (decimal + > 365)
 *   - paste of "07"         → normalized to "7" on commit; valid
 *   - emoji / "🌱"          → invalid (non-digit)
 *   - very long string      → invalid (sanitized; only digits accepted)
 *   - "  7  " (whitespace)  → trimmed; valid as 7
 *
 * --- BOOLEAN MARSHALLING ---
 *
 * The schema stores `is_indoor` as `INTEGER 0|1` (V1 raw-SQL convention,
 * see `db/schema.ts`). `usePlants().update()` already converts JS booleans
 * to 0/1 on write — so this sheet emits a JS `boolean` and lets the
 * persistence layer own the marshal. No 0/1 leaks past this component.
 *
 * --- REDUCE-MOTION ---
 *
 * The sheet itself inherits reduce-motion-aware slide animation from
 * `<EditorialBottomSheet>` (which gates Modal `animationType` on the
 * platform-level pref). This component has no additional transitions — the
 * stepper +/- presses snap immediately so there's nothing extra to gate.
 * `useReduceMotion()` (E2-004) is consulted but only documents that we
 * checked; this future-proofs against a designer adding a value-change
 * easing animation later.
 */

import { fonts } from '@plantcare/theme';
import { useCallback, useMemo, useState, type ReactElement } from 'react';
import {
  Pressable,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';

import { useReduceMotion } from '../hooks/useReduceMotion';
import { useTheme } from '../hooks/useTheme';
import { EditorialBottomSheet } from './primitives/EditorialBottomSheet';

export type EditPlantDetailsSheetProps = {
  readonly open: boolean;
  /** Initial values pulled from the parent's `Plant` row. */
  readonly initialIsIndoor: boolean;
  /** `null` means "no override — use the default species interval". */
  readonly initialOverrideIntervalDays: number | null;
  /** Fires with the new payload shape `usePlants().update()` accepts. */
  readonly onSave: (patch: {
    is_indoor: boolean;
    override_interval_days: number | null;
  }) => void;
  readonly onCancel: () => void;
  readonly testID?: string;
};

export const MIN_INTERVAL_DAYS = 1;
export const MAX_INTERVAL_DAYS = 365;
export const VALIDATION_COPY =
  'Enter a whole number between 1 and 365, or leave blank.';
export const HELPER_COPY = 'Leave blank to use the default for this species.';

/**
 * Pure validator — exported so tests can hit every branch without rendering.
 *
 * Returns `{ valid: true, value: number | null }` (null = "use default") or
 * `{ valid: false }` for everything else. Whitespace-only inputs are
 * treated as blank.
 */
export function parseIntervalInput(raw: string):
  | { readonly valid: true; readonly value: number | null }
  | { readonly valid: false } {
  const trimmed = raw.trim();
  if (trimmed === '') return { valid: true, value: null };
  // Only ASCII digits — rejects decimals (".", ","), negatives ("-"),
  // emoji, scientific notation ("1e2"), and any other non-digit junk.
  if (!/^[0-9]+$/.test(trimmed)) return { valid: false };
  const n = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(n)) return { valid: false };
  if (n < MIN_INTERVAL_DAYS || n > MAX_INTERVAL_DAYS) return { valid: false };
  return { valid: true, value: n };
}

// Cap raw input length so a paste of "999999999..." doesn't grow state
// unboundedly and parse loops don't churn on absurd strings. 8 chars is well
// past the 3-digit valid range (365) but leaves enough room that a user
// pasting "365.99" sees their original input verbatim and can correct it.
// We deliberately do NOT silently strip non-digits — codex P2 fix: silent
// sanitize-while-typing turns "1.5" into "15" (a different valid value)
// before validation runs, so the user thinks they entered 15 when they
// actually entered 1.5. Keep the raw text; let parseIntervalInput judge it.
const MAX_RAW_LENGTH = 8;

export function EditPlantDetailsSheet(
  props: EditPlantDetailsSheetProps,
): ReactElement {
  const {
    open,
    initialIsIndoor,
    initialOverrideIntervalDays,
    onSave,
    onCancel,
    testID,
  } = props;

  const theme = useTheme();
  // Consulted to document the contract for future easing/transition work.
  // No-op today because the sheet has no internal animations to gate.
  // Referenced via a void expression so TypeScript / eslint don't flag.
  void useReduceMotion();

  const [isIndoor, setIsIndoor] = useState<boolean>(initialIsIndoor);
  const [intervalText, setIntervalText] = useState<string>(
    initialOverrideIntervalDays === null
      ? ''
      : String(initialOverrideIntervalDays),
  );

  const parsed = useMemo(() => parseIntervalInput(intervalText), [intervalText]);

  const handleIntervalChange = useCallback((next: string) => {
    // Cap length but keep the user's original characters. Validation lives
    // in parseIntervalInput — we don't silently rewrite "1.5" into "15"
    // (codex P2 catch). Invalid chars surface validation copy + disable Save.
    setIntervalText(next.slice(0, MAX_RAW_LENGTH));
  }, []);

  const handleStep = useCallback(
    (delta: 1 | -1) => {
      // Treat blank as "default" — stepping up from blank means "1" so the
      // user can build an interval; stepping down from blank stays blank.
      if (intervalText.trim() === '') {
        if (delta === 1) setIntervalText(String(MIN_INTERVAL_DAYS));
        return;
      }
      const current = Number.parseInt(intervalText, 10);
      if (!Number.isFinite(current)) return;
      const next = current + delta;
      const clamped = Math.min(MAX_INTERVAL_DAYS, Math.max(MIN_INTERVAL_DAYS, next));
      setIntervalText(String(clamped));
    },
    [intervalText],
  );

  const handleSave = useCallback(() => {
    if (!parsed.valid) return;
    onSave({
      is_indoor: isIndoor,
      override_interval_days: parsed.value,
    });
  }, [parsed, isIndoor, onSave]);

  const accentInvalid = theme.colors.tan;
  const stroke = theme.colors.stroke;
  const text = theme.colors.text;
  const textMuted = theme.colors.textMuted;

  // Stepper +/- visual buttons. Disabled at bounds.
  const decDisabled = (() => {
    if (intervalText.trim() === '') return true; // can't go below "default"
    const n = Number.parseInt(intervalText, 10);
    return !Number.isFinite(n) || n <= MIN_INTERVAL_DAYS;
  })();
  const incDisabled = (() => {
    if (intervalText.trim() === '') return false;
    const n = Number.parseInt(intervalText, 10);
    return !Number.isFinite(n) || n >= MAX_INTERVAL_DAYS;
  })();

  // Live announcement for the spinbutton — VoiceOver/TalkBack reads the
  // accessibilityValue on every change. Numeric form ("text" property) keeps
  // the announcement compact ("7" rather than "Custom interval, 7").
  const intervalAccessibilityValue = useMemo(() => {
    if (intervalText.trim() === '') {
      return { text: 'Default species interval' };
    }
    const n = Number.parseInt(intervalText, 10);
    if (!Number.isFinite(n)) return { text: intervalText };
    return { text: `${n} days`, now: n, min: MIN_INTERVAL_DAYS, max: MAX_INTERVAL_DAYS };
  }, [intervalText]);

  return (
    <EditorialBottomSheet
      open={open}
      onDismiss={onCancel}
      heightFraction={0.55}
      accessibilityLabel="Edit plant details"
      testID={testID ?? 'edit-plant-details-sheet'}
    >
      <View style={styles.body}>
        <Text
          style={[styles.title, { color: text }]}
          accessibilityRole="header"
          testID="edit-details-title"
        >
          Edit details
        </Text>

        {/* Indoors toggle row */}
        <View style={[styles.row, { borderBottomColor: stroke }]}>
          <View style={styles.rowText}>
            <Text style={[styles.rowLabel, { color: text }]}>Indoors</Text>
            <Text style={[styles.rowHint, { color: textMuted }]}>
              Indoor plants ignore the local rain forecast.
            </Text>
          </View>
          <Switch
            value={isIndoor}
            onValueChange={setIsIndoor}
            accessibilityRole="switch"
            accessibilityLabel="Indoors"
            accessibilityState={{ checked: isIndoor }}
            testID="edit-details-indoor-switch"
          />
        </View>

        {/* Custom interval stepper row */}
        <View style={styles.intervalRow}>
          <Text style={[styles.rowLabel, { color: text }]}>
            Custom watering interval (days)
          </Text>
          <Text style={[styles.rowHint, { color: textMuted }]}>{HELPER_COPY}</Text>

          <View style={styles.stepper}>
            <Pressable
              onPress={() => handleStep(-1)}
              disabled={decDisabled}
              accessibilityRole="button"
              accessibilityLabel="Decrease interval by one day"
              accessibilityState={{ disabled: decDisabled }}
              hitSlop={8}
              style={({ pressed }) => [
                styles.stepBtn,
                { borderColor: stroke },
                pressed && !decDisabled && styles.stepPressed,
                decDisabled && styles.stepDisabled,
              ]}
              testID="edit-details-interval-dec"
            >
              <Text style={[styles.stepGlyph, { color: text }]}>−</Text>
            </Pressable>

            <TextInput
              value={intervalText}
              onChangeText={handleIntervalChange}
              placeholder="—"
              placeholderTextColor={textMuted}
              keyboardType="number-pad"
              inputMode="numeric"
              // No `maxLength` — capping at 3 chars would silently truncate a
              // pasted "999" but leave "365.99" → "365" via paste, masquerading
              // as valid. Length cap lives in handleIntervalChange and is
              // generous enough to preserve invalid pastes for the validator.
              maxLength={MAX_RAW_LENGTH}
              accessibilityRole="spinbutton"
              accessibilityLabel="Custom watering interval in days"
              accessibilityValue={intervalAccessibilityValue}
              style={[
                styles.input,
                {
                  color: text,
                  borderColor: parsed.valid ? stroke : accentInvalid,
                },
              ]}
              testID="edit-details-interval-input"
            />

            <Pressable
              onPress={() => handleStep(1)}
              disabled={incDisabled}
              accessibilityRole="button"
              accessibilityLabel="Increase interval by one day"
              accessibilityState={{ disabled: incDisabled }}
              hitSlop={8}
              style={({ pressed }) => [
                styles.stepBtn,
                { borderColor: stroke },
                pressed && !incDisabled && styles.stepPressed,
                incDisabled && styles.stepDisabled,
              ]}
              testID="edit-details-interval-inc"
            >
              <Text style={[styles.stepGlyph, { color: text }]}>+</Text>
            </Pressable>
          </View>

          {!parsed.valid && (
            <Text
              style={[styles.validation, { color: accentInvalid }]}
              accessibilityLiveRegion="polite"
              testID="edit-details-validation"
            >
              {VALIDATION_COPY}
            </Text>
          )}
        </View>

        {/* CTAs — Cancel (outline) + Save (filled). Inline-styled rather than
            composing <EditorialButton> because the Save needs an interactive
            disabled state distinct from the loading-spinner contract that
            primitive provides. */}
        <View style={styles.ctaRow}>
          <Pressable
            onPress={onCancel}
            accessibilityRole="button"
            accessibilityLabel="Cancel"
            style={({ pressed }) => [
              styles.cta,
              styles.ctaOutline,
              { borderColor: text },
              pressed && styles.stepPressed,
            ]}
            testID="edit-details-cancel"
          >
            <Text style={[styles.ctaLabel, { color: text }]}>Cancel</Text>
          </Pressable>

          <Pressable
            onPress={handleSave}
            disabled={!parsed.valid}
            accessibilityRole="button"
            accessibilityLabel="Save"
            accessibilityState={{ disabled: !parsed.valid }}
            style={({ pressed }) => [
              styles.cta,
              styles.ctaFilled,
              { backgroundColor: text },
              pressed && parsed.valid && styles.stepPressed,
              !parsed.valid && styles.stepDisabled,
            ]}
            testID="edit-details-save"
          >
            <Text style={[styles.ctaLabel, { color: theme.colors.surface }]}>
              Save
            </Text>
          </Pressable>
        </View>
      </View>
    </EditorialBottomSheet>
  );
}

const styles = StyleSheet.create({
  body: {
    paddingTop: 8,
  },
  title: {
    fontFamily: fonts.display.semibold,
    fontSize: 22,
    // E11-003: 22 × 1.45 = 32 (was 28, ratio 1.27).
    lineHeight: 32,
    marginBottom: 16,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowText: {
    flex: 1,
    paddingRight: 12,
  },
  rowLabel: {
    fontFamily: fonts.body.medium,
    fontSize: 16,
    // E11-003: 16 × 1.5 = 24 (was 20, ratio 1.25 — Inter clipped at 310%).
    lineHeight: 24,
  },
  rowHint: {
    fontFamily: fonts.body.regular,
    fontSize: 13,
    // E11-003: 13 × 1.54 = 20 (was 18, ratio 1.38 — just under threshold).
    lineHeight: 20,
    marginTop: 4,
  },
  intervalRow: {
    paddingVertical: 16,
  },
  stepper: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 12,
  },
  stepBtn: {
    // E11-003: minWidth/minHeight (was fixed 44/44) so the +/- glyph can
    // flex with Dynamic Type. 44 is the touch-target floor from E11-002, so
    // the button stays a11y-compliant when not scaled.
    minWidth: 44,
    minHeight: 44,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepGlyph: {
    fontFamily: fonts.display.regular,
    fontSize: 22,
    // E11-003: 22 × 1.45 = 32 (was 26, ratio 1.18 — Fraunces "+"/"−" glyphs
    // pinched against the button border at 310%).
    lineHeight: 32,
  },
  stepPressed: {
    opacity: 0.7,
  },
  stepDisabled: {
    opacity: 0.4,
  },
  input: {
    flex: 1,
    // E11-003: minHeight (was fixed height:44) so the 18-pt text can flex
    // to 56pt+ at 310% Dynamic Type without clipping. paddingVertical
    // preserves the visual rhythm at default scale.
    minHeight: 44,
    paddingVertical: 10,
    marginHorizontal: 12,
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 12,
    fontFamily: fonts.body.medium,
    fontSize: 18,
    textAlign: 'center',
  },
  validation: {
    fontFamily: fonts.body.regular,
    fontSize: 13,
    // E11-003: 13 × 1.54 = 20 (was 18, ratio 1.38).
    lineHeight: 20,
    marginTop: 8,
  },
  ctaRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 12,
    marginTop: 24,
  },
  cta: {
    minHeight: 44,
    paddingVertical: 12,
    paddingHorizontal: 24,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ctaOutline: {
    borderWidth: 1,
    backgroundColor: 'transparent',
  },
  ctaFilled: {
    borderWidth: 0,
  },
  ctaLabel: {
    fontFamily: fonts.display.semibold,
    fontSize: 16,
    // E11-003: 16 × 1.5 = 24 (was 20, ratio 1.25 — Fraunces CTAs need
    // headroom for the descenders in "Cancel" / "Save").
    lineHeight: 24,
  },
});
