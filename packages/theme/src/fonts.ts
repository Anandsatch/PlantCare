// Conservatory typography tokens. Source of truth: DESIGN.md § Typography.
//
// Two faces, locked weights:
//   - Fraunces (variable serif): 400 regular, 400 italic (plant nicknames),
//     600 semibold (headlines + primary CTAs).
//   - Inter (humanist sans): 400 regular, 500 medium, 600 semibold (body,
//     labels, small all-caps).
//
// The string values mirror the named exports from @expo-google-fonts/fraunces
// and @expo-google-fonts/inter exactly. `useFonts({ Fraunces_400Regular, ... })`
// in the app root registers them under these same names, so referencing
// `fonts.display.regular` resolves to the loaded font family at runtime.
//
// 700/Bold is intentionally absent: the design system lands at 600 semibold
// for emphasis. Adding 700 later is non-breaking — just extend `FontFamily`.

export const fonts = {
  display: {
    regular: 'Fraunces_400Regular',
    italic: 'Fraunces_400Regular_Italic',
    semibold: 'Fraunces_600SemiBold',
  },
  body: {
    regular: 'Inter_400Regular',
    medium: 'Inter_500Medium',
    semibold: 'Inter_600SemiBold',
  },
} as const;

export type FontFamily = (typeof fonts)[keyof typeof fonts][keyof (typeof fonts)[keyof typeof fonts]];
