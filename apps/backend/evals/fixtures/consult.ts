// /api/consult fixtures (E1-005, per test plan & master plan):
//   4 plant-related + 1 off-topic reject = 5 total.
//
// Off-topic fixture wording: "What's the best dog food for a labrador?"
// — invented per the autonomous-build prompt's leeway. The test plan
// example was "a question about my dog"; this concretizes it without
// drifting from intent. FLAG FOR ANAND'S REVIEW: feel free to adjust
// the off-topic prompt to better match your real-world dogfooding mix.

export type ConsultCategory = 'plant_related' | 'off_topic';

export type ConsultExpected =
  | {
      kind: 'recommendation';
      revised_interval_days: number;
      confidence_baseline: number;
    }
  | {
      kind: 'rejected_off_topic';
      // Reason is a short tag per the system prompt.
      reason_includes: string;
    };

export type ConsultFixture = {
  name: string;
  category: ConsultCategory;
  // The user note as the mobile client would send it (the route handler
  // composes a fuller prompt; we feed this through the route-level
  // `buildUserMessage` in the test if/when we exercise the full handler).
  user_note: string;
  mock_response: string;
  expected: ConsultExpected;
};

const json = (o: unknown) => JSON.stringify(o);

export const consultFixtures: ConsultFixture[] = [
  // ── 4 plant-related ────────────────────────────────────────────────
  {
    name: 'leaves_drooping_water_more',
    category: 'plant_related',
    user_note: 'Leaves are drooping and the soil feels dry an inch down. Should I water more often?',
    mock_response: json({
      rejected: false,
      revised_interval_days: 5,
      reasoning: 'Drooping plus dry soil one inch down suggests under-watering — shorten the interval from 7 to 5 days.',
      confidence: 84,
    }),
    expected: { kind: 'recommendation', revised_interval_days: 5, confidence_baseline: 84 },
  },
  {
    name: 'yellow_leaves_overwatered',
    category: 'plant_related',
    user_note: 'Lower leaves turning yellow and falling off. I water every 4 days.',
    mock_response: json({
      rejected: false,
      revised_interval_days: 8,
      reasoning: 'Yellowing lower leaves on a 4-day schedule typically signals overwatering — extend to 8 days and check drainage.',
      confidence: 78,
    }),
    expected: { kind: 'recommendation', revised_interval_days: 8, confidence_baseline: 78 },
  },
  {
    name: 'going_on_vacation',
    category: 'plant_related',
    user_note: 'Going on vacation for 10 days, can I water deeply now and skip while away?',
    mock_response: json({
      rejected: false,
      revised_interval_days: 10,
      reasoning: 'A deep watering before a 10-day absence is reasonable for most houseplants — soil moisture should bridge the gap.',
      confidence: 76,
    }),
    expected: { kind: 'recommendation', revised_interval_days: 10, confidence_baseline: 76 },
  },
  {
    name: 'winter_dormant_period',
    category: 'plant_related',
    user_note: 'It is December and the plant has stopped putting out new leaves. Should I water less?',
    mock_response: json({
      rejected: false,
      revised_interval_days: 14,
      reasoning: 'Winter dormancy slows water uptake — extending the interval to 14 days lets soil dry between drinks.',
      confidence: 81,
    }),
    expected: { kind: 'recommendation', revised_interval_days: 14, confidence_baseline: 81 },
  },

  // ── 1 off-topic reject ─────────────────────────────────────────────
  {
    name: 'off_topic_dog_food',
    category: 'off_topic',
    user_note: "What's the best dog food for a labrador?",
    mock_response: json({
      rejected: true,
      reason: 'not_plant_related',
    }),
    expected: { kind: 'rejected_off_topic', reason_includes: 'not_plant_related' },
  },
];
