import {
  Fraunces_400Regular,
  Fraunces_400Regular_Italic,
  Fraunces_600SemiBold,
} from '@expo-google-fonts/fraunces';
import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
} from '@expo-google-fonts/inter';
import { lightColors } from '@plantcare/theme';
import { useFonts } from 'expo-font';
import { Stack } from 'expo-router';
import { View } from 'react-native';

// E0-005: gate first render until Fraunces + Inter are loaded. DESIGN.md §
// Typography mandates "no system-ui fallback rendered" — without this gate,
// users would briefly see system font for the ~200ms warm-up before the
// Conservatory fonts swap in, which reads as "AI slop / generic React Native"
// against the editorial paper aesthetic. The placeholder uses the Conservatory
// `surface` color (light mode cream) so the splash blends with both system
// launch screens during cold start.

export default function RootLayout() {
  const [fontsLoaded] = useFonts({
    Fraunces_400Regular,
    Fraunces_400Regular_Italic,
    Fraunces_600SemiBold,
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
  });

  if (!fontsLoaded) {
    return <View style={{ flex: 1, backgroundColor: lightColors.surface }} />;
  }

  return <Stack screenOptions={{ headerShown: false }} />;
}
