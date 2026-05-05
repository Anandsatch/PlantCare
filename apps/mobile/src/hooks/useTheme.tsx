import { darkTheme, lightTheme, type Theme } from '@plantcare/theme';
import { createContext, useContext, type ReactNode } from 'react';
import { useColorScheme } from 'react-native';

// `ThemeOverrideContext` is the SINGLE escape hatch from "system color scheme
// drives the theme." It exists so the dev-only Component Garden screen
// (E2-013) can render every primitive in both light and dark side-by-side
// without spinning up a global <ThemeProvider> at the app root (V1 scope
// lock — see WORKBACK.md E2 + the GSTACK REVIEW REPORT footer of the
// master plan).
//
// In production code paths NOTHING wraps a `ThemeOverrideContext.Provider`
// around any subtree, so the context's default of `null` is what every screen
// reads. `useTheme()` falls through to `useColorScheme()` exactly as before;
// the tree shape is unchanged for app code.
//
// The Garden uses it as: <ThemeOverrideContext.Provider value={darkTheme}>
// to force a single column into Midnight tokens regardless of the device
// scheme. This is the minimum-invasive shim suggested in the E2-013 ticket
// brief — every primitive already calls useTheme, so the override threads
// through automatically without touching primitive call sites.
export const ThemeOverrideContext = createContext<Theme | null>(null);

/**
 * Convenience wrapper for the Garden's dark/light columns. Production code
 * does NOT use this — it's a thin Provider passthrough that exists so the
 * call site reads `<ForcedTheme value={darkTheme}>` instead of leaking the
 * context import shape.
 */
export function ForcedTheme({
  value,
  children,
}: {
  readonly value: Theme;
  readonly children: ReactNode;
}) {
  return (
    <ThemeOverrideContext.Provider value={value}>
      {children}
    </ThemeOverrideContext.Provider>
  );
}

// Anything other than 'dark' (null/undefined during cold start, 'unspecified'
// on Android with no preference, 'light') falls through to lightTheme.
//
// When the optional ThemeOverrideContext is set (Garden only), the override
// wins — the system color scheme is ignored for that subtree.
export function useTheme(): Theme {
  const override = useContext(ThemeOverrideContext);
  if (override) return override;
  return useColorScheme() === 'dark' ? darkTheme : lightTheme;
}
