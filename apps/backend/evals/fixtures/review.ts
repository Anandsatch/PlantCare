// /api/review fixture (E1-005, per test plan & master plan):
//   1 mixed-week fixture with 6 plants. Asserts:
//   - response shape (headline ≤ 80, narrative 100-400 chars, confidence
//     within ±10 of baseline)
//   - per_plant.length === request.plants.length (the catch from E1-004
//     adversarial review — ensures the model echoed an observation per
//     plant rather than collapsing or expanding the list).

import type { ReviewRequestBody } from '@plantcare/api-types';

export type ReviewFixture = {
  name: string;
  request: ReviewRequestBody;
  mock_response: string;
  expected: {
    confidence_baseline: number;
    narrative_min: number; // 100 per system prompt + test plan
    narrative_max: number; // 400 per system prompt + test plan
    headline_max: number; // 80 per system prompt
  };
};

const json = (o: unknown) => JSON.stringify(o);

const mixedWeekRequest: ReviewRequestBody = {
  week_summary: {
    plants_total: 6,
    watering_events: 14,
    skip_events: 4,
    diagnoses: 1,
  },
  plants: [
    { species_slug: 'monstera_deliciosa', nickname: 'Steve', watering_count: 3, skip_count: 1, had_diagnosis: false },
    { species_slug: 'epipremnum_aureum', nickname: 'Vinnie', watering_count: 2, skip_count: 1, had_diagnosis: false },
    { species_slug: 'sansevieria_trifasciata', nickname: 'Spike', watering_count: 1, skip_count: 0, had_diagnosis: false },
    { species_slug: 'ficus_lyrata', nickname: 'Fig', watering_count: 3, skip_count: 0, had_diagnosis: true },
    { species_slug: 'zamioculcas_zamiifolia', watering_count: 2, skip_count: 1, had_diagnosis: false },
    { species_slug: 'chlorophytum_comosum', nickname: 'Chloe', watering_count: 3, skip_count: 1, had_diagnosis: false },
  ],
};

const mixedWeekMockResponse = json({
  headline: 'A quietly busy week, with one rescue',
  narrative:
    "You held a steady rhythm across six plants this week — fourteen drinks given, four thoughtful skips taken. Fig's diagnosis run was the week's small drama, and the rest of your garden moved without incident. Steve and Chloe both got the consistent attention they prefer. A good editorial week for the conservatory.",
  per_plant: [
    { species_slug: 'monstera_deliciosa', observation: 'Steve drank three times — exactly his weekly cadence.' },
    { species_slug: 'epipremnum_aureum', observation: 'Vinnie skipped once mid-week, otherwise on schedule.' },
    { species_slug: 'sansevieria_trifasciata', observation: 'Spike took a single drink and held steady, as snake plants do.' },
    { species_slug: 'ficus_lyrata', observation: 'Fig got a diagnosis check and three waterings — recovery looks underway.' },
    { species_slug: 'zamioculcas_zamiifolia', observation: 'Two drinks, one skipped day. Comfortable in its rhythm.' },
    { species_slug: 'chlorophytum_comosum', observation: 'Chloe matched Steve at three waterings this week.' },
  ],
  confidence: 82,
});

export const reviewFixtures: ReviewFixture[] = [
  {
    name: 'mixed_week_six_plants',
    request: mixedWeekRequest,
    mock_response: mixedWeekMockResponse,
    expected: {
      confidence_baseline: 82,
      narrative_min: 100,
      narrative_max: 400,
      headline_max: 80,
    },
  },
];
