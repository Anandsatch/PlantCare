// Theme bundles. Future tickets layer additional token groups onto this type
// (E0-005 typography, E2 spacing/radius/motion). Adding optional fields to
// `Theme` is non-breaking; required fields stay required so screens that
// already consume `colors`/`scheme` keep compiling.

import { darkColors, lightColors, type ColorTokens } from './colors';

export type ColorScheme = 'light' | 'dark';

export type Theme = {
  readonly scheme: ColorScheme;
  readonly colors: ColorTokens;
};

export const lightTheme = {
  scheme: 'light',
  colors: lightColors,
} as const satisfies Theme;

export const darkTheme = {
  scheme: 'dark',
  colors: darkColors,
} as const satisfies Theme;
