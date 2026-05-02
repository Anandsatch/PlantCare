// Status icon mapping for the three-color metaphor lock (DESIGN.md §
// "Status icon system"). A future <StatusChip> consumes these so the
// chip is data-driven: pass a `StatusKey`, get label + color + icon.
//
// `iconName` strings are the three primitives E2-006 will build; keep
// them stable so the icon registry can map name → component.

import type { ColorKey } from './colors';

export type StatusKey = 'water' | 'skip' | 'soil';

export type IconName = 'droplet' | 'leaf' | 'handOnSoil';

export type StatusToken = {
  readonly label: string;
  readonly colorKey: ColorKey;
  readonly iconName: IconName;
};

export const statusTokens = {
  water: {
    label: 'WATER TODAY',
    colorKey: 'water',
    iconName: 'droplet',
  },
  skip: {
    label: 'SKIP',
    colorKey: 'sage',
    iconName: 'leaf',
  },
  soil: {
    label: 'CHECK SOIL',
    colorKey: 'tan',
    iconName: 'handOnSoil',
  },
} as const satisfies Record<StatusKey, StatusToken>;
