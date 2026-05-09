export { DATABASE_NAME, openDb } from './db';
export {
  MIGRATIONS,
  runMigrations,
  targetUserVersion,
  type Migration,
  type SqlExecutor,
} from './migrations';
export { SCHEMA_V1_SQL, V1_INDEXES, V1_TABLES } from './schema';
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
