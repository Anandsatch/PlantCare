// Shared JSON-body validator for /api/review. Counterpart to
// _consultRequest.ts for the second text endpoint. Centralizes device-id
// check, JSON parse, and week_summary + plants[] shape validation so the
// route handler stays a thin orchestrator.
//
// Three _*.ts helpers in routes/ now (_imageUpload, _consultRequest, this).
// The _validation/ subdirectory regroup is deferred until a fourth helper
// lands or a real pain point shows up — three flat files is still easier
// to find than three under a subdirectory, and V1 scope locks penalize
// structural churn.

import type { Context } from 'hono';
import type { ApiResult, ReviewPlantSummary, ReviewRequestBody } from '@plantcare/api-types';
import type { HonoEnv } from '../env';

const MAX_PLANTS = 50;
const MAX_PER_PLANT_COUNT = 30;
const MAX_WEEK_EVENTS = 300;
const MAX_NICKNAME_LEN = 80;
const MAX_SPECIES_SLUG_LEN = 100;

export type ValidatedReviewRequest = {
  deviceId: string;
  weekSummary: ReviewRequestBody['week_summary'];
  plants: ReviewPlantSummary[];
};

export type ParseReviewRequestResult =
  | { ok: true; request: ValidatedReviewRequest }
  | { ok: false; response: Response };

export async function parseReviewRequest(
  c: Context<HonoEnv>,
): Promise<ParseReviewRequestResult> {
  const deviceId = c.req.header('X-Device-Id');
  if (!deviceId || deviceId.length < 8 || deviceId.length > 128) {
    return errResponse(c, 'missing_or_invalid_device_id');
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return errResponse(c, 'invalid_json');
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return errResponse(c, 'invalid_body_shape');
  }
  const obj = body as Record<string, unknown>;

  const weekSummary = parseWeekSummary(obj.week_summary);
  if (weekSummary === 'invalid') {
    return errResponse(c, 'invalid_week_summary');
  }

  const plants = parsePlants(obj.plants);
  if (plants === 'invalid') {
    return errResponse(c, 'invalid_plants');
  }

  return { ok: true, request: { deviceId, weekSummary, plants } };
}

function parseWeekSummary(
  raw: unknown,
): ReviewRequestBody['week_summary'] | 'invalid' {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'invalid';
  const ws = raw as Record<string, unknown>;

  const plants_total = ws.plants_total;
  const watering_events = ws.watering_events;
  const skip_events = ws.skip_events;
  const diagnoses = ws.diagnoses;

  if (!isBoundedInt(plants_total, 0, MAX_PLANTS)) return 'invalid';
  if (!isBoundedInt(watering_events, 0, MAX_WEEK_EVENTS)) return 'invalid';
  if (!isBoundedInt(skip_events, 0, MAX_WEEK_EVENTS)) return 'invalid';
  if (!isBoundedInt(diagnoses, 0, MAX_PLANTS)) return 'invalid';

  return { plants_total, watering_events, skip_events, diagnoses };
}

function parsePlants(raw: unknown): ReviewPlantSummary[] | 'invalid' {
  if (!Array.isArray(raw)) return 'invalid';
  if (raw.length > MAX_PLANTS) return 'invalid';

  const out: ReviewPlantSummary[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return 'invalid';
    const p = entry as Record<string, unknown>;

    if (typeof p.species_slug !== 'string') return 'invalid';
    const slug = p.species_slug.trim();
    if (!slug || slug.length > MAX_SPECIES_SLUG_LEN) return 'invalid';

    let nickname: string | undefined;
    if ('nickname' in p && p.nickname !== undefined && p.nickname !== null) {
      if (typeof p.nickname !== 'string') return 'invalid';
      const nick = p.nickname.trim();
      if (nick) {
        if (nick.length > MAX_NICKNAME_LEN) return 'invalid';
        nickname = nick;
      }
    }

    const wateringCount = p.watering_count;
    const skipCount = p.skip_count;
    const hadDiagnosis = p.had_diagnosis;
    if (!isBoundedInt(wateringCount, 0, MAX_PER_PLANT_COUNT)) return 'invalid';
    if (!isBoundedInt(skipCount, 0, MAX_PER_PLANT_COUNT)) return 'invalid';
    if (typeof hadDiagnosis !== 'boolean') return 'invalid';

    out.push({
      species_slug: slug,
      ...(nickname ? { nickname } : {}),
      watering_count: wateringCount,
      skip_count: skipCount,
      had_diagnosis: hadDiagnosis,
    });
  }
  return out;
}

// Strict integer in [min, max]. Rejects NaN, Infinity, fractional values.
// Fractional values would round downstream and silently shift the prompt
// (e.g. watering_events=0.4 → "0 waterings" in the LLM prompt).
function isBoundedInt(v: unknown, min: number, max: number): v is number {
  return (
    typeof v === 'number' &&
    Number.isInteger(v) &&
    v >= min &&
    v <= max
  );
}

function errResponse(
  c: Context<HonoEnv>,
  message: string,
): { ok: false; response: Response } {
  const body: ApiResult<never> = { ok: false, kind: 'error', message };
  return { ok: false, response: c.json(body, 400) };
}
