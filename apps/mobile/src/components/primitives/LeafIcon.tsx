// LeafIcon — the SKIP-state metaphor primitive. Single asymmetric leaf with a
// central vein, line-drawn on cream — the "deep-forest line drawing on cream
// paper" aesthetic that keeps PlantCare from reading as a sticker-pack app.
//
// Renders inside <StatusChip type='skip'> on A-1 list rows and A-2 detail.
// Always outline-only (cream surface fill + hairline stroke); the chip wrapper
// carries the sage accent so the leaf shape itself stays neutral and reads
// from a 4-foot pocket distance.
//
// Tokens via useTheme(): swaps cream→forest fill and forest→cream stroke
// automatically when the system flips to dark mode.

import * as React from 'react';
import Svg, { Path } from 'react-native-svg';

import { useTheme } from '../../hooks/useTheme';

const LEAF_VIEWBOX = '0 0 24 24';
// Asymmetric pointed-tip leaf, base at lower-left, tip at upper-right.
// The curve on the right side is fuller than the left — botanical, not heraldic.
const LEAF_OUTLINE =
  'M4 20 C4 12, 9 5, 20 4 C19 15, 12 20, 4 20 Z';
// Central vein from base to tip, slightly off-axis to honor the leaf's asymmetry.
const LEAF_VEIN = 'M4 20 C8 16, 14 10, 20 4';

export type LeafIconProps = {
  size?: number;
  testID?: string;
  accessibilityLabel?: string;
};

export function LeafIcon({
  size = 14,
  testID,
  accessibilityLabel,
}: LeafIconProps): React.ReactElement {
  const theme = useTheme();
  const fill = theme.colors.surface;
  const stroke = theme.colors.stroke;

  return (
    <Svg
      width={size}
      height={size}
      viewBox={LEAF_VIEWBOX}
      testID={testID}
      accessibilityLabel={accessibilityLabel}
    >
      <Path d={LEAF_OUTLINE} fill={fill} stroke={stroke} strokeWidth={1} />
      <Path
        d={LEAF_VEIN}
        fill="none"
        stroke={stroke}
        strokeWidth={1}
        strokeLinecap="round"
      />
    </Svg>
  );
}
