import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('GET /health', () => {
  it('returns ok=true and a numeric timestamp', async () => {
    const res = await SELF.fetch('https://plantcare-api.test/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; ts: number };
    expect(body.ok).toBe(true);
    expect(typeof body.ts).toBe('number');
  });
});
