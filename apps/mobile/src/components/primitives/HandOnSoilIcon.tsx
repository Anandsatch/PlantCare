// HandOnSoilIcon — the CHECK-SOIL metaphor. An open palm hovering over /
// touching a small soil mound. Same line-drawn deep-forest treatment as the
// leaf so the chip family reads as one icon vocabulary.
//
// Renders inside <StatusChip type='soil'>. Outline-only (cream fill + hairline
// stroke); the chip carries the tan accent.
//
// Composition: a soil mound at the bottom (a shallow arc) and an open hand
// above it (palm + four finger strokes). At 14px the palm shape is the primary
// silhouette signal; the fingers register as texture rather than countable
// digits, which is fine — legibility lives in the palm + soil pairing.

import * as React from 'react';
import Svg, { Path } from 'react-native-svg';

import { useTheme } from '../../hooks/useTheme';

const HAND_VIEWBOX = '0 0 24 24';
// Soil mound: shallow arc resting on the bottom edge of the canvas.
const SOIL = 'M2 20 C7 16, 17 16, 22 20 L22 22 L2 22 Z';
// Open palm: rounded-rectangle silhouette tilted slightly, base ~y=14, top ~y=8.
const PALM = 'M6 14 C6 10, 8 8, 12 8 C16 8, 18 10, 18 14 L18 16 L6 16 Z';
// Four finger strokes radiating from the palm top — short, evenly spaced.
const FINGERS = 'M8 8 L8 5 M11 8 L11 4.5 M14 8 L14 4.5 M17 8 L17 5.5';

export type HandOnSoilIconProps = {
  size?: number;
  testID?: string;
  accessibilityLabel?: string;
};

export function HandOnSoilIcon({
  size = 14,
  testID,
  accessibilityLabel,
}: HandOnSoilIconProps): React.ReactElement {
  const theme = useTheme();
  const fill = theme.colors.surface;
  const stroke = theme.colors.stroke;

  return (
    <Svg
      width={size}
      height={size}
      viewBox={HAND_VIEWBOX}
      testID={testID}
      accessibilityLabel={accessibilityLabel}
    >
      <Path d={SOIL} fill={fill} stroke={stroke} strokeWidth={1} />
      <Path d={PALM} fill={fill} stroke={stroke} strokeWidth={1} />
      <Path
        d={FINGERS}
        fill="none"
        stroke={stroke}
        strokeWidth={1}
        strokeLinecap="round"
      />
    </Svg>
  );
}
