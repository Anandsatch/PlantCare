// StatusChip — the right-edge per-row status pill on A-1 (Plants list) and the
// header-adjacent state indicator on A-2 (Plant detail). One component, three
// types: 'water' (Droplet filled, blue accent), 'skip' (LeafIcon, sage accent),
// 'soil' (HandOnSoilIcon, tan accent). The three-color metaphor lock from
// DESIGN.md "Status icon system" — shape + label + accent stroke together
// carry semantic meaning (color contrast on the fill alone is below WCAG
// graphical threshold, so legibility lives in the icon shape and the all-caps
// label, not the accent hue).
//
// Surface treatment (canonical, per DESIGN.md):
//   - rounded-rect pill, `surface` fill (cream in light, forest in dark)
//   - hairline border in the type's accent color (water/sage/tan)
//   - icon left, small all-caps Inter label right
//   - non-interactive in V1 — the parent card row is the pressable surface
//
// The accent mapping is sourced from `@plantcare/theme/statusTokens` so
// future tickets touching the status vocabulary (Quick Diagnose suggestion
// chips, weekly review summary chips) read the same single table and can't
// drift. label, colorKey, and iconName all come from there.

import { statusTokens, type StatusKey } from '@plantcare/theme';
import * as React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { useTheme } from '../../hooks/useTheme';
import { Droplet } from './Droplet';
import { HandOnSoilIcon } from './HandOnSoilIcon';
import { LeafIcon } from './LeafIcon';

// Default accessibility copy per type. VoiceOver reads the parent PlantCard
// label first ("Monstera Mona, water today, last watered 5 days ago") — the
// chip's own label is a fallback for the (rare) usage outside a card row.
// Phrasing is action-as-verb to match the editorial voice ("Water today" not
// "Watering needed").
const DEFAULT_A11Y_LABEL: Record<StatusKey, string> = {
  water: 'Water today',
  skip: 'Skip watering',
  soil: 'Check soil',
} as const;

// Icon size 14 matches the leaf and hand-on-soil defaults; Droplet defaults
// to 16 but is constrained here to 14 so the three chip variants are
// visually balanced (a 16px droplet alongside a 14px leaf reads as drift).
const ICON_SIZE = 14;

export type StatusChipProps = {
  /** Which of the three states this chip represents. Drives icon + accent. */
  type: StatusKey;
  /**
   * Override for VoiceOver. Defaults to "Water today" / "Skip watering" /
   * "Check soil" per DEFAULT_A11Y_LABEL.
   */
  accessibilityLabel?: string;
  /** Forwarded to the outer View for testing-library queries. */
  testID?: string;
};

export function StatusChip({
  type,
  accessibilityLabel,
  testID,
}: StatusChipProps): React.ReactElement {
  const theme = useTheme();
  const token = statusTokens[type];
  const accent = theme.colors[token.colorKey];

  return (
    <View
      testID={testID}
      accessible
      accessibilityLabel={accessibilityLabel ?? DEFAULT_A11Y_LABEL[type]}
      style={[
        styles.chip,
        {
          backgroundColor: theme.colors.surface,
          borderColor: accent,
        },
      ]}
    >
      <StatusIcon type={type} />
      <Text
        style={[styles.label, { color: theme.colors.text }]}
        // The label is decorative inside the chip's own a11y group — the
        // parent View already announces the same string. Marking the Text
        // non-accessible avoids VoiceOver double-reading on iOS.
        accessible={false}
        allowFontScaling
      >
        {token.label}
      </Text>
    </View>
  );
}

function StatusIcon({ type }: { type: StatusKey }): React.ReactElement {
  switch (type) {
    case 'water':
      return <Droplet filled size={ICON_SIZE} />;
    case 'skip':
      return <LeafIcon size={ICON_SIZE} />;
    case 'soil':
      return <HandOnSoilIcon size={ICON_SIZE} />;
  }
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    borderWidth: 1,
    gap: 6,
    alignSelf: 'flex-start',
  },
  label: {
    fontFamily: 'Inter_600SemiBold',
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
});
