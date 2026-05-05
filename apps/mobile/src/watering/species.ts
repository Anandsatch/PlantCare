/**
 * V1 species → base watering interval (days) lookup table.
 *
 * Hardcoded for ~10 common houseplants per the master plan ("Weekend 2 day 2:
 * Hardcode species table for ~10 common houseplants"). All keys are
 * snake_case slugs that match `plants.species_slug` in the SQLite schema.
 *
 * These are *base* intervals — the V1 watering engine treats them as the
 * full interval. E6 (Watering++) layers humidity/temp/rain modifiers on
 * top, but V1 is intentionally species + last-watered + check-soil bias.
 *
 * Numbers are research-backed defaults; tune in dogfooding if a plant
 * consistently underwaters or overwaters at these intervals.
 *
 * `species_unknown` is intentionally absent — engine treats it as "rules
 * disabled, fall back to check_soil" unless the user sets
 * `override_interval_days`.
 */
export const SPECIES_INTERVAL_DAYS: Record<string, number> = {
  monstera_deliciosa: 7,
  ficus_lyrata: 7, // fiddle leaf fig
  pilea_peperomioides: 7,
  pothos_aureum: 10,
  sansevieria_trifasciata: 14, // snake plant
  zamioculcas_zamiifolia: 14, // ZZ plant
  spathiphyllum_wallisii: 5, // peace lily — thirstier than the others
  chlorophytum_comosum: 7, // spider plant
  epipremnum_aureum: 10,
  ficus_elastica: 10, // rubber plant
};

/**
 * Look up the base watering interval (in days) for a species slug.
 * Returns `null` for unknown species — the engine treats null as "rules
 * disabled" and falls back to `check_soil` unless the plant has an
 * `override_interval_days` set.
 */
export function getIntervalDays(species_slug: string): number | null {
  // Object.prototype.hasOwnProperty rather than `slug in map` — guards
  // against a malicious slug like 'toString' or '__proto__' returning a
  // truthy value from the prototype chain.
  if (!Object.prototype.hasOwnProperty.call(SPECIES_INTERVAL_DAYS, species_slug)) {
    return null;
  }
  return SPECIES_INTERVAL_DAYS[species_slug];
}
