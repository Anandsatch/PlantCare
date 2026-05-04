// POST /api/review
// Request: application/json body
//          { week_summary: { plants_total, watering_events, skip_events,
//            diagnoses }, plants: [{ species_slug, nickname?,
//            watering_count, skip_count, had_diagnosis }] }
//          + header `X-Device-Id` (UUID).
// Response: ApiResult<ReviewResponse>
//
// Second text-only endpoint after consult. Generative — returns a Fraunces
// headline + one-paragraph narrative for the A-6 weekly review surface.
// Per-plant ledgers in A-6 render from local SQLite; the server only owns
// the editorial voice. No off-topic rejection arm: the user can't inject
// text — review fires from an in-app button on data the app already owns.

import { Hono } from 'hono';
import type { ApiResult, ReviewResponse } from '@plantcare/api-types';
import type { HonoEnv } from '../env';
import { reviewRouter } from '../llm/router';
import { parseReviewRequest, type ValidatedReviewRequest } from './_reviewRequest';

export const reviewRoute = new Hono<HonoEnv>().post('/', async (c) => {
  // Pre-flight: misconfiguration short-circuits BEFORE we read the body, so
  // a Worker without OPENROUTER_API_KEY doesn't waste a JSON parse on a
  // request it would immediately reject.
  const apiKey = c.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return c.json<ApiResult<ReviewResponse>>(
      { ok: false, kind: 'error', message: 'service_unconfigured' },
      500,
    );
  }

  const parsed = await parseReviewRequest(c);
  if (!parsed.ok) return parsed.response;

  const userMessage = buildUserMessage(parsed.request);

  const data = await reviewRouter(
    { kind: 'text', userMessage },
    { apiKey, signal: c.req.raw.signal },
  );

  return c.json<ApiResult<ReviewResponse>>({ ok: true, kind: 'success', data });
});

// Compose the LLM user message from validated week + plant fields. Format
// chosen to be parseable by the model: section header for the week totals,
// then a compact per-plant list. Counts rendered as "watered=N, skipped=M"
// rather than prose so the model sees ordering + magnitude without burning
// tokens. Empty plants array still produces a valid prompt — the system
// prompt instructs the model to emit a "Ready when you are" nudge.
function buildUserMessage(req: ValidatedReviewRequest): string {
  const ws = req.weekSummary;
  const lines: string[] = [
    'Week:',
    `  plants=${ws.plants_total}, watering_events=${ws.watering_events}, skip_events=${ws.skip_events}, diagnoses=${ws.diagnoses}`,
  ];

  if (req.plants.length > 0) {
    lines.push('Plants:');
    for (const p of req.plants) {
      const nameTag = p.nickname ? `${p.nickname} (${p.species_slug})` : p.species_slug;
      const diag = p.had_diagnosis ? ', diagnosis_run=true' : '';
      lines.push(
        `  - ${nameTag}: watered=${p.watering_count}, skipped=${p.skip_count}${diag}`,
      );
    }
  }

  return lines.join('\n');
}
