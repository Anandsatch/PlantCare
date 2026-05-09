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

// E5-011 GardenHomeScreen — camera-modal-host that owns the
// list ↔ camera ↔ result view-state union. FAB tap → identify mode (saves to
// the user's garden via E5-010), FAB long-press → quick-diagnose mode
// (transient: result is shown then discarded; nothing persists). Lives at
// the top level rather than inlined into PlantsListScreen so future deep-link
// routes (notification → camera) and Android hardware-back semantics aren't
// tangled with garden listing.
export {
  GardenHomeScreen,
  type GardenHomeScreenProps,
  type GardenHomeView,
} from './GardenHomeScreen';
