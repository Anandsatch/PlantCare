// POST /api/identify
// Request: multipart/form-data with `image` (image/* file)
//          + header `X-Device-Id` (UUID, set client-side at first launch)
// Response: ApiResult<IdentifyResponse>

import { Hono } from 'hono';
import type { ApiResult, IdentifyResponse } from '@plantcare/api-types';
import type { HonoEnv } from '../env';
import { identifyRouter } from '../llm/router';

const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // mobile compresses to ~1024px @ 0.7; ~500KB typical, 8MB is hard ceiling
const ACCEPTED_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/heic'];

export const identifyRoute = new Hono<HonoEnv>().post('/', async (c) => {
  const deviceId = c.req.header('X-Device-Id');
  if (!deviceId || deviceId.length < 8 || deviceId.length > 128) {
    return c.json<ApiResult<IdentifyResponse>>(
      { ok: false, kind: 'error', message: 'missing_or_invalid_device_id' },
      400,
    );
  }

  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return c.json<ApiResult<IdentifyResponse>>(
      { ok: false, kind: 'error', message: 'invalid_multipart' },
      400,
    );
  }

  const file = form.get('image');
  // FormData entry is `string | File` at runtime; we duck-type via .arrayBuffer
  // because the Blob constructor isn't a value-side type under the lib config.
  if (!isUploadedFile(file)) {
    return c.json<ApiResult<IdentifyResponse>>(
      { ok: false, kind: 'error', message: 'missing_image' },
      400,
    );
  }
  if (file.size === 0 || file.size > MAX_IMAGE_BYTES) {
    return c.json<ApiResult<IdentifyResponse>>(
      { ok: false, kind: 'error', message: 'image_size_out_of_range' },
      400,
    );
  }
  const mime = (file.type || '').toLowerCase();
  if (!ACCEPTED_TYPES.includes(mime)) {
    return c.json<ApiResult<IdentifyResponse>>(
      { ok: false, kind: 'error', message: 'unsupported_image_type' },
      400,
    );
  }

  const apiKey = c.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    // Misconfiguration — surface as 500 but with a stable error code so
    // the client can show "service unavailable" instead of "your photo is bad".
    return c.json<ApiResult<IdentifyResponse>>(
      { ok: false, kind: 'error', message: 'service_unconfigured' },
      500,
    );
  }

  const buf = await file.arrayBuffer();
  const imageDataUrl = toDataUrl(mime, buf);

  const data = await identifyRouter({ imageDataUrl }, { apiKey });
  return c.json<ApiResult<IdentifyResponse>>({ ok: true, kind: 'success', data });
});

type UploadedFile = {
  size: number;
  type: string;
  arrayBuffer(): Promise<ArrayBuffer>;
};

function isUploadedFile(v: unknown): v is UploadedFile {
  return (
    !!v &&
    typeof v === 'object' &&
    typeof (v as UploadedFile).arrayBuffer === 'function' &&
    typeof (v as UploadedFile).size === 'number' &&
    typeof (v as UploadedFile).type === 'string'
  );
}

// Manual base64 encode (no Buffer in Workers runtime). Chunked to avoid
// "Maximum call stack size exceeded" on large images via String.fromCharCode(...arr).
function toDataUrl(mime: string, buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return `data:${mime};base64,${btoa(binary)}`;
}
