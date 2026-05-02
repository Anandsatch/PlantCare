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
  const bytes = new Uint8Array(buf);

  // Magic-byte check: client-declared `file.type` is trusted by the browser
  // but a hostile caller can send arbitrary bytes labeled image/png. Cheap
  // sniff prevents wasted OpenRouter spend on garbage.
  if (!magicMatchesMime(bytes, mime)) {
    return c.json<ApiResult<IdentifyResponse>>(
      { ok: false, kind: 'error', message: 'image_bytes_do_not_match_type' },
      400,
    );
  }

  const imageDataUrl = toDataUrl(mime, bytes);

  const data = await identifyRouter(
    { imageDataUrl },
    { apiKey, signal: c.req.raw.signal },
  );
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
function toDataUrl(mime: string, bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return `data:${mime};base64,${btoa(binary)}`;
}

// Cheap header sniffs. JPEG: FF D8 FF. PNG: 89 50 4E 47 0D 0A 1A 0A.
// WebP: "RIFF"…"WEBP" at offsets 0/8. HEIC: "ftyp" at offset 4 followed by
// a heic-family brand (heic, heix, hevc, mif1, msf1) at offset 8.
function magicMatchesMime(bytes: Uint8Array, mime: string): boolean {
  if (bytes.length < 12) return false;
  switch (mime) {
    case 'image/jpeg':
    case 'image/jpg':
      return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    case 'image/png':
      return (
        bytes[0] === 0x89 &&
        bytes[1] === 0x50 &&
        bytes[2] === 0x4e &&
        bytes[3] === 0x47 &&
        bytes[4] === 0x0d &&
        bytes[5] === 0x0a &&
        bytes[6] === 0x1a &&
        bytes[7] === 0x0a
      );
    case 'image/webp':
      return (
        bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
        bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
      );
    case 'image/heic': {
      if (bytes[4] !== 0x66 || bytes[5] !== 0x74 || bytes[6] !== 0x79 || bytes[7] !== 0x70) {
        return false;
      }
      const brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
      return ['heic', 'heix', 'hevc', 'mif1', 'msf1'].includes(brand);
    }
    default:
      return false;
  }
}
