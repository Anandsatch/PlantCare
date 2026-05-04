import { darkTheme, lightTheme, type Theme } from '@plantcare/theme';
import { useColorScheme } from 'react-native';

// Anything other than 'dark' (null/undefined during cold start, 'unspecified'
// on Android with no preference, 'light') falls through to lightTheme.
export function useTheme(): Theme {
  return useColorScheme() === 'dark' ? darkTheme : lightTheme;
}
