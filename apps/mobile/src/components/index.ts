export { CameraPermissionPrePrompt } from './CameraPermissionPrePrompt';
export type { CameraPermissionPrePromptProps } from './CameraPermissionPrePrompt';
export { LocationPermissionPrePrompt } from './LocationPermissionPrePrompt';
export type {
  LocationCoords,
  LocationPermissionPrePromptProps,
} from './LocationPermissionPrePrompt';
export { EmptyGardenWelcome, HEADLINE_TEXT, BODY_TEXT, CTA_LABEL } from './EmptyGardenWelcome';
export type { EmptyGardenWelcomeProps } from './EmptyGardenWelcome';
export { DiagnoseLoadingState } from './DiagnoseLoadingState';
export type { DiagnoseLoadingStateProps } from './DiagnoseLoadingState';
// Barrel for top-level components. Primitives have their own barrel under
// `./primitives`; component-shaped UI (WateringLedger, PlantCard, etc.) is
// re-exported from here.
export { WateringLedger } from './WateringLedger';
export type { WateringEvent, WateringLedgerProps } from './WateringLedger';
// Components barrel. Composites that aren't primitive enough to live in
// `./primitives` (e.g. screen-level rows like PhotoTimeline) re-export here.
export { PhotoTimeline, formatRelativeDate, type PhotoEntry, type PhotoTimelineProps } from './PhotoTimeline';
export {
  PlantCard,
  composeAccessibilityLabel,
  composePressableStyle,
  formatLastWatered,
  localDayDelta,
  type PlantCardProps,
} from './PlantCard';
export { PlantCareCameraView } from './CameraView';
export type {
  CameraCaptureResult,
  CameraMode,
  PlantCareCameraViewProps,
} from './CameraView';
export {
  SundayLetterCard,
  shouldRender as shouldRenderSundayLetter,
  TITLE_TEXT as SUNDAY_LETTER_TITLE,
  BODY_TEXT as SUNDAY_LETTER_BODY,
  OPEN_LABEL as SUNDAY_LETTER_OPEN_LABEL,
  DISMISS_LABEL as SUNDAY_LETTER_DISMISS_LABEL,
} from './SundayLetterCard';
export type { SundayLetterCardProps } from './SundayLetterCard';
export { AddNoteSheet, derivePhase } from './AddNoteSheet';
export type {
  AddNoteSavedPayload,
  AddNoteSheetProps,
} from './AddNoteSheet';
