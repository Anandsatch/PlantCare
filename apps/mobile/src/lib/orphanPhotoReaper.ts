/**
 * Orphan-photo reaper — follow-up to E5-008's Quick Diagnose unattached writes
 * (documented in v0.1.58.0 CHANGELOG).
 *
 * # What this fixes
 *
 * Quick Diagnose (the FAB long-press path with no plant context) compresses
 * the captured photo via `compressPhoto({ sourceUri, plantId: undefined })`,
 * which lands the JPEG under
 * `FileSystem.documentDirectory + 'plants/unattached/'`. The
 * CameraResultScreen surfaces a diagnosis card to the user but the Quick
 * Diagnose path NEVER links that photo to a plant row in SQLite — it has no
 * plant to link to. The compressed file therefore stays on disk forever.
 *
 * Over weeks of casual use, the `unattached/` directory accumulates
 * 150-300 KB per Quick Diagnose. A heavy user (one diagnose per day for a
 * year) ends with ~100 MB of unreferenced photos. Bounded device storage
 * matters in V1 because there is NO cloud sync to clean up after — once
 * disk fills, the camera flow's `copyAsync` throws `copy-failed` and the
 * whole capture surface breaks.
 *
 * # Policy
 *
 * Delete every file in `documentDirectory + 'plants/unattached/'` whose
 * modification time is older than `ORPHAN_TTL_MS` (default 7 days). 7 days
 * matches the sync_queue's TTL (`apps/mobile/src/sync/queueCrud.ts`
 * TTL_MS) so a Quick Diagnose photo whose queued request is still pending
 * stays on disk long enough for the drainer to replay; once both the queue
 * row and the photo file are older than 7d, the diagnose is unrecoverable
 * anyway and we can safely reclaim the disk.
 *
 * Photos newer than 7d are preserved. Photos with no readable modification
 * time (some Android FUSE-mount edge cases) are preserved — we'd rather
 * leak a stray file than delete one we can't reason about.
 *
 * # Call site (deferred)
 *
 * V1 has no `onAppStart` hook or root-level service-init seam yet —
 * `apps/mobile/app/_layout.tsx` only does font loading. Wiring the reaper
 * call belongs in the eventual app-startup module (Epic E0-008 navigator
 * scaffold, or a follow-up "boot tasks" surface). Until then this module
 * ships the helper + test in isolation; a one-line call from whichever
 * surface ends up owning startup tasks is the wiring follow-up.
 *
 * Why not call it from `RootLayout`: the layout re-renders on every
 * navigation change, and a one-shot `useEffect(..., [])` there would mix
 * disk I/O into the render path. The right home is a fire-and-forget
 * `runBootTasks()` invoked once from the navigator's entry point, which
 * doesn't exist yet.
 *
 * # Race safety
 *
 * The reaper deletes by file modification time. A photo that is being
 * written (e.g. mid-`copyAsync` from `compressPhoto`) has its mtime stamped
 * at write-end, not write-start, so a freshly-written file is brand new
 * (mtime = now) and is correctly preserved. Even if a write somehow
 * concurrently touches a file with mtime 7d+1ms old, the delete would
 * race with the writer and we'd lose at most one Quick Diagnose photo
 * mid-capture — a Quick Diagnose photo that's already a week old that the
 * user simultaneously decided to re-capture. The probability of that
 * sequence is effectively zero, and even if it occurred the surface UX
 * (the user sees their fresh capture in the result screen, then the file
 * is gone next session) is identical to the existing leak surface.
 *
 * # API
 *
 *   reapOrphanPhotos({ nowMs?, ttlMs?, fs?, dirPath? })
 *     → { scanned: number; deleted: number; skipped: number }
 *
 * All inputs are optional so production code calls `reapOrphanPhotos()`
 * with no args. Tests inject `nowMs`, `fs`, and `dirPath` to drive
 * deterministic paths without touching the real filesystem.
 *
 * # Why a free function, not a class
 *
 * No state, no lifecycle. A function module mirrors `compressPhoto`'s
 * shape and keeps the test surface flat.
 */
import * as FileSystem from 'expo-file-system/legacy';

/**
 * 7 days in ms. Matches `sync/queueCrud.ts` TTL_MS by design — a Quick
 * Diagnose whose queued request is still pending stays on disk long enough
 * for the drainer to replay it.
 */
export const ORPHAN_TTL_MS = 7 * 86_400_000;

/**
 * Result of a reaper pass. All counts are observability surfaces; the
 * caller does not branch on them in V1, but future telemetry (E13) can
 * publish them as structured events.
 */
export interface ReapResult {
  /** Total files enumerated under the orphan directory. */
  scanned: number;
  /** Files older than ttlMs that were deleted. */
  deleted: number;
  /** Files that were skipped (younger than ttlMs, or mtime unreadable). */
  skipped: number;
}

/**
 * Minimal FS surface the reaper consumes. Extracted so tests can inject a
 * fake without mocking the whole `expo-file-system/legacy` module. Mirrors
 * the legacy module's `*Async` shape on the methods we call.
 */
export interface ReaperFileSystem {
  documentDirectory: string | null;
  readDirectoryAsync: (uri: string) => Promise<string[]>;
  getInfoAsync: (
    uri: string,
  ) => Promise<{ exists: boolean; isDirectory?: boolean; modificationTime?: number }>;
  deleteAsync: (uri: string, options?: { idempotent?: boolean }) => Promise<void>;
}

export interface ReapOrphanPhotosInput {
  /** Override clock for deterministic tests. Defaults to `Date.now()`. */
  nowMs?: number;
  /** Override TTL for tests. Defaults to {@link ORPHAN_TTL_MS} (7 days). */
  ttlMs?: number;
  /**
   * Override the filesystem surface. Defaults to the real
   * `expo-file-system/legacy` module. Tests pass a fake to drive
   * deterministic paths.
   */
  fs?: ReaperFileSystem;
  /**
   * Override the orphan directory path. Defaults to
   * `documentDirectory + 'plants/unattached/'`. Tests use this to scope
   * the scan to a fixture directory.
   */
  dirPath?: string;
}

/**
 * Sweep `documentDirectory/plants/unattached/` and delete files older than
 * `ttlMs`. Fire-and-forget. Never throws on individual file errors — a
 * single unreadable file does not abort the pass; it counts as skipped.
 * A missing orphan directory is not an error (the user has never run a
 * Quick Diagnose) — returns zero counts.
 *
 * `expo-file-system/legacy`'s `modificationTime` is in SECONDS (Unix
 * epoch), not ms — we multiply by 1000 before comparing to `nowMs`.
 * Documented in the legacy module's FileInfo type. Tests pin this.
 */
export async function reapOrphanPhotos(
  input: ReapOrphanPhotosInput = {},
): Promise<ReapResult> {
  const fs = input.fs ?? (FileSystem as unknown as ReaperFileSystem);
  const nowMs = input.nowMs ?? Date.now();
  const ttlMs = input.ttlMs ?? ORPHAN_TTL_MS;

  const docDir = fs.documentDirectory;
  if (!docDir) {
    // No persistent storage available — nothing to reap. Not an error;
    // the camera flow would have failed long before this on the same
    // device, so this branch is defensive only.
    return { scanned: 0, deleted: 0, skipped: 0 };
  }

  const dirPath = input.dirPath ?? `${docDir}plants/unattached/`;

  // Probe the directory before listing. A missing dir is the cold-start
  // case (user never ran Quick Diagnose); not an error.
  let exists = false;
  try {
    const info = await fs.getInfoAsync(dirPath);
    exists = info.exists && info.isDirectory !== false;
  } catch {
    // Treat probe failure as "no directory" — the worst case is we miss
    // one reap pass; the next pass will pick up the work.
    return { scanned: 0, deleted: 0, skipped: 0 };
  }
  if (!exists) {
    return { scanned: 0, deleted: 0, skipped: 0 };
  }

  let entries: string[];
  try {
    entries = await fs.readDirectoryAsync(dirPath);
  } catch {
    return { scanned: 0, deleted: 0, skipped: 0 };
  }

  let scanned = 0;
  let deleted = 0;
  let skipped = 0;

  for (const name of entries) {
    scanned++;
    const fileUri = `${dirPath}${name}`;
    let info: Awaited<ReturnType<ReaperFileSystem['getInfoAsync']>>;
    try {
      info = await fs.getInfoAsync(fileUri);
    } catch {
      skipped++;
      continue;
    }
    if (!info.exists || info.isDirectory) {
      // Skip subdirectories defensively — `compressPhoto` doesn't create
      // any under `unattached/`, but a future feature might, and we don't
      // want to recurse-delete a tree we don't own.
      skipped++;
      continue;
    }
    const mtimeSec = info.modificationTime;
    if (mtimeSec === undefined || mtimeSec === null) {
      // No mtime — preserve. Some Android FUSE mounts elide this field
      // and we'd rather leak than delete blind.
      skipped++;
      continue;
    }
    // `modificationTime` is seconds; convert to ms for comparison with
    // `nowMs`. This is the E4-002 critical-regression contract pattern —
    // UTC ms only, no calendar arithmetic.
    const mtimeMs = mtimeSec * 1000;
    const ageMs = nowMs - mtimeMs;
    if (ageMs <= ttlMs) {
      skipped++;
      continue;
    }
    try {
      await fs.deleteAsync(fileUri, { idempotent: true });
      deleted++;
    } catch {
      // Best-effort: a single failed delete (file in use, permissions
      // edge case) does NOT abort the pass. The next reap run will
      // retry.
      skipped++;
    }
  }

  return { scanned, deleted, skipped };
}
