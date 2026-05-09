/**
 * V1 SQLite schema. Single source of truth for the initial migration.
 *
 * Six tables, UUID primary keys, soft delete on `plants` only. Per the master
 * plan (§ "SQLite schema (V1)") plus the WORKBACK additions on `plants`
 * (`is_indoor`, `override_interval_days`) for the indoor/outdoor + custom
 * watering schedule features.
 *
 * Conventions:
 * - All timestamps are unix milliseconds (`INTEGER`). The watering engine
 *   does millisecond math, not calendar-day math, to survive DST flips and
 *   timezone changes (see E4-002 critical regression).
 * - Booleans are `INTEGER` 0|1 with a `CHECK` to keep them honest.
 * - Foreign keys are declared at the column level. They only enforce when the
 *   connection has `PRAGMA foreign_keys = ON` (SQLite default is OFF — set in
 *   `openDb`).
 * - Indexes are kept tight. The 10-plant V1 storage budget doesn't need
 *   speculative indexes that won't pull weight at that scale.
 */
export const SCHEMA_V1_SQL = `
CREATE TABLE plants (
  id                       TEXT PRIMARY KEY,
  species_slug             TEXT NOT NULL,
  species_label            TEXT,
  nickname                 TEXT,
  location                 TEXT,
  identify_confidence      REAL,
  hero_photo_id            TEXT REFERENCES photos(id) ON DELETE SET NULL,
  added_at                 INTEGER NOT NULL,
  archived_at              INTEGER,
  is_indoor                INTEGER NOT NULL DEFAULT 1 CHECK (is_indoor IN (0, 1)),
  override_interval_days   INTEGER
);

CREATE INDEX idx_plants_active
  ON plants(added_at DESC)
  WHERE archived_at IS NULL;

-- Cascade-companion: hero_photo_id REFERENCES photos(id) ON DELETE SET NULL.
-- When a photo is deleted, SQLite must look up referencing plants to null
-- the column. Without this index that's a full table scan. Partial on
-- non-null because the SET NULL path only ever matches non-null rows.
CREATE INDEX idx_plants_hero_photo
  ON plants(hero_photo_id)
  WHERE hero_photo_id IS NOT NULL;

CREATE TABLE watering_events (
  id          TEXT PRIMARY KEY,
  plant_id    TEXT NOT NULL REFERENCES plants(id) ON DELETE CASCADE,
  watered_at  INTEGER NOT NULL,
  source      TEXT NOT NULL,
  note        TEXT
);

CREATE INDEX idx_water_plant_date
  ON watering_events(plant_id, watered_at DESC);

CREATE TABLE photos (
  id        TEXT PRIMARY KEY,
  plant_id  TEXT REFERENCES plants(id) ON DELETE CASCADE,
  uri       TEXT NOT NULL,
  taken_at  INTEGER NOT NULL,
  kind      TEXT NOT NULL,
  width     INTEGER,
  height    INTEGER,
  bytes     INTEGER
);

CREATE INDEX idx_photos_plant
  ON photos(plant_id, taken_at DESC);

CREATE TABLE notes (
  id              TEXT PRIMARY KEY,
  plant_id        TEXT NOT NULL REFERENCES plants(id) ON DELETE CASCADE,
  written_at      INTEGER NOT NULL,
  user_text       TEXT NOT NULL,
  llm_response    TEXT,
  consult_status  TEXT NOT NULL
);

CREATE INDEX idx_notes_plant
  ON notes(plant_id, written_at DESC);

CREATE TABLE diagnoses (
  id                 TEXT PRIMARY KEY,
  plant_id           TEXT REFERENCES plants(id) ON DELETE CASCADE,
  photo_id           TEXT NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
  run_at             INTEGER NOT NULL,
  status             TEXT NOT NULL,
  diagnosis_label    TEXT,
  confidence         REAL,
  body               TEXT,
  fix_steps_json     TEXT,
  alternatives_json  TEXT,
  used_paid_model    INTEGER NOT NULL DEFAULT 0 CHECK (used_paid_model IN (0, 1))
);

CREATE INDEX idx_diagnoses_plant
  ON diagnoses(plant_id, run_at DESC);

-- Cascade-delete companion: when a photo is deleted, SQLite must look up
-- referencing diagnoses rows. Without this index that's a full table scan.
CREATE INDEX idx_diagnoses_photo
  ON diagnoses(photo_id);

CREATE TABLE sync_queue (
  id              TEXT PRIMARY KEY,
  endpoint        TEXT NOT NULL,
  payload_json    TEXT NOT NULL,
  ref_table       TEXT NOT NULL,
  ref_id          TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',
  attempt_count   INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,
  last_error      TEXT
);

CREATE INDEX idx_queue_drainable
  ON sync_queue(status, next_attempt_at)
  WHERE status = 'pending';
`;

/**
 * V2 migration: adds the `llm_calls` table that backs the client-side LLM
 * daily-budget counter (E11-005). The master plan locks the budget to a
 * client-side counter — there is NO `/api/budget` endpoint and NO KV-
 * backed budget. See WORKBACK.md line 590 and the master plan's "free →
 * escalate router" section.
 *
 * Schema:
 *
 *   - `id`            AUTOINCREMENT — keeps row identity stable across
 *                     re-inserts even if a future `vacuum` rebuild would
 *                     otherwise reuse a rowid. AUTOINCREMENT is
 *                     intentional even though the budget hook only reads
 *                     by COUNT(*) today; a future "show me my last 50
 *                     calls" surface would want a stable monotonic id.
 *   - `endpoint`      TEXT — one of 'identify' | 'diagnose' | 'consult' |
 *                     'review'. Stored as TEXT (not a CHECK enum) for the
 *                     same reason `notes.consult_status` is TEXT: a future
 *                     endpoint addition shouldn't trigger a SQLite
 *                     migration. Validation happens at the boundary in
 *                     the recordLlmCall helper (lands in E11-006).
 *   - `called_at_ms`  INTEGER — unix milliseconds. UTC-ms only; the
 *                     budget hook compares against `startOfTodayUtcMs(now)`.
 *                     No calendar math (project-wide E4-002 lock).
 *
 * Index `idx_llm_calls_called_at` supports the budget hook's
 * `COUNT(*) WHERE called_at_ms >= ?` predicate. At V1's 50-rows-per-day
 * scale the index is overkill, but it keeps the read O(log N) for a
 * dogfooding window where the table grows unbounded (no V1 retention
 * policy) — a dogfooder running for 6 months at peak quota lands at
 * ~9000 rows. Without the index a full scan on every render of the
 * Plants list is wasteful.
 */
export const SCHEMA_V2_SQL = `
CREATE TABLE llm_calls (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint      TEXT NOT NULL,
  called_at_ms  INTEGER NOT NULL
);

CREATE INDEX idx_llm_calls_called_at
  ON llm_calls(called_at_ms);
`;

/**
 * Names of every table the V1 migration creates. Exported so tests can verify
 * presence without re-listing them in the test file.
 */
export const V1_TABLES = [
  'plants',
  'watering_events',
  'photos',
  'notes',
  'diagnoses',
  'sync_queue',
] as const;

/**
 * Names of every index the V1 migration creates. SQLite auto-generates
 * `sqlite_autoindex_*` indexes for PRIMARY KEY columns; those are excluded
 * here because they're an implementation detail, not part of our contract.
 */
export const V1_INDEXES = [
  'idx_plants_active',
  'idx_plants_hero_photo',
  'idx_water_plant_date',
  'idx_photos_plant',
  'idx_notes_plant',
  'idx_diagnoses_plant',
  'idx_diagnoses_photo',
  'idx_queue_drainable',
] as const;

/**
 * Names of every table the V2 migration adds. Exported so tests can verify
 * presence after the migration runs without re-listing them in the test
 * file. Cumulative table inventory after V2 = V1_TABLES + V2_TABLES.
 */
export const V2_TABLES = ['llm_calls'] as const;

/** Indexes the V2 migration adds. */
export const V2_INDEXES = ['idx_llm_calls_called_at'] as const;
