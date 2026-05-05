// Droplet — the watering metaphor primitive shared by <StatusChip type='water'>
// (A-1, A-2) and <WateringLedger> (A-2 7-day row, A-6 weekly review).
//
// Two visual states from a single SVG path so the chip and the ledger never
// drift apart visually:
//   filled=true  → pale-blue water token fill, hairline stroke (a watered day)
//   filled=false → cream surface fill,         hairline stroke (a skipped day / empty)
//
// Tokens are pulled at render time via useTheme(), so the same component
// auto-flips between Conservatory (cream + deep forest stroke) and Midnight
// (forest surface + cream stroke) without any per-icon dark-mode code path.
//
// Decorative by default — the ledger labels each column ("Tuesday, watered")
// at the parent level. accessibilityLabel can be passed in if a caller wants
// to override the inherited label or expose a single-droplet usage.

import * as React from 'react';
import Svg, { Path } from 'react-native-svg';

import { useTheme } from '../../hooks/useTheme';

// Classic teardrop on a 24-unit canvas, point-up. Drawn once at module top so
// the JSX stays declarative and the shape can be referenced in design QA
// without grepping inline strings.
const DROPLET_VIEWBOX = '0 0 24 24';
const DROPLET_PATH =
  'M12 2.5 C12 2.5, 5 10.5, 5 15.2 C5 19.5, 8.13 22, 12 22 C15.87 22, 19 19.5, 19 15.2 C19 10.5, 12 2.5, 12 2.5 Z';

export type DropletProps = {
  /** When true, the droplet renders pale-blue (a watered day). Default false. */
  filled?: boolean;
  /** Square size in px. Default 16 — matches A-1 status chip + A-2 ledger row. */
  size?: number;
  /** Forwarded to the Svg root for testing-library queries. */
  testID?: string;
  /** Forwarded to the Svg root. Decorative by default; parent typically labels. */
  accessibilityLabel?: string;
};

export function Droplet({
  filled = false,
  size = 16,
  testID,
  accessibilityLabel,
}: DropletProps): React.ReactElement {
  const theme = useTheme();
  const fill = filled ? theme.colors.water : theme.colors.surface;
  const stroke = theme.colors.stroke;

  return (
    <Svg
      width={size}
      height={size}
      viewBox={DROPLET_VIEWBOX}
      testID={testID}
      accessibilityLabel={accessibilityLabel}
    >
      <Path d={DROPLET_PATH} fill={fill} stroke={stroke} strokeWidth={1} />
    </Svg>
  );
}
