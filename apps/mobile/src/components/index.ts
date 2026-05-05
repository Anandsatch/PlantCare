export { CameraPermissionPrePrompt } from './CameraPermissionPrePrompt';
export type { CameraPermissionPrePromptProps } from './CameraPermissionPrePrompt';
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
