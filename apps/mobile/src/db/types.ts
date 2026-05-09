/**
 * TypeScript projections of the V1 SQLite tables.
 *
 * Column names are snake_case to mirror `schema.ts` exactly — no marshalling
 * layer between the row shape and the type, so a typo on either side is a
 * type error. Booleans live as `INTEGER` 0|1 in the DB; the type surfaces
 * the JS `boolean` after marshalling and the rows stay numeric on the wire.
 */

/** A row from the `plants` table after boolean marshalling. */
export interface Plant {
  id: string;
  species_slug: string;
  /** Nullable. Populated from /api/identify; null on Quick Diagnose flows. */
  species_label: string | null;
  /** Nullable. User-supplied display name ("Steve"). */
  nickname: string | null;
  /** Nullable. Free-text location ("Living room window"). */
  location: string | null;
  /** Nullable. 0..100 confidence from the identify call that created this row. */
  identify_confidence: number | null;
  /** Nullable. FK to `photos.id` with ON DELETE SET NULL. */
  hero_photo_id: string | null;
  /** Unix milliseconds. Set at create time, immutable. */
  added_at: number;
  /** Unix milliseconds. Soft-delete marker; null = active. */
  archived_at: number | null;
  /** Marshalled from INTEGER 0|1. Defaults to true at create time. */
  is_indoor: boolean;
  /** Nullable. Custom watering interval; overrides species default + weather. */
  override_interval_days: number | null;
}

/** Raw row shape as `better-sqlite3` / `expo-sqlite` actually return it. */
export interface PlantRow {
  id: string;
  species_slug: string;
  species_label: string | null;
  nickname: string | null;
  location: string | null;
  identify_confidence: number | null;
  hero_photo_id: string | null;
  added_at: number;
  archived_at: number | null;
  is_indoor: number;
  override_interval_days: number | null;
}

/**
 * Caller input for `usePlants().create`. All fields optional except
 * `species_slug` because the only required wire data after identify is the
 * slug — the rest can be filled in later via `update`.
 */
export interface CreatePlantInput {
  /** Optional override; auto-generated via `crypto.randomUUID()` when absent. */
  id?: string;
  species_slug: string;
  species_label?: string | null;
  nickname?: string | null;
  location?: string | null;
  identify_confidence?: number | null;
  hero_photo_id?: string | null;
  /** Defaults to true if omitted. */
  is_indoor?: boolean;
  override_interval_days?: number | null;
}

/**
 * Caller input for `usePlants().update`. Everything is optional; `id` is the
 * row key passed positionally so the patch can't accidentally rewrite it.
 * `added_at` is intentionally not patchable — created-at is immutable.
 */
export interface UpdatePlantPatch {
  species_slug?: string;
  species_label?: string | null;
  nickname?: string | null;
  location?: string | null;
  identify_confidence?: number | null;
  hero_photo_id?: string | null;
  is_indoor?: boolean;
  override_interval_days?: number | null;
}

// ─── notes ─────────────────────────────────────────────────────────────

/**
 * Locked enumeration of `notes.consult_status` values written by the mobile
 * app. Mirrors the AddNoteSheet `AddNoteSavedPayload.status` plus the
 * mobile-side `ApiResult` error kinds the sheet may surface; stored verbatim
 * in the TEXT column so the discriminated union is preserved end-to-end and
 * `/learn` can later reason about how often each path fires.
 *
 * Why TEXT (not a CHECK enum):
 *   The wire / client union evolves as new `ApiResult.kind`s land. Adding a
 *   new variant must NOT require a SQLite migration. The mobile-side
 *   `addNote()` validates membership at the boundary against this list; a
 *   typo or hostile input throws before SQL runs. SQLite-level CHECK would
 *   force a migration on every union extension and lose us forward-compat
 *   for free server-side gates (e.g. a future `'low_confidence'` wire kind).
 */
export const CONSULT_STATUS_VALUES = [
  // Locked client kinds the AddNoteSheet may emit on save:
  'ok',
  'queued',
  // Forward-compat: rejected_off_topic notes still persist (we want to keep
  // the user's text + the reject context as a record). Mirrors the master-
  // plan stance that the user's note is theirs to keep, even when the LLM
  // declined to advise on it.
  'rejected_off_topic',
  'low_confidence',
  // Persist failure-mode tails too (timeout / server / parse_error) for the
  // same reason: the user wrote something; we record it. The drainer (E7)
  // can reissue against /api/consult later if we choose to retry.
  'timeout',
  'server',
  'parse_error',
] as const;

export type NoteConsultStatus = (typeof CONSULT_STATUS_VALUES)[number];

/** A row from the `notes` table. */
export interface Note {
  id: string;
  plant_id: string;
  /** Unix milliseconds. Set at create time, immutable. */
  written_at: number;
  /** Trimmed user text. Required (NOT NULL in schema). */
  user_text: string;
  /**
   * Serialized LLM response JSON, or `null` when the request was queued
   * offline / the persist path didn't carry one (rejected_off_topic, etc.).
   * Stored as TEXT; the API reuses `ConsultResponse` from `@plantcare/api-types`.
   */
  llm_response: string | null;
  consult_status: NoteConsultStatus;
}

export interface NoteRow {
  id: string;
  plant_id: string;
  written_at: number;
  user_text: string;
  llm_response: string | null;
  consult_status: string;
}

/**
 * Caller input for `notes.addNote`. `id` and `written_at` auto-fill when
 * absent, matching the `usePlants.create` ergonomics. Every other field is
 * required because the row's invariants are: every note has a plant, every
 * note has user_text, every note records the consult outcome.
 */
export interface CreateNoteInput {
  /** Optional override; auto-generated via `crypto.randomUUID()` when absent. */
  id?: string;
  plant_id: string;
  user_text: string;
  /**
   * The LLM response object, or `null`. Serialized to JSON before the INSERT.
   * Typed `unknown` rather than `ConsultResponse` so the notes layer doesn't
   * pull in `@plantcare/api-types` — the union is owned upstream and the DB
   * is the bottom of the stack.
   */
  llm_response: unknown | null;
  consult_status: NoteConsultStatus;
  /**
   * Optional override for the row's `written_at` timestamp (ms since epoch).
   * Defaults to `Date.now()`. Provided so callers can use the same timestamp
   * they emitted at the UI boundary (AddNoteSheet's `onSave` payload carries
   * one) and so tests can pin time without mocking `Date.now`.
   */
  written_at?: number;
}
