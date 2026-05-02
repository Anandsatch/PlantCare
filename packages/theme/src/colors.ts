// Conservatory color tokens. Source of truth: DESIGN.md (sections "Light mode"
// and "Dark mode"). Hex values must round-trip exactly — do not normalize.
//
// `textMuted` is encoded as a separate hex (not rgba) so it composes cleanly
// in React Native StyleSheet, where opacity and color alpha behave differently.
// Composite of base text @ 70% over the mode's bg, per the E0-004 ticket spec.
// Values are treated as the design-system source of truth even though they
// run slightly darker than a strict alpha-blend (true 70% blend would give
// ~#686765 / ~#B7B4AA — within design tolerance).
//   Light:  #2A2A2A on #FAF6EE → #5E5C58
//   Dark:   #FAF6EE on #0F1A12 → #B5B2A8

export type ColorTokens = {
  readonly bg: string;
  readonly surface: string;
  readonly text: string;
  readonly textMuted: string;
  readonly primary: string;
  readonly stroke: string;
  readonly water: string;
  readonly sage: string;
  readonly tan: string;
};

export const lightColors = {
  bg: '#FAF6EE',
  surface: '#FAF6EE',
  text: '#2A2A2A',
  textMuted: '#5E5C58',
  primary: '#1F3826',
  stroke: '#1F3826',
  water: '#A8C5D9',
  sage: '#B8C5A6',
  tan: '#C9A873',
} as const satisfies ColorTokens;

export const darkColors = {
  bg: '#0F1A12',
  surface: '#1F3826',
  text: '#FAF6EE',
  textMuted: '#B5B2A8',
  primary: '#B8C5A6',
  stroke: '#FAF6EE',
  water: '#A8C5D9',
  sage: '#B8C5A6',
  tan: '#C9A873',
} as const satisfies ColorTokens;

export type ColorKey = keyof ColorTokens;
