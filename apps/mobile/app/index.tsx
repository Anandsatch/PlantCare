import { StatusBar } from 'expo-status-bar';
import { StyleSheet, Text, View } from 'react-native';

// E0-006 placeholder: the Plants list is the home route (no tabs in V1).
// Renders the empty state so Maestro can assert it on launch. E3 replaces
// this with the real list (PlantCard, EmptyGardenWelcome, FAB) per A-1.
export default function Index() {
  return (
    <View testID="plants-list-empty" style={styles.container}>
      <Text style={styles.title}>PlantCare</Text>
      <Text style={styles.subtitle}>No plants yet</Text>
      <StatusBar style="auto" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#FAF6EE',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  title: {
    fontSize: 32,
    color: '#1F3826',
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 16,
    color: '#2A2A2A',
    opacity: 0.7,
  },
});
