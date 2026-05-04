// /api/diagnose fixtures (E1-005, per test plan & master plan):
//   7 sick + 2 healthy + 1 cat reject = 10 total.

import type { DiagnoseSeverity } from '@plantcare/api-types';

export type DiagnoseCategory = 'sick' | 'healthy' | 'reject';

export type DiagnoseFixture = {
  name: string;
  category: DiagnoseCategory;
  mock_response: string;
  expected: {
    disease_slug: string;
    confidence_baseline: number;
    severity: DiagnoseSeverity;
    fix_steps_min?: number;
    is_reject?: true;
  };
};

const json = (o: unknown) => JSON.stringify(o);

export const diagnoseFixtures: DiagnoseFixture[] = [
  // ── 7 sick ─────────────────────────────────────────────────────────
  {
    name: 'spider_mites',
    category: 'sick',
    mock_response: json({
      disease_slug: 'spider_mites',
      disease_label: 'Spider mites',
      confidence: 82,
      severity: 'medium',
      fix_steps: [
        'Isolate the plant from neighbors.',
        'Rinse both sides of leaves with lukewarm water.',
        'Apply insecticidal soap weekly for 3 weeks.',
      ],
      alternatives: [],
    }),
    expected: { disease_slug: 'spider_mites', confidence_baseline: 82, severity: 'medium', fix_steps_min: 3 },
  },
  {
    name: 'overwatering_root_rot',
    category: 'sick',
    mock_response: json({
      disease_slug: 'root_rot_overwatering',
      disease_label: 'Root rot from overwatering',
      confidence: 78,
      severity: 'high',
      fix_steps: [
        'Stop watering immediately.',
        'Unpot and inspect roots.',
        'Trim mushy black roots with sterile scissors.',
        'Repot in fresh, well-draining soil.',
      ],
      alternatives: [
        { disease_slug: 'fungal_root_disease', disease_label: 'Fungal root disease', confidence: 11 },
      ],
    }),
    expected: { disease_slug: 'root_rot_overwatering', confidence_baseline: 78, severity: 'high', fix_steps_min: 3 },
  },
  {
    name: 'underwatering',
    category: 'sick',
    mock_response: json({
      disease_slug: 'underwatering',
      disease_label: 'Underwatering',
      confidence: 84,
      severity: 'low',
      fix_steps: [
        'Water deeply until water drains from the bottom.',
        'Check soil moisture every 3 days for the next 2 weeks.',
      ],
      alternatives: [],
    }),
    expected: { disease_slug: 'underwatering', confidence_baseline: 84, severity: 'low', fix_steps_min: 2 },
  },
  {
    name: 'leaf_scorch',
    category: 'sick',
    mock_response: json({
      disease_slug: 'leaf_scorch',
      disease_label: 'Leaf scorch (sunburn)',
      confidence: 76,
      severity: 'medium',
      fix_steps: [
        'Move the plant 2 feet from direct sun.',
        'Trim damaged leaf tips with clean scissors.',
        'Resume normal watering schedule.',
      ],
      alternatives: [],
    }),
    expected: { disease_slug: 'leaf_scorch', confidence_baseline: 76, severity: 'medium', fix_steps_min: 2 },
  },
  {
    name: 'powdery_mildew',
    category: 'sick',
    mock_response: json({
      disease_slug: 'powdery_mildew',
      disease_label: 'Powdery mildew',
      confidence: 80,
      severity: 'medium',
      fix_steps: [
        'Improve air circulation around the plant.',
        'Wipe leaves with a 1:10 milk-water solution weekly.',
        'Avoid wetting leaves when watering.',
      ],
      alternatives: [],
    }),
    expected: { disease_slug: 'powdery_mildew', confidence_baseline: 80, severity: 'medium', fix_steps_min: 2 },
  },
  {
    name: 'nutrient_deficiency_yellowing',
    category: 'sick',
    mock_response: json({
      disease_slug: 'nitrogen_deficiency',
      disease_label: 'Nitrogen deficiency',
      confidence: 72,
      severity: 'low',
      fix_steps: [
        'Apply a balanced houseplant fertilizer at half strength.',
        'Re-evaluate in 2 weeks.',
      ],
      alternatives: [
        { disease_slug: 'iron_deficiency', disease_label: 'Iron deficiency', confidence: 18 },
      ],
    }),
    expected: { disease_slug: 'nitrogen_deficiency', confidence_baseline: 72, severity: 'low', fix_steps_min: 2 },
  },
  {
    name: 'mealybugs',
    category: 'sick',
    mock_response: json({
      disease_slug: 'mealybugs',
      disease_label: 'Mealybugs',
      confidence: 81,
      severity: 'high',
      fix_steps: [
        'Isolate the plant immediately.',
        'Dab visible bugs with 70% isopropyl alcohol on a cotton swab.',
        'Treat weekly with neem oil for 4 weeks.',
        'Inspect neighboring plants for spread.',
      ],
      alternatives: [],
    }),
    expected: { disease_slug: 'mealybugs', confidence_baseline: 81, severity: 'high', fix_steps_min: 3 },
  },

  // ── 2 healthy ─────────────────────────────────────────────────────
  {
    name: 'healthy_monstera',
    category: 'healthy',
    mock_response: json({
      disease_slug: 'healthy',
      disease_label: 'Healthy',
      confidence: 91,
      severity: 'low',
      fix_steps: [],
      alternatives: [],
    }),
    expected: { disease_slug: 'healthy', confidence_baseline: 91, severity: 'low' },
  },
  {
    name: 'healthy_pothos',
    category: 'healthy',
    mock_response: json({
      disease_slug: 'healthy',
      disease_label: 'Healthy',
      confidence: 87,
      severity: 'low',
      fix_steps: [],
      alternatives: [],
    }),
    expected: { disease_slug: 'healthy', confidence_baseline: 87, severity: 'low' },
  },

  // ── 1 cat reject ──────────────────────────────────────────────────
  {
    name: 'cat_not_a_plant',
    category: 'reject',
    mock_response: json({
      disease_slug: 'unknown',
      disease_label: 'Unknown',
      confidence: 6,
      severity: 'low',
      fix_steps: [],
      alternatives: [],
    }),
    expected: { disease_slug: 'unknown', confidence_baseline: 6, severity: 'low', is_reject: true },
  },
];
