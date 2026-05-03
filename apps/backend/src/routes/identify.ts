// POST /api/identify
// Request: multipart/form-data with `image` (image/* file)
//          + header `X-Device-Id` (UUID, set client-side at first launch)
// Response: ApiResult<IdentifyResponse>

import { Hono } from 'hono';
import type { ApiResult, IdentifyResponse } from '@plantcare/api-types';
import type { HonoEnv } from '../env';
import { identifyRouter } from '../llm/router';
import { parseImageUpload } from './_imageUpload';

export const identifyRoute = new Hono<HonoEnv>().post('/', async (c) => {
  // Pre-flight: misconfiguration must short-circuit BEFORE we read the
  // multipart body, so a Worker without OPENROUTER_API_KEY doesn't burn
  // memory + CPU parsing 8MB uploads it would immediately reject.
  const apiKey = c.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return c.json<ApiResult<IdentifyResponse>>(
      { ok: false, kind: 'error', message: 'service_unconfigured' },
      500,
    );
  }

  const parsed = await parseImageUpload(c);
  if (!parsed.ok) return parsed.response;

  const data = await identifyRouter(
    { imageDataUrl: parsed.upload.imageDataUrl },
    { apiKey, signal: c.req.raw.signal },
  );
  return c.json<ApiResult<IdentifyResponse>>({ ok: true, kind: 'success', data });
});
