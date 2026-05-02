import { SELF, fetchMock } from 'cloudflare:test';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ApiResult, IdentifyResponse } from '@plantcare/api-types';

const URL = 'https://plantcare-api.test/api/identify';
const OPENROUTER = 'https://openrouter.ai';
const OPENROUTER_PATH = '/api/v1/chat/completions';

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

// 1x1 transparent PNG
const PNG_BYTES = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
]);

function makeForm(opts?: { mime?: string; bytes?: Uint8Array; field?: string }) {
  const form = new FormData();
  const mime = opts?.mime ?? 'image/png';
  const bytes = opts?.bytes ?? PNG_BYTES;
  const field = opts?.field ?? 'image';
  // Pass the Uint8Array directly — Blob accepts BufferSource and avoids the
  // SharedArrayBuffer-vs-ArrayBuffer type friction from .buffer.slice().
  form.append(field, new File([bytes], 'plant.png', { type: mime }));
  return form;
}

function mockOpenRouter(content: string, status = 200) {
  fetchMock
    .get(OPENROUTER)
    .intercept({ path: OPENROUTER_PATH, method: 'POST' })
    .reply(status, {
      choices: [{ message: { content } }],
    });
}

const HIGH_CONF = JSON.stringify({
  species_slug: 'monstera_deliciosa',
  species_label: 'Monstera Deliciosa',
  confidence: 92,
  alternatives: [],
});

describe('POST /api/identify', () => {
  it('rejects missing X-Device-Id header', async () => {
    const res = await SELF.fetch(URL, { method: 'POST', body: makeForm() });
    expect(res.status).toBe(400);
    const body = (await res.json()) as ApiResult<IdentifyResponse>;
    expect(body).toEqual({ ok: false, kind: 'error', message: 'missing_or_invalid_device_id' });
  });

  it('rejects too-short device id', async () => {
    const res = await SELF.fetch(URL, {
      method: 'POST',
      headers: { 'X-Device-Id': 'short' },
      body: makeForm(),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as ApiResult<IdentifyResponse>;
    expect(body).toMatchObject({ ok: false, message: 'missing_or_invalid_device_id' });
  });

  it('rejects request with no image field', async () => {
    const form = new FormData();
    form.append('not_image', 'whatever');
    const res = await SELF.fetch(URL, {
      method: 'POST',
      headers: { 'X-Device-Id': 'device-12345678' },
      body: form,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as ApiResult<IdentifyResponse>;
    expect(body).toMatchObject({ ok: false, message: 'missing_image' });
  });

  it('rejects unsupported mime type', async () => {
    const res = await SELF.fetch(URL, {
      method: 'POST',
      headers: { 'X-Device-Id': 'device-12345678' },
      body: makeForm({ mime: 'application/pdf' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as ApiResult<IdentifyResponse>;
    expect(body).toMatchObject({ ok: false, message: 'unsupported_image_type' });
  });

  it('rejects empty image', async () => {
    const res = await SELF.fetch(URL, {
      method: 'POST',
      headers: { 'X-Device-Id': 'device-12345678' },
      body: makeForm({ bytes: new Uint8Array() }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as ApiResult<IdentifyResponse>;
    expect(body).toMatchObject({ ok: false, message: 'image_size_out_of_range' });
  });

  it('returns success on free-tier high-confidence response', async () => {
    mockOpenRouter(HIGH_CONF);
    const res = await SELF.fetch(URL, {
      method: 'POST',
      headers: { 'X-Device-Id': 'device-12345678' },
      body: makeForm(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ApiResult<IdentifyResponse>;
    expect(body.ok).toBe(true);
    if (body.ok && body.kind === 'success') {
      expect(body.data.species_slug).toBe('monstera_deliciosa');
      expect(body.data.confidence).toBe(92);
      expect(body.data.source).toBe('free');
    }
  });

  it('returns degraded fallback when both free and paid OpenRouter calls return 500', async () => {
    // Two interceptors: free call fails, escalation call also fails.
    fetchMock
      .get(OPENROUTER)
      .intercept({ path: OPENROUTER_PATH, method: 'POST' })
      .reply(500, { error: 'upstream' });
    fetchMock
      .get(OPENROUTER)
      .intercept({ path: OPENROUTER_PATH, method: 'POST' })
      .reply(500, { error: 'upstream' });

    const res = await SELF.fetch(URL, {
      method: 'POST',
      headers: { 'X-Device-Id': 'device-12345678' },
      body: makeForm(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ApiResult<IdentifyResponse>;
    if (body.ok && body.kind === 'success') {
      expect(body.data.source).toBe('free_failed');
      expect(body.data.species_slug).toBe('unknown');
      expect(body.data.confidence).toBe(0);
    } else {
      expect.fail('expected ok:true,kind:success degraded fallback');
    }
  });
});
