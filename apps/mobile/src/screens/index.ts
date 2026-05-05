// Screens barrel. Composite screens (CameraResultScreen, AddPlantScreen,
// PlantDetailScreen, etc.) re-export from here so navigation/route registries
// have a single import surface as the screen graph fills in.
export {
  CameraResultScreen,
  type CameraResultScreenProps,
  type CameraResultSavePayload,
} from './CameraResultScreen';
