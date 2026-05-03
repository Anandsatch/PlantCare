// Shared multipart-image validator for vision endpoints (/api/identify,
// /api/diagnose). Centralizes the security-critical bits — MIME allowlist,
// 8MB ceiling, magic-byte sniff — so a fix in one place protects all
// vision routes. Error responses use ApiResult's failure variants, which
// don't reference the success-shape generic, so a single helper can serve
// callers parameterized on different response types.

import type { Context } from 'hono';
import type { ApiResult } from '@plantcare/api-types';
import type { HonoEnv } from '../env';

const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // mobile compresses to ~1024px @ 0.7; ~500KB typical, 8MB is hard ceiling
const ACCEPTED_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/heic'];

export type ValidatedImageUpload = {
  deviceId: string;
  mime: string;
  bytes: Uint8Array;
  imageDataUrl: string;
};

export type ParseImageUploadResult =
  | { ok: true; upload: ValidatedImageUpload }
  | { ok: false; response: Response };

export async function parseImageUpload(c: Context<HonoEnv>): Promise<ParseImageUploadResult> {
  const deviceId = c.req.header('X-Device-Id');
  if (!deviceId || deviceId.length < 8 || deviceId.length > 128) {
    return errResponse(c, 400, 'missing_or_invalid_device_id');
  }

  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return errResponse(c, 400, 'invalid_multipart');
  }

  const file = form.get('image');
  // FormData entry is `string | File` at runtime; we duck-type via .arrayBuffer
  // because the Blob constructor isn't a value-side type under the lib config.
  if (!isUploadedFile(file)) {
    return errResponse(c, 400, 'missing_image');
  }
  if (file.size === 0 || file.size > MAX_IMAGE_BYTES) {
    return errResponse(c, 400, 'image_size_out_of_range');
  }
  const mime = (file.type || '').toLowerCase();
  if (!ACCEPTED_TYPES.includes(mime)) {
    return errResponse(c, 400, 'unsupported_image_type');
  }

  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);

  // Magic-byte check: client-declared `file.type` is trusted by the browser
  // but a hostile caller can send arbitrary bytes labeled image/png. Cheap
  // sniff prevents wasted OpenRouter spend on garbage.
  if (!magicMatchesMime(bytes, mime)) {
    return errResponse(c, 400, 'image_bytes_do_not_match_type');
  }

  return {
    ok: true,
    upload: { deviceId, mime, bytes, imageDataUrl: toDataUrl(mime, bytes) },
  };
}

function errResponse(
  c: Context<HonoEnv>,
  status: 400 | 500,
  message: string,
): { ok: false; response: Response } {
  // ApiResult's failure variants are independent of the success generic, so
  // `ApiResult<never>` is assignable to `ApiResult<IdentifyResponse>` and
  // `ApiResult<DiagnoseResponse>` alike at the call site.
  const body: ApiResult<never> = { ok: false, kind: 'error', message };
  return { ok: false, response: c.json(body, status) };
}

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
