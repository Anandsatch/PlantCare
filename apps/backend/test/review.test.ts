import { SELF, fetchMock } from 'cloudflare:test';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ApiResult, ReviewResponse } from '@plantcare/api-types';

const URL = 'https://plantcare-api.test/api/review';
const OPENROUTER = 'https://openrouter.ai';
const OPENROUTER_PATH = '/api/v1/chat/completions';

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

const HIGH_CONF_REVIEW = JSON.stringify({
  headline: 'A quiet week of steady watering',
  narrative:
    "You kept Steve's rhythm steady this week — three drinks, two thoughtful skips. Your garden held its pace.",
  per_plant: [
    { species_slug: 'monstera_deliciosa', observation: 'Steve drank three times — exactly on his weekly cadence.' },
    { species_slug: 'ficus_lyrata', observation: 'A diagnosis run, then quiet recovery for the rest of the week.' },
  ],
  confidence: 88,
});

function mockOpenRouter(content: string, status = 200) {
  fetchMock
    .get(OPENROUTER)
    .intercept({ path: OPENROUTER_PATH, method: 'POST' })
    .reply(status, { choices: [{ message: { content } }] });
}

function jsonRequest(body: unknown, opts?: { deviceId?: string | null }) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const did = opts?.deviceId === undefined ? 'device-12345678' : opts.deviceId;
  if (did !== null) headers['X-Device-Id'] = did;
  return {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  };
}

const VALID_BODY = {
  week_summary: {
    plants_total: 3,
    watering_events: 8,
    skip_events: 5,
    diagnoses: 1,
  },
  plants: [
    {
      species_slug: 'monstera_deliciosa',
      nickname: 'Steve',
      watering_count: 3,
      skip_count: 2,
      had_diagnosis: false,
    },
    {
      species_slug: 'ficus_lyrata',
      watering_count: 2,
      skip_count: 1,
      had_diagnosis: true,
    },
  ],
};

describe('POST /api/review', () => {
  it('rejects missing X-Device-Id header', async () => {
    const res = await SELF.fetch(URL, jsonRequest(VALID_BODY, { deviceId: null }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as ApiResult<ReviewResponse>;
    expect(body).toEqual({ ok: false, kind: 'error', message: 'missing_or_invalid_device_id' });
  });

  it('rejects too-short device id', async () => {
    const res = await SELF.fetch(URL, jsonRequest(VALID_BODY, { deviceId: 'short' }));
    expect(res.status).toBe(400);
  });

  it('rejects malformed JSON body', async () => {
    const res = await SELF.fetch(URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Device-Id': 'device-12345678' },
      body: '{not valid json',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as ApiResult<ReviewResponse>;
    expect(body).toMatchObject({ ok: false, message: 'invalid_json' });
  });

  it('rejects body that is a JSON array', async () => {
    const res = await SELF.fetch(URL, jsonRequest([1, 2, 3]));
    expect(res.status).toBe(400);
    const body = (await res.json()) as ApiResult<ReviewResponse>;
    expect(body).toMatchObject({ ok: false, message: 'invalid_body_shape' });
  });

  it('rejects missing week_summary', async () => {
    const res = await SELF.fetch(URL, jsonRequest({ plants: [] }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as ApiResult<ReviewResponse>;
    expect(body).toMatchObject({ ok: false, message: 'invalid_week_summary' });
  });

  it('rejects fractional plants_total (would shift LLM prompt)', async () => {
    const res = await SELF.fetch(
      URL,
      jsonRequest({
        week_summary: { plants_total: 2.5, watering_events: 0, skip_events: 0, diagnoses: 0 },
        plants: [],
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as ApiResult<ReviewResponse>;
    expect(body).toMatchObject({ ok: false, message: 'invalid_week_summary' });
  });

  it('rejects negative watering_events', async () => {
    const res = await SELF.fetch(
      URL,
      jsonRequest({
        week_summary: { plants_total: 1, watering_events: -1, skip_events: 0, diagnoses: 0 },
        plants: [],
      }),
    );
    expect(res.status).toBe(400);
  });

  it('rejects week_summary count over 300 events', async () => {
    const res = await SELF.fetch(
      URL,
      jsonRequest({
        week_summary: { plants_total: 1, watering_events: 301, skip_events: 0, diagnoses: 0 },
        plants: [],
      }),
    );
    expect(res.status).toBe(400);
  });

  it('rejects plants array over 50 entries', async () => {
    const plants = Array.from({ length: 51 }, (_, i) => ({
      species_slug: `slug_${i}`,
      watering_count: 0,
      skip_count: 0,
      had_diagnosis: false,
    }));
    const res = await SELF.fetch(
      URL,
      jsonRequest({
        week_summary: { plants_total: 1, watering_events: 0, skip_events: 0, diagnoses: 0 },
        plants,
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as ApiResult<ReviewResponse>;
    expect(body).toMatchObject({ ok: false, message: 'invalid_plants' });
  });

  it('rejects plant entry missing species_slug', async () => {
    const res = await SELF.fetch(
      URL,
      jsonRequest({
        week_summary: { plants_total: 1, watering_events: 0, skip_events: 0, diagnoses: 0 },
        plants: [{ watering_count: 0, skip_count: 0, had_diagnosis: false }],
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as ApiResult<ReviewResponse>;
    expect(body).toMatchObject({ ok: false, message: 'invalid_plants' });
  });

  it('rejects plant with non-boolean had_diagnosis', async () => {
    const res = await SELF.fetch(
      URL,
      jsonRequest({
        week_summary: { plants_total: 1, watering_events: 0, skip_events: 0, diagnoses: 0 },
        plants: [
          {
            species_slug: 'monstera_deliciosa',
            watering_count: 0,
            skip_count: 0,
            had_diagnosis: 'no',
          },
        ],
      }),
    );
    expect(res.status).toBe(400);
  });

  it('rejects plant with watering_count over per-plant cap', async () => {
    const res = await SELF.fetch(
      URL,
      jsonRequest({
        week_summary: { plants_total: 1, watering_events: 0, skip_events: 0, diagnoses: 0 },
        plants: [
          {
            species_slug: 'monstera_deliciosa',
            watering_count: 31,
            skip_count: 0,
            had_diagnosis: false,
          },
        ],
      }),
    );
    expect(res.status).toBe(400);
  });

  it('accepts empty plants array (zero-plant nudge path)', async () => {
    mockOpenRouter(
      JSON.stringify({
        headline: 'Ready when you are',
        narrative: 'Add your first plant and your weekly letter starts arriving.',
        per_plant: [],
        confidence: 80,
      }),
    );
    const res = await SELF.fetch(
      URL,
      jsonRequest({
        week_summary: { plants_total: 0, watering_events: 0, skip_events: 0, diagnoses: 0 },
        plants: [],
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as ApiResult<ReviewResponse>;
    if (body.ok && body.kind === 'success') {
      expect(body.data.headline).toBe('Ready when you are');
      expect(body.data.narrative.length).toBeGreaterThan(0);
      expect(body.data.per_plant).toEqual([]);
      expect(body.data.confidence).toBe(80);
      expect(body.data.source).toBe('free');
    } else {
      expect.fail('expected ok:true,kind:success');
    }
  });

  it('returns success on free-tier high-confidence review', async () => {
    mockOpenRouter(HIGH_CONF_REVIEW);
    const res = await SELF.fetch(URL, jsonRequest(VALID_BODY));
    expect(res.status).toBe(200);
    const body = (await res.json()) as ApiResult<ReviewResponse>;
    if (body.ok && body.kind === 'success') {
      expect(body.data.headline).toMatch(/quiet week/);
      expect(body.data.confidence).toBe(88);
      expect(body.data.source).toBe('free');
      expect(body.data.narrative).toMatch(/Steve/);
      expect(body.data.per_plant).toHaveLength(2);
      expect(body.data.per_plant[0]).toEqual({
        species_slug: 'monstera_deliciosa',
        observation: 'Steve drank three times — exactly on his weekly cadence.',
      });
    } else {
      expect.fail('expected ok:true,kind:success');
    }
  });

  it('escalates and returns paid review when free response is unparseable', async () => {
    fetchMock
      .get(OPENROUTER)
      .intercept({ path: OPENROUTER_PATH, method: 'POST' })
      .reply(200, { choices: [{ message: { content: 'I cannot help.' } }] });
    fetchMock
      .get(OPENROUTER)
      .intercept({ path: OPENROUTER_PATH, method: 'POST' })
      .reply(200, { choices: [{ message: { content: HIGH_CONF_REVIEW } }] });

    const res = await SELF.fetch(URL, jsonRequest(VALID_BODY));
    expect(res.status).toBe(200);
    const body = (await res.json()) as ApiResult<ReviewResponse>;
    if (body.ok && body.kind === 'success') {
      expect(body.data.source).toBe('paid_escalated');
    } else {
      expect.fail('expected paid_escalated review');
    }
  });

  it('escalates when free response is low-confidence', async () => {
    const lowConf = JSON.stringify({
      headline: 'A week',
      narrative: 'Some plants got water.',
      per_plant: [],
      confidence: 30,
    });
    fetchMock
      .get(OPENROUTER)
      .intercept({ path: OPENROUTER_PATH, method: 'POST' })
      .reply(200, { choices: [{ message: { content: lowConf } }] });
    fetchMock
      .get(OPENROUTER)
      .intercept({ path: OPENROUTER_PATH, method: 'POST' })
      .reply(200, { choices: [{ message: { content: HIGH_CONF_REVIEW } }] });

    const res = await SELF.fetch(URL, jsonRequest(VALID_BODY));
    expect(res.status).toBe(200);
    const body = (await res.json()) as ApiResult<ReviewResponse>;
    if (body.ok && body.kind === 'success') {
      expect(body.data.source).toBe('paid_escalated');
      expect(body.data.confidence).toBe(88);
    } else {
      expect.fail('expected paid_escalated review');
    }
  });

  it('returns degraded fallback (confidence 0) on full upstream failure', async () => {
    fetchMock
      .get(OPENROUTER)
      .intercept({ path: OPENROUTER_PATH, method: 'POST' })
      .reply(500, { error: 'upstream' });
    fetchMock
      .get(OPENROUTER)
      .intercept({ path: OPENROUTER_PATH, method: 'POST' })
      .reply(500, { error: 'upstream' });

    const res = await SELF.fetch(URL, jsonRequest(VALID_BODY));
    expect(res.status).toBe(200);
    const body = (await res.json()) as ApiResult<ReviewResponse>;
    if (body.ok && body.kind === 'success') {
      expect(body.data.source).toBe('free_failed');
      expect(body.data.confidence).toBe(0);
      expect(body.data.narrative).toMatch(/try again/i);
      expect(body.data.per_plant).toEqual([]);
    } else {
      expect.fail('expected free_failed degraded review');
    }
  });

  it('truncates oversized narrative + headline + observations to spec caps', async () => {
    const huge = JSON.stringify({
      headline: 'a'.repeat(200),
      narrative: 'b'.repeat(2000),
      per_plant: [
        { species_slug: 'monstera_deliciosa', observation: 'c'.repeat(500) },
      ],
      confidence: 85,
    });
    mockOpenRouter(huge);
    const res = await SELF.fetch(URL, jsonRequest(VALID_BODY));
    expect(res.status).toBe(200);
    const body = (await res.json()) as ApiResult<ReviewResponse>;
    if (body.ok && body.kind === 'success') {
      expect(body.data.headline.length).toBe(80);
      expect(body.data.narrative.length).toBe(400);
      expect(body.data.per_plant[0].observation.length).toBe(200);
    } else {
      expect.fail('expected truncated review');
    }
  });

  it('escalates when free response omits per_plant array (contract violation)', async () => {
    const noPerPlant = JSON.stringify({
      headline: 'A week',
      narrative: 'Some plants got water.',
      confidence: 90,
    });
    fetchMock
      .get(OPENROUTER)
      .intercept({ path: OPENROUTER_PATH, method: 'POST' })
      .reply(200, { choices: [{ message: { content: noPerPlant } }] });
    fetchMock
      .get(OPENROUTER)
      .intercept({ path: OPENROUTER_PATH, method: 'POST' })
      .reply(200, { choices: [{ message: { content: HIGH_CONF_REVIEW } }] });

    const res = await SELF.fetch(URL, jsonRequest(VALID_BODY));
    expect(res.status).toBe(200);
    const body = (await res.json()) as ApiResult<ReviewResponse>;
    if (body.ok && body.kind === 'success') {
      expect(body.data.source).toBe('paid_escalated');
      expect(body.data.per_plant).toHaveLength(2);
    } else {
      expect.fail('expected paid_escalated after missing per_plant');
    }
  });

  it('drops per_plant entries with missing or invalid fields', async () => {
    const mixedQuality = JSON.stringify({
      headline: 'Mixed week',
      narrative: 'Some entries good, some hostile.',
      per_plant: [
        { species_slug: 'monstera_deliciosa', observation: 'Good entry.' },
        { species_slug: '', observation: 'Empty slug — drop.' },
        { species_slug: 'ficus_lyrata' }, // missing observation
        null, // hostile null entry
        { species_slug: 'pilea_peperomioides', observation: '   ' }, // whitespace observation
        { species_slug: 'dracaena', observation: 'Valid second entry.' },
      ],
      confidence: 80,
    });
    mockOpenRouter(mixedQuality);
    const res = await SELF.fetch(URL, jsonRequest(VALID_BODY));
    expect(res.status).toBe(200);
    const body = (await res.json()) as ApiResult<ReviewResponse>;
    if (body.ok && body.kind === 'success') {
      expect(body.data.per_plant).toHaveLength(2);
      expect(body.data.per_plant.map((e) => e.species_slug)).toEqual([
        'monstera_deliciosa',
        'dracaena',
      ]);
    } else {
      expect.fail('expected ok:true,kind:success with 2 valid entries');
    }
  });

  it('sends the review system prompt + composed user message as text-arm content', async () => {
    let capturedBody = '';
    fetchMock
      .get(OPENROUTER)
      .intercept({ path: OPENROUTER_PATH, method: 'POST' })
      .reply(200, (opts) => {
        capturedBody = typeof opts.body === 'string' ? opts.body : '';
        return { choices: [{ message: { content: HIGH_CONF_REVIEW } }] };
      });

    await SELF.fetch(URL, jsonRequest(VALID_BODY));

    const parsed = JSON.parse(capturedBody) as {
      messages: { role: string; content: unknown }[];
    };
    expect(parsed.messages[0].content).toMatch(/plant-care editor/);
    expect(typeof parsed.messages[1].content).toBe('string');
    const userText = parsed.messages[1].content as string;
    expect(userText).toContain('plants=3');
    expect(userText).toContain('watering_events=8');
    expect(userText).toContain('Steve (monstera_deliciosa)');
    expect(userText).toContain('ficus_lyrata');
    expect(userText).toContain('diagnosis_run=true');
  });
});
