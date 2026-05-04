// POST /api/consult
// Request: application/json body
//          { note: string, plant_context?: { species_slug?, is_indoor?,
//            override_interval_days?, watering_history? } }
//          + header `X-Device-Id` (UUID).
// Response: ApiResult<ConsultResponse>
//
// First text-only endpoint and first endpoint with an off-topic rejection
// path. Rejection routes through ApiResult.rejected_off_topic at the wire;
// the in-process router uses ConsultResponse's discriminated union so the
// fork is visible to parser, router, and handler alike.

import { Hono } from 'hono';
import type { ApiResult, ConsultResponse } from '@plantcare/api-types';
import type { HonoEnv } from '../env';
import { consultRouter } from '../llm/router';
import { parseConsultRequest, type ValidatedConsultRequest } from './_consultRequest';

export const consultRoute = new Hono<HonoEnv>().post('/', async (c) => {
  // Pre-flight: misconfiguration short-circuits BEFORE we read the body, so
  // a Worker without OPENROUTER_API_KEY doesn't waste a JSON parse on a
  // request it would immediately reject.
  const apiKey = c.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return c.json<ApiResult<ConsultResponse>>(
      { ok: false, kind: 'error', message: 'service_unconfigured' },
      500,
    );
  }

  const parsed = await parseConsultRequest(c);
  if (!parsed.ok) return parsed.response;

  const userMessage = buildUserMessage(parsed.request);

  const data = await consultRouter(
    { kind: 'text', userMessage },
    { apiKey, signal: c.req.raw.signal },
  );

  // Off-topic rejection at the wire boundary. ApiResult.rejected_off_topic
  // is `ok: false` because the request was not accepted (see api-types
  // comment); naive `if (!result.ok) retry` callers will retry, but the
  // mobile client renders rejection as a terminal UI state.
  if (data.kind === 'rejected_off_topic') {
    return c.json<ApiResult<ConsultResponse>>(
      { ok: false, kind: 'rejected_off_topic', message: data.reason },
      200,
    );
  }

  return c.json<ApiResult<ConsultResponse>>({ ok: true, kind: 'success', data });
});

// Compose the LLM user message from validated request fields. Format chosen
// to be parseable by the model without ambiguity: section headers + a labeled
// note at the end. Watering history rendered as compact day-offset list so
// the model sees ordering without burning tokens on per-entry prose.
function buildUserMessage(req: ValidatedConsultRequest): string {
  const lines: string[] = [];
  const ctx = req.plantContext;

  if (ctx) {
    const meta: string[] = [];
    if (ctx.species_slug) meta.push(`species=${ctx.species_slug}`);
    if (typeof ctx.is_indoor === 'boolean') meta.push(`indoor=${ctx.is_indoor}`);
    if (ctx.override_interval_days != null) {
      meta.push(`current_interval_days=${ctx.override_interval_days}`);
    }
    if (meta.length > 0) lines.push(`Plant: ${meta.join(', ')}`);

    if (ctx.watering_history && ctx.watering_history.length > 0) {
      const hist = ctx.watering_history
        .map((h) => `day ${h.day_offset}=${h.watered ? 'watered' : 'skipped'}`)
        .join(', ');
      lines.push(`Recent: ${hist}`);
    }
  }

  lines.push(`Note: ${req.note}`);
  return lines.join('\n');
}
