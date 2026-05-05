/**
 * Static species catalog used by `<AddPlantScreen>` for the manual picker
 * fallback (the 0% match path) and the "Pick from list" affordance on a
 * happy-path result.
 *
 * V1 scope: a small hard-coded list of common houseplants. The full plant
 * taxonomy lands post-V1; documenting the deferral here keeps the contract
 * obvious to the next reader. The slugs match the snake_case identifiers the
 * backend `/api/identify` router uses (`plans/...-design-...md` system prompt
 * § "Backend system prompt"), so picking from this list and saving against an
 * identify result use the same `species_slug` keyspace.
 *
 * The catalog is exported as a `readonly` tuple of `readonly` records so
 * tests can assert against entries without copy-pasting the literals and so
 * any caller that mutates the list trips the type checker.
 *
 * Why a hard-coded list rather than a JSON or remote fetch:
 *   - V1 phone-only, offline-tolerant. A network fetch would re-introduce
 *     the offline-spinner problem the manual picker is *the* answer to.
 *   - The list is short (<20). A JSON file adds a build step without saving
 *     readability.
 *   - Future: when post-V1 ships a real taxonomy, this constant becomes the
 *     migration shim — the picker swaps to a `useSpeciesCatalog()` hook
 *     reading from SQLite, but the picker UI shape stays.
 */

export type SpeciesEntry = {
  /** snake_case wire identifier (matches backend /api/identify keyspace). */
  readonly slug: string;
  /** Title-Case label rendered in the picker. */
  readonly label: string;
};

export const SPECIES_CATALOG: ReadonlyArray<SpeciesEntry> = [
  { slug: 'monstera_deliciosa', label: 'Monstera Deliciosa' },
  { slug: 'pothos', label: 'Pothos' },
  { slug: 'snake_plant', label: 'Snake Plant' },
  { slug: 'pilea_peperomioides', label: 'Pilea Peperomioides' },
  { slug: 'fiddle_leaf_fig', label: 'Fiddle Leaf Fig' },
  { slug: 'rubber_plant', label: 'Rubber Plant' },
  { slug: 'spider_plant', label: 'Spider Plant' },
  { slug: 'zz_plant', label: 'ZZ Plant' },
  { slug: 'philodendron', label: 'Philodendron' },
  { slug: 'peace_lily', label: 'Peace Lily' },
  { slug: 'aloe_vera', label: 'Aloe Vera' },
  { slug: 'jade_plant', label: 'Jade Plant' },
  { slug: 'boston_fern', label: 'Boston Fern' },
  { slug: 'calathea', label: 'Calathea' },
  { slug: 'chinese_money_plant', label: 'Chinese Money Plant' },
  { slug: 'string_of_pearls', label: 'String of Pearls' },
  { slug: 'cactus', label: 'Cactus' },
  { slug: 'succulent_other', label: 'Succulent (Other)' },
  { slug: 'species_unknown', label: 'Other / Not in this list' },
] as const;

/**
 * Case-insensitive substring filter. Folds whitespace at the edges and
 * preserves the original list order — the catalog is curated by frequency,
 * not alphabet, and we keep the first-most-common-first reading.
 */
export function filterSpecies(
  query: string,
  catalog: ReadonlyArray<SpeciesEntry> = SPECIES_CATALOG,
): ReadonlyArray<SpeciesEntry> {
  const q = query.trim().toLowerCase();
  if (q === '') return catalog;
  return catalog.filter(
    (entry) =>
      entry.label.toLowerCase().includes(q) ||
      entry.slug.toLowerCase().includes(q),
  );
}
