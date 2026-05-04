import { SELF, fetchMock } from 'cloudflare:test';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ApiResult, ConsultResponse } from '@plantcare/api-types';

const URL = 'https://plantcare-api.test/api/consult';
const OPENROUTER = 'https://openrouter.ai';
const OPENROUTER_PATH = '/api/v1/chat/completions';

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

const HIGH_CONF_RECOMMENDATION = JSON.stringify({
  rejected: false,
  revised_interval_days: 5,
  reasoning: 'Repotting briefly slows transpiration; back off to every 5 days.',
  confidence: 85,
});

const REJECTED = JSON.stringify({
  rejected: true,
  reason: 'not_plant_related',
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
  note: 'I just repotted my plant.',
  plant_context: { species_slug: 'monstera_deliciosa', is_indoor: true },
};

describe('POST /api/consult', () => {
  it('rejects missing X-Device-Id header', async () => {
    const res = await SELF.fetch(URL, jsonRequest(VALID_BODY, { deviceId: null }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as ApiResult<ConsultResponse>;
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
    const body = (await res.json()) as ApiResult<ConsultResponse>;
    expect(body).toMatchObject({ ok: false, message: 'invalid_json' });
  });

  it('rejects body that is a JSON array', async () => {
    const res = await SELF.fetch(URL, jsonRequest([1, 2, 3]));
    expect(res.status).toBe(400);
    const body = (await res.json()) as ApiResult<ConsultResponse>;
    expect(body).toMatchObject({ ok: false, message: 'invalid_body_shape' });
  });

  it('rejects missing note', async () => {
    const res = await SELF.fetch(URL, jsonRequest({ plant_context: {} }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as ApiResult<ConsultResponse>;
    expect(body).toMatchObject({ ok: false, message: 'missing_or_invalid_note' });
  });

  it('rejects empty / whitespace-only note', async () => {
    const res = await SELF.fetch(URL, jsonRequest({ note: '   \n\t  ' }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as ApiResult<ConsultResponse>;
    expect(body).toMatchObject({ ok: false, message: 'missing_or_invalid_note' });
  });

  it('rejects note over 2000 chars', async () => {
    const huge = 'a'.repeat(2001);
    const res = await SELF.fetch(URL, jsonRequest({ note: huge }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as ApiResult<ConsultResponse>;
    expect(body).toMatchObject({ ok: false, message: 'note_too_long' });
  });

  it('accepts note at the 2000-char boundary', async () => {
    mockOpenRouter(HIGH_CONF_RECOMMENDATION);
    const res = await SELF.fetch(URL, jsonRequest({ note: 'a'.repeat(2000) }));
    expect(res.status).toBe(200);
  });

  it('rejects invalid plant_context shape (non-boolean is_indoor)', async () => {
    const res = await SELF.fetch(
      URL,
      jsonRequest({ note: 'fine', plant_context: { is_indoor: 'yes' } }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as ApiResult<ConsultResponse>;
    expect(body).toMatchObject({ ok: false, message: 'invalid_plant_context' });
  });

  it('rejects fractional override_interval_days (would round to 0 and break prompt)', async () => {
    // Regression: 0.2 used to pass v > 0 then Math.round to 0, leaking
    // current_interval_days=0 into the LLM prompt. Strict integer required.
    const res = await SELF.fetch(
      URL,
      jsonRequest({ note: 'fine', plant_context: { override_interval_days: 0.2 } }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as ApiResult<ConsultResponse>;
    expect(body).toMatchObject({ ok: false, message: 'invalid_plant_context' });
  });

  it('rejects override_interval_days = 0 (must be at least 1 day)', async () => {
    const res = await SELF.fetch(
      URL,
      jsonRequest({ note: 'fine', plant_context: { override_interval_days: 0 } }),
    );
    expect(res.status).toBe(400);
  });

  it('accepts override_interval_days = null (explicit "no override")', async () => {
    mockOpenRouter(HIGH_CONF_RECOMMENDATION);
    const res = await SELF.fetch(
      URL,
      jsonRequest({ note: 'fine', plant_context: { override_interval_days: null } }),
    );
    expect(res.status).toBe(200);
  });

  it('rejects watering_history with too many entries', async () => {
    const hist = Array.from({ length: 8 }, (_, i) => ({ day_offset: -i, watered: false }));
    const res = await SELF.fetch(
      URL,
      jsonRequest({ note: 'fine', plant_context: { watering_history: hist } }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as ApiResult<ConsultResponse>;
    expect(body).toMatchObject({ ok: false, message: 'invalid_plant_context' });
  });

  it('returns success on free-tier high-confidence recommendation', async () => {
    mockOpenRouter(HIGH_CONF_RECOMMENDATION);
    const res = await SELF.fetch(URL, jsonRequest(VALID_BODY));
    expect(res.status).toBe(200);
    const body = (await res.json()) as ApiResult<ConsultResponse>;
    if (body.ok && body.kind === 'success' && body.data.kind === 'recommendation') {
      expect(body.data.revised_interval_days).toBe(5);
      expect(body.data.confidence).toBe(85);
      expect(body.data.source).toBe('free');
      expect(body.data.reasoning).toMatch(/Repotting/);
    } else {
      expect.fail('expected ok:true,kind:success,data.kind:recommendation');
    }
  });

  it('routes off-topic rejection to ApiResult.rejected_off_topic at the wire', async () => {
    mockOpenRouter(REJECTED);
    const res = await SELF.fetch(
      URL,
      jsonRequest({ note: 'What is the capital of Bolivia?' }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as ApiResult<ConsultResponse>;
    expect(body).toEqual({
      ok: false,
      kind: 'rejected_off_topic',
      message: 'not_plant_related',
    });
  });

  it('rejection path does NOT escalate to paid (one upstream call only)', async () => {
    // Single interceptor → if rejection escalated, fetchMock would throw on
    // the second call (no interceptor registered). assertNoPendingInterceptors
    // in afterEach also confirms exactly one interceptor was consumed.
    mockOpenRouter(REJECTED);
    const res = await SELF.fetch(
      URL,
      jsonRequest({ note: 'Tell me a joke about water.' }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as ApiResult<ConsultResponse>;
    expect(body.ok).toBe(false);
    if (!body.ok) {
      expect(body.kind).toBe('rejected_off_topic');
    }
  });

  it('escalates and returns paid recommendation when free response is unparseable', async () => {
    fetchMock
      .get(OPENROUTER)
      .intercept({ path: OPENROUTER_PATH, method: 'POST' })
      .reply(200, { choices: [{ message: { content: 'I cannot help.' } }] });
    fetchMock
      .get(OPENROUTER)
      .intercept({ path: OPENROUTER_PATH, method: 'POST' })
      .reply(200, { choices: [{ message: { content: HIGH_CONF_RECOMMENDATION } }] });

    const res = await SELF.fetch(URL, jsonRequest(VALID_BODY));
    expect(res.status).toBe(200);
    const body = (await res.json()) as ApiResult<ConsultResponse>;
    if (body.ok && body.kind === 'success' && body.data.kind === 'recommendation') {
      expect(body.data.source).toBe('paid_escalated');
    } else {
      expect.fail('expected paid_escalated recommendation');
    }
  });

  it('returns degraded fallback (success-shaped recommendation, confidence 0) on full upstream failure', async () => {
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
    const body = (await res.json()) as ApiResult<ConsultResponse>;
    if (body.ok && body.kind === 'success' && body.data.kind === 'recommendation') {
      expect(body.data.source).toBe('free_failed');
      expect(body.data.confidence).toBe(0);
      expect(body.data.reasoning).toMatch(/try again/i);
    } else {
      expect.fail('expected free_failed degraded recommendation');
    }
  });

  it('sends the consult system prompt + composed user message as text-arm content', async () => {
    let capturedBody = '';
    fetchMock
      .get(OPENROUTER)
      .intercept({ path: OPENROUTER_PATH, method: 'POST' })
      .reply(200, (opts) => {
        capturedBody = typeof opts.body === 'string' ? opts.body : '';
        return { choices: [{ message: { content: HIGH_CONF_RECOMMENDATION } }] };
      });

    await SELF.fetch(
      URL,
      jsonRequest({
        note: 'Leaves are drooping.',
        plant_context: {
          species_slug: 'ficus_lyrata',
          is_indoor: true,
          watering_history: [
            { day_offset: -3, watered: true },
            { day_offset: -7, watered: true },
          ],
        },
      }),
    );

    const parsed = JSON.parse(capturedBody) as {
      messages: { role: string; content: unknown }[];
    };
    expect(parsed.messages[0].content).toMatch(/plant care advisor/);
    // Text-arm: content is a string, not an image_url array.
    expect(typeof parsed.messages[1].content).toBe('string');
    const userText = parsed.messages[1].content as string;
    expect(userText).toContain('ficus_lyrata');
    expect(userText).toContain('indoor=true');
    expect(userText).toContain('day -3=watered');
    expect(userText).toContain('Note: Leaves are drooping.');
  });
});
