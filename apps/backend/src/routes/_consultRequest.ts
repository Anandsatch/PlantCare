// Shared JSON-body validator for /api/consult. Counterpart to _imageUpload.ts
// for the text endpoints. Centralizes the device-id check, JSON parse, and
// note/plant_context shape validation so the route handler stays a thin
// orchestrator.
//
// Why not a /_validation/ subdirectory yet: only two helpers exist
// (_imageUpload, _consultRequest). E1-004 (review) will add a third — at
// that point regroup. Premature directory-making is the kind of structural
// churn the V1 scope locks exist to prevent.

import type { Context } from 'hono';
import type { ApiResult, ConsultRequestBody } from '@plantcare/api-types';
import type { HonoEnv } from '../env';

const MAX_NOTE_LENGTH = 2000;
const MAX_HISTORY_ENTRIES = 7;

export type ValidatedConsultRequest = {
  deviceId: string;
  note: string;
  plantContext?: NonNullable<ConsultRequestBody['plant_context']>;
};

export type ParseConsultRequestResult =
  | { ok: true; request: ValidatedConsultRequest }
  | { ok: false; response: Response };

export async function parseConsultRequest(
  c: Context<HonoEnv>,
): Promise<ParseConsultRequestResult> {
  const deviceId = c.req.header('X-Device-Id');
  if (!deviceId || deviceId.length < 8 || deviceId.length > 128) {
    return errResponse(c, 400, 'missing_or_invalid_device_id');
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return errResponse(c, 400, 'invalid_json');
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return errResponse(c, 400, 'invalid_body_shape');
  }
  const obj = body as Record<string, unknown>;

  const rawNote = obj.note;
  if (typeof rawNote !== 'string') {
    return errResponse(c, 400, 'missing_or_invalid_note');
  }
  // Length-cap BEFORE trim so a 100KB whitespace blob can't burn CPU.
  if (rawNote.length > MAX_NOTE_LENGTH) {
    return errResponse(c, 400, 'note_too_long');
  }
  const note = rawNote.trim();
  if (!note) {
    return errResponse(c, 400, 'missing_or_invalid_note');
  }

  const plantContext = parsePlantContext(obj.plant_context);
  if (plantContext === 'invalid') {
    return errResponse(c, 400, 'invalid_plant_context');
  }

  return {
    ok: true,
    request: { deviceId, note, ...(plantContext ? { plantContext } : {}) },
  };
}

// Returns the validated context, undefined if absent, or 'invalid' on shape
// mismatch. Strict on every field that's present; tolerant of missing fields.
function parsePlantContext(
  raw: unknown,
): NonNullable<ConsultRequestBody['plant_context']> | undefined | 'invalid' {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) return 'invalid';

  const ctx = raw as Record<string, unknown>;
  const out: NonNullable<ConsultRequestBody['plant_context']> = {};

  if ('species_slug' in ctx) {
    if (typeof ctx.species_slug !== 'string' || !ctx.species_slug.trim()) return 'invalid';
    out.species_slug = ctx.species_slug.trim().slice(0, 100);
  }

  if ('is_indoor' in ctx) {
    if (typeof ctx.is_indoor !== 'boolean') return 'invalid';
    out.is_indoor = ctx.is_indoor;
  }

  if ('override_interval_days' in ctx) {
    const v = ctx.override_interval_days;
    if (v === null) {
      out.override_interval_days = null;
    } else if (
      typeof v === 'number' &&
      Number.isInteger(v) &&
      v >= 1 &&
      v <= 365
    ) {
      // Strict integer required. Fractional values like 0.2 would round to 0
      // and emit an impossible "current_interval_days=0" into the LLM prompt.
      out.override_interval_days = v;
    } else {
      return 'invalid';
    }
  }

  if ('watering_history' in ctx) {
    const hist = ctx.watering_history;
    if (!Array.isArray(hist) || hist.length > MAX_HISTORY_ENTRIES) return 'invalid';
    const validated: { day_offset: number; watered: boolean }[] = [];
    for (const entry of hist) {
      if (!entry || typeof entry !== 'object') return 'invalid';
      const e = entry as Record<string, unknown>;
      if (
        typeof e.day_offset !== 'number' ||
        !Number.isFinite(e.day_offset) ||
        e.day_offset > 0 ||
        e.day_offset < -90 ||
        typeof e.watered !== 'boolean'
      ) {
        return 'invalid';
      }
      validated.push({ day_offset: Math.round(e.day_offset), watered: e.watered });
    }
    out.watering_history = validated;
  }

  return out;
}

function errResponse(
  c: Context<HonoEnv>,
  status: 400,
  message: string,
): { ok: false; response: Response } {
  // ApiResult<never> is assignable to ApiResult<ConsultResponse> at the call
  // site — failure variants don't reference the success generic.
  const body: ApiResult<never> = { ok: false, kind: 'error', message };
  return { ok: false, response: c.json(body, status) };
}
