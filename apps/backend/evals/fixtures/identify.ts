// /api/identify fixtures (E1-005, per test plan & master plan):
//   6 healthy + 2 partial + 1 low-light + 1 cat reject = 10 total.
//
// Each fixture pairs the canonical LLM JSON we expect the prompt to elicit
// with a baseline confidence used by the ±10 band assertion. Image bytes
// are NOT inlined here — V1 evals run in mock mode and parse the canned
// response directly. When EVAL_REAL_API=1 lands, this file will gain a
// sibling fixtures/identify-images/<slug>.b64 path per fixture.

export type IdentifyCategory = 'healthy' | 'partial' | 'low_light' | 'reject';

export type IdentifyFixture = {
  name: string;
  category: IdentifyCategory;
  // Canonical LLM JSON. In real-API mode this is replaced by the live
  // model's actual content; in mock mode we feed it directly.
  mock_response: string;
  expected: {
    species_slug: string;
    confidence_baseline: number;
    // Reject fixtures should land in the `unknown` slug per the system
    // prompt, with confidence < 30. We assert that explicitly rather than
    // applying the band check.
    is_reject?: true;
  };
};

const json = (o: unknown) => JSON.stringify(o);

export const identifyFixtures: IdentifyFixture[] = [
  // ── 6 healthy ───────────────────────────────────────────────────────
  {
    name: 'monstera_deliciosa_healthy',
    category: 'healthy',
    mock_response: json({
      species_slug: 'monstera_deliciosa',
      species_label: 'Monstera Deliciosa',
      confidence: 92,
      alternatives: [
        { species_slug: 'philodendron_hederaceum', species_label: 'Heartleaf Philodendron', confidence: 6 },
      ],
    }),
    expected: { species_slug: 'monstera_deliciosa', confidence_baseline: 92 },
  },
  {
    name: 'pothos_healthy',
    category: 'healthy',
    mock_response: json({
      species_slug: 'epipremnum_aureum',
      species_label: 'Golden Pothos',
      confidence: 88,
      alternatives: [],
    }),
    expected: { species_slug: 'epipremnum_aureum', confidence_baseline: 88 },
  },
  {
    name: 'snake_plant_healthy',
    category: 'healthy',
    mock_response: json({
      species_slug: 'sansevieria_trifasciata',
      species_label: 'Snake Plant',
      confidence: 90,
      alternatives: [],
    }),
    expected: { species_slug: 'sansevieria_trifasciata', confidence_baseline: 90 },
  },
  {
    name: 'fiddle_leaf_fig_healthy',
    category: 'healthy',
    mock_response: json({
      species_slug: 'ficus_lyrata',
      species_label: 'Fiddle Leaf Fig',
      confidence: 84,
      alternatives: [
        { species_slug: 'ficus_elastica', species_label: 'Rubber Plant', confidence: 9 },
      ],
    }),
    expected: { species_slug: 'ficus_lyrata', confidence_baseline: 84 },
  },
  {
    name: 'zz_plant_healthy',
    category: 'healthy',
    mock_response: json({
      species_slug: 'zamioculcas_zamiifolia',
      species_label: 'ZZ Plant',
      confidence: 86,
      alternatives: [],
    }),
    expected: { species_slug: 'zamioculcas_zamiifolia', confidence_baseline: 86 },
  },
  {
    name: 'spider_plant_healthy',
    category: 'healthy',
    mock_response: json({
      species_slug: 'chlorophytum_comosum',
      species_label: 'Spider Plant',
      confidence: 89,
      alternatives: [],
    }),
    expected: { species_slug: 'chlorophytum_comosum', confidence_baseline: 89 },
  },

  // ── 2 partial (cropped/occluded — model should still ID with lower confidence) ─
  {
    name: 'monstera_partial_leaf',
    category: 'partial',
    mock_response: json({
      species_slug: 'monstera_deliciosa',
      species_label: 'Monstera Deliciosa',
      confidence: 74,
      alternatives: [
        { species_slug: 'philodendron_bipinnatifidum', species_label: 'Tree Philodendron', confidence: 14 },
      ],
    }),
    expected: { species_slug: 'monstera_deliciosa', confidence_baseline: 74 },
  },
  {
    name: 'pothos_partial_vine',
    category: 'partial',
    mock_response: json({
      species_slug: 'epipremnum_aureum',
      species_label: 'Golden Pothos',
      confidence: 71,
      alternatives: [
        { species_slug: 'scindapsus_pictus', species_label: 'Satin Pothos', confidence: 18 },
      ],
    }),
    expected: { species_slug: 'epipremnum_aureum', confidence_baseline: 71 },
  },

  // ── 1 low-light (dim photo — confidence should sit just above threshold) ─
  {
    name: 'snake_plant_low_light',
    category: 'low_light',
    mock_response: json({
      species_slug: 'sansevieria_trifasciata',
      species_label: 'Snake Plant',
      confidence: 73,
      alternatives: [],
    }),
    expected: { species_slug: 'sansevieria_trifasciata', confidence_baseline: 73 },
  },

  // ── 1 cat reject (Layer-5 image-is-plant gate is post-V1 per master plan;
  // for V1 we rely on the model returning unknown w/ low confidence) ─
  {
    name: 'cat_not_a_plant',
    category: 'reject',
    mock_response: json({
      species_slug: 'unknown',
      species_label: 'Unknown',
      confidence: 8,
      alternatives: [],
    }),
    expected: { species_slug: 'unknown', confidence_baseline: 8, is_reject: true },
  },
];
