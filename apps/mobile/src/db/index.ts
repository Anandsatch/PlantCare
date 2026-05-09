export { DATABASE_NAME, openDb } from './db';
export {
  MIGRATIONS,
  runMigrations,
  targetUserVersion,
  type Migration,
  type SqlExecutor,
} from './migrations';
export {
  SCHEMA_V1_SQL,
  SCHEMA_V2_SQL,
  V1_INDEXES,
  V1_TABLES,
  V2_INDEXES,
  V2_TABLES,
} from './schema';
export {
  wateringEventsBus,
  type WateringBusEvent,
  type WateringBusListener,
  type WateringEventsBus,
} from './wateringEvents';
export type {
  CreatePlantInput,
  Plant,
  PlantRow,
  UpdatePlantPatch,
} from './types';
export { CONSULT_STATUS_VALUES } from './types';
export type {
  CreateNoteInput,
  Note,
  NoteConsultStatus,
  NoteRow,
} from './types';
export { createNotesApi, useNotes } from './notes';
export type { NotesApi, NotesExecutor } from './notes';
