export { useReduceMotion } from './useReduceMotion';
export { ForcedTheme, ThemeOverrideContext, useTheme } from './useTheme';
export { createPlantsApi, usePlants, type PlantsApi, type PlantsExecutor, type SqlBindValue } from './usePlants';
export { useWateringEngine, type UseWateringEnginePlant } from './useWateringEngine';
export {
  useDiagnoseRequest,
  type DiagnoseInput,
  type DiagnoseStatus,
  type NetInfoLike,
  type PlantContext,
  type UseDiagnoseRequestConfig,
  type UseDiagnoseRequestReturn,
} from './useDiagnoseRequest';
export {
  useIdentifyRequest,
  type IdentifyInput,
  type IdentifyStatus,
  type UseIdentifyRequestConfig,
  type UseIdentifyRequestReturn,
} from './useIdentifyRequest';
export {
  useConsultRequest,
  type ConsultInput,
  type ConsultPlantContext,
  type ConsultStatus,
  type UseConsultRequestConfig,
  type UseConsultRequestReturn,
} from './useConsultRequest';
export {
  useWeather,
  type UseWeatherConfig,
  type UseWeatherReturn,
  type WeatherFetchInput,
  type WeatherFetchResult,
  type WeatherStatus,
} from './useWeather';
export {
  usePersistNote,
  payloadToPersistInput,
  subscribeToNoteEvents,
  type PersistNoteInput,
  type PersistNoteResult,
  type PersistNoteStatus,
  type UsePersistNoteConfig,
  type UsePersistNoteReturn,
} from './usePersistNote';

export {
  enqueueOffline,
  fnv1a32Hex,
  hashStable,
  safeEnqueue,
  type EnqueueWiring,
  type OfflineQueueConfig,
} from './offlineEnqueue';

export {
  useMarkWatered,
  createMarkWateredApi,
  MARK_WATERED_DEBOUNCE_MS,
  type MarkWateredInput,
  type MarkWateredResult,
  type MarkWateredStatus,
  type MarkWateredApi,
  type UseMarkWateredReturn,
  type WateringEventRow,
  type WateringSource,
} from './useMarkWatered';
