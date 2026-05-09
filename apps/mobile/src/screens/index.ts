// Screens barrel. Composite screens (CameraResultScreen, AddPlantScreen,
// PlantDetailScreen, etc.) re-export from here so navigation/route registries
// have a single import surface as the screen graph fills in.
export {
  CameraResultScreen,
  type CameraResultScreenProps,
  type CameraResultSavePayload,
  type CameraResultSavePhotoOnlyPayload,
  type CameraResultReportErrorPayload,
} from './CameraResultScreen';

// E4-005 plant detail composite + E4-007 flag-aware mount wrapper. Production
// navigator (E0-008 hasn't shipped yet) should import `<PlantDetailRoute>` so
// the `noteEnabled` prop is fed from the feature flag at exactly one place;
// tests that want to drive the prop directly mount `<PlantDetailScreen>`.
export {
  PlantDetailScreen,
  type PlantDetailScreenProps,
  formatLastWatered,
  resolveSpeciesHeadline,
} from './PlantDetailScreen';
export {
  PlantDetailRoute,
  type PlantDetailRouteProps,
} from './PlantDetailRoute';
