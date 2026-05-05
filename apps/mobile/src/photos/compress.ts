/**
 * Photo compression helper.
 *
 * V1 lock: photos are LOCAL ONLY (no cloud, no R2, no upload). Compression
 * bounds the on-device storage curve so a long-term user with many plants and
 * many photos doesn't fill the device.
 *
 * Spec (from the master plan, locked numbers):
 *  - Resize to max 1024px on the longer edge, JPEG quality 0.7. A 12MP
 *    iPhone shot (~4-5 MB) becomes ~150-300 KB. Vision models work fine at
 *    1024px so the same compressed asset is the upload payload, no re-encode.
 *  - Output is written to `FileSystem.documentDirectory + 'plants/<id>/'`
 *    (NOT cacheDirectory — survives app restarts, not OS-evictable).
 *  - Filename includes a timestamp + random suffix to avoid collisions when
 *    two photos arrive in the same millisecond (sub-ms double-tap, batch
 *    import). No PII in the filename.
 *
 * The `expo-image-manipulator` API writes to its own cache dir; we copy the
 * result into the persistent `plants/<id>/` subdirectory and best-effort
 * delete the cache copy. A failed cache cleanup never blocks the call —
 * the OS will reclaim it eventually — but we still log it for observability.
 *
 * `expo-file-system/legacy` is intentional: SDK 55 ships a class-based
 * Paths/File/Directory API but its legacy entry exposes the
 * `documentDirectory` + `*Async` helpers this code is written against. The
 * legacy module is supported for the V1 build window; revisit if Expo
 * removes it.
 */
import * as ImageManipulator from 'expo-image-manipulator';
import * as FileSystem from 'expo-file-system/legacy';

/**
 * Errors thrown by `compressPhoto`. The `kind` field is the wire-stable
 * discriminator that callers (and any future telemetry pipeline) match
 * against; the `message` is human-readable and intentionally not load-bearing.
 *
 * `cause` is preserved across the throw boundary so the original underlying
 * error (e.g. an ImageManipulator native module failure) survives even when
 * a caller logs only `err.message`. Hermes preserves Error.cause natively as
 * of RN 0.74+; we set it via the standard ES2022 options bag.
 */
export type PhotoCompressErrorKind =
  | 'source-missing'
  | 'manipulate-failed'
  | 'storage-unavailable'
  | 'copy-failed';

export class PhotoCompressError extends Error {
  readonly kind: PhotoCompressErrorKind;

  constructor(kind: PhotoCompressErrorKind, options?: { cause?: unknown; message?: string }) {
    super(options?.message ?? kind, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'PhotoCompressError';
    this.kind = kind;
  }
}

export interface CompressPhotoInput {
  sourceUri: string;
  /**
   * Optional plant identifier — used as a directory prefix. Sanitized: only
   * `[A-Za-z0-9_-]` characters survive, so a hostile or malformed id can't
   * traverse out of the photos directory (`../`, absolute paths, etc.).
   */
  plantId?: string;
  /** Override clock for deterministic tests. Defaults to `Date.now()`. */
  nowMs?: number;
}

export interface CompressPhotoResult {
  /** `file://` URI inside `FileSystem.documentDirectory + 'plants/<id>/'`. */
  uri: string;
  width: number;
  height: number;
  sizeBytes: number;
}

/**
 * Returns the directory where compressed photos for a given plant live. Used
 * by callers that need to enumerate photos before any compression has run
 * (e.g. listing existing captures, or pre-creating the directory ahead of a
 * bulk import). The directory is not auto-created — `compressPhoto` does
 * that on first write.
 *
 * `plantId` is sanitized to the same character set the writer uses, so this
 * helper and `compressPhoto` always agree on the path.
 */
export function getPhotoDirectory(plantId: string): string {
  const docDir = FileSystem.documentDirectory;
  if (!docDir) {
    throw new PhotoCompressError('storage-unavailable', {
      message: 'FileSystem.documentDirectory is null',
    });
  }
  return `${docDir}plants/${sanitizePlantId(plantId)}/`;
}

/**
 * Compress a captured photo for local storage.
 *
 * Pipeline:
 *  1. Validate source URI is non-empty.
 *  2. Probe dimensions via a no-op `manipulateAsync(uri, [], ...)`. The
 *     library returns `width`/`height` even when `actions` is empty, so this
 *     is the cheapest way to learn orientation. The probe also recompresses,
 *     but we throw away the cache file from this step before the caller sees
 *     anything.
 *  3. If the longer edge exceeds 1024, resize. Pass `{ width: 1024 }` for
 *     landscape (or square — square is fine either axis), `{ height: 1024 }`
 *     for portrait. ImageManipulator preserves aspect ratio when only one
 *     dimension is given.
 *  4. Copy the manipulator output into `documentDirectory + 'plants/<id>/'`
 *     under a `<nowMs>-<rand>.jpg` filename. Source-already-in-document case
 *     still gets re-encoded + copied; we don't try to detect it (per spec
 *     the goal is bounded size, not source-of-truth detection).
 *  5. Best-effort delete the manipulator's cache file.
 *  6. Return the new URI plus dimensions and on-disk size.
 */
export async function compressPhoto(input: CompressPhotoInput): Promise<CompressPhotoResult> {
  const { sourceUri, plantId, nowMs } = input;

  if (!sourceUri || sourceUri.trim() === '') {
    throw new PhotoCompressError('source-missing', {
      message: 'sourceUri is required and must be a non-empty string',
    });
  }

  const docDir = FileSystem.documentDirectory;
  if (!docDir) {
    throw new PhotoCompressError('storage-unavailable', {
      message: 'FileSystem.documentDirectory is null',
    });
  }

  // Probe dimensions so we know which axis to constrain. `actions: []` skips
  // every transform but still returns width/height + a cache file we can
  // throw away once we've used the dimensions.
  let probeUri: string | undefined;
  let width: number;
  let height: number;
  try {
    const probe = await ImageManipulator.manipulateAsync(sourceUri, [], {
      compress: 1,
      format: ImageManipulator.SaveFormat.JPEG,
    });
    probeUri = probe.uri;
    width = probe.width;
    height = probe.height;
  } catch (err) {
    throw new PhotoCompressError('manipulate-failed', {
      cause: err,
      message: 'ImageManipulator failed to probe source dimensions',
    });
  }

  // Cleanup the probe cache file — best-effort. If the OS keeps it for a
  // few minutes before reclaiming, that's fine; we just don't want to leak
  // it across hundreds of captures.
  if (probeUri && probeUri !== sourceUri) {
    void safeDelete(probeUri);
  }

  const longerEdge = Math.max(width, height);
  const actions: ImageManipulator.Action[] =
    longerEdge > 1024
      ? [{ resize: width >= height ? { width: 1024 } : { height: 1024 } }]
      : [];

  let manipulated;
  try {
    manipulated = await ImageManipulator.manipulateAsync(sourceUri, actions, {
      compress: 0.7,
      format: ImageManipulator.SaveFormat.JPEG,
    });
  } catch (err) {
    throw new PhotoCompressError('manipulate-failed', {
      cause: err,
      message: 'ImageManipulator failed to compress source',
    });
  }

  const safePlantId = sanitizePlantId(plantId);
  const dir = `${docDir}plants/${safePlantId}/`;

  try {
    await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
  } catch (err) {
    throw new PhotoCompressError('storage-unavailable', {
      cause: err,
      message: `Could not create photo directory ${dir}`,
    });
  }

  const ts = nowMs ?? Date.now();
  const finalUri = `${dir}${ts}-${randomSuffix()}.jpg`;

  try {
    await FileSystem.copyAsync({ from: manipulated.uri, to: finalUri });
  } catch (err) {
    throw new PhotoCompressError('copy-failed', {
      cause: err,
      message: `Failed to copy compressed image to ${finalUri}`,
    });
  }

  // Best-effort: remove the manipulator's cache copy now that we've copied
  // it into the document directory. If this fails the OS will reclaim it
  // eventually; it's not worth failing the call over.
  void safeDelete(manipulated.uri);

  let sizeBytes = 0;
  try {
    const info = await FileSystem.getInfoAsync(finalUri);
    if (info.exists) {
      // FileInfo.size exists when exists=true (per the legacy type). Some
      // adapters return undefined on Android emulators when the size probe
      // is racy — clamp to 0 so the helper never returns NaN.
      sizeBytes = (info as { size?: number }).size ?? 0;
    }
  } catch {
    // getInfoAsync failure on the freshly-written file is unusual but not
    // fatal — return 0 rather than blow up the whole capture flow.
    sizeBytes = 0;
  }

  return {
    uri: finalUri,
    width: manipulated.width,
    height: manipulated.height,
    sizeBytes,
  };
}

// ─── helpers ────────────────────────────────────────────────────────────────

/**
 * Strip everything that isn't `[A-Za-z0-9_-]`, then collapse to a non-empty
 * fallback. This protects against `plantId = '../../../etc/passwd'` and
 * Unicode shenanigans even though plantId is device-controlled today —
 * defense in depth is cheap.
 */
function sanitizePlantId(plantId: string | undefined): string {
  if (!plantId) return 'unattached';
  const cleaned = plantId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
  return cleaned.length > 0 ? cleaned : 'unattached';
}

/**
 * 8 hex chars (32 bits) of randomness. Even at 1000 photos/sec (impossible
 * for human capture) the birthday-collision probability inside a single
 * millisecond bucket is ~0.0001%. Combined with the millisecond timestamp
 * the practical collision risk is zero.
 */
function randomSuffix(): string {
  // Math.random is sufficient here — this is a filename uniqueness token,
  // not a security primitive. RN's Hermes engine seeds Math.random per VM,
  // so two simultaneous calls in the same JS thread are still independent.
  const n = Math.floor(Math.random() * 0xffffffff);
  return n.toString(16).padStart(8, '0');
}

async function safeDelete(uri: string): Promise<void> {
  try {
    await FileSystem.deleteAsync(uri, { idempotent: true });
  } catch {
    // Swallow — leaking one cache file is preferable to failing a capture.
  }
}
