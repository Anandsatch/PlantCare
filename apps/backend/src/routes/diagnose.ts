// POST /api/diagnose
// Request: multipart/form-data with `image` (image/* file showing the plant
//          or affected leaf) + header `X-Device-Id` (UUID).
// Response: ApiResult<DiagnoseResponse>
//
// Same multipart contract + tiered router as /api/identify; the difference
// is the system prompt asks for a diagnosis shape (disease_slug, severity,
// fix_steps) instead of a species shape.

import { Hono } from 'hono';
import type { ApiResult, DiagnoseResponse } from '@plantcare/api-types';
import type { HonoEnv } from '../env';
import { diagnoseRouter } from '../llm/router';
import { parseImageUpload } from './_imageUpload';

export const diagnoseRoute = new Hono<HonoEnv>().post('/', async (c) => {
  // Pre-flight: misconfiguration must short-circuit BEFORE we read the
  // multipart body, so a Worker without OPENROUTER_API_KEY doesn't burn
  // memory + CPU parsing 8MB uploads it would immediately reject.
  const apiKey = c.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return c.json<ApiResult<DiagnoseResponse>>(
      { ok: false, kind: 'error', message: 'service_unconfigured' },
      500,
    );
  }

  const parsed = await parseImageUpload(c);
  if (!parsed.ok) return parsed.response;

  const data = await diagnoseRouter(
    { imageDataUrl: parsed.upload.imageDataUrl },
    { apiKey, signal: c.req.raw.signal },
  );
  return c.json<ApiResult<DiagnoseResponse>>({ ok: true, kind: 'success', data });
});
