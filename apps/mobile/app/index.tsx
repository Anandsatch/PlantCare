import { StatusBar } from 'expo-status-bar';
import { StyleSheet, Text, View } from 'react-native';

// E0-001 placeholder. E2/E3 replace this with the real Plants list (A-1).
export default function Index() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>PlantCare</Text>
      <Text style={styles.subtitle}>Your garden, here.</Text>
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
