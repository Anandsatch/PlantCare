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
