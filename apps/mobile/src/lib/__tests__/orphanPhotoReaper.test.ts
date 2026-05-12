/**
 * Tests for `orphanPhotoReaper`. Uses an injected fake `ReaperFileSystem`
 * so no native modules are touched. Pins:
 *   - files older than ttl are deleted
 *   - files newer than ttl are preserved
 *   - files with no mtime are preserved (Android FUSE edge case)
 *   - subdirectories are skipped (defense-in-depth against future tree growth)
 *   - missing orphan directory returns zero counts (cold-start)
 *   - read failure returns zero counts (does not throw)
 *   - per-file delete failure does not abort the pass (counted as skipped)
 *   - default 7-day TTL exported by the module
 *   - modificationTime is treated as SECONDS per expo-file-system/legacy
 */
import { describe, expect, it, jest } from '@jest/globals';

import {
  ORPHAN_TTL_MS,
  reapOrphanPhotos,
  type ReaperFileSystem,
} from '../orphanPhotoReaper';

// ─── Helpers ────────────────────────────────────────────────────────────

type DirEntry =
  | { kind: 'file'; mtimeSec: number }
  | { kind: 'dir' }
  | { kind: 'unreadable' }
  | { kind: 'no-mtime' };

function makeFs(
  dirPath: string | null,
  entries: Record<string, DirEntry>,
  opts: { readDirThrows?: boolean; deleteThrowsFor?: string[] } = {},
): ReaperFileSystem & {
  readDirectoryAsync: jest.Mock;
  getInfoAsync: jest.Mock;
  deleteAsync: jest.Mock;
} {
  const readDirectoryAsync = jest.fn(async () => {
    if (opts.readDirThrows) throw new Error('readDir failed');
    return Object.keys(entries);
  });
  const getInfoAsync = jest.fn(async (uri: string) => {
    // Directory probe — the dir always exists in fixtures unless
    // explicitly set to null.
    if (uri === dirPath) {
      return { exists: true, isDirectory: true };
    }
    const name = uri.slice(dirPath ? dirPath.length : 0);
    const entry = entries[name];
    if (!entry) return { exists: false };
    if (entry.kind === 'unreadable') {
      throw new Error('getInfo failed');
    }
    if (entry.kind === 'dir') {
      return { exists: true, isDirectory: true };
    }
    if (entry.kind === 'no-mtime') {
      return { exists: true, isDirectory: false };
    }
    return {
      exists: true,
      isDirectory: false,
      modificationTime: entry.mtimeSec,
    };
  });
  const deleteAsync = jest.fn(async (uri: string) => {
    const name = uri.slice(dirPath ? dirPath.length : 0);
    if (opts.deleteThrowsFor?.includes(name)) {
      throw new Error('delete failed');
    }
  });
  return {
    documentDirectory: 'file:///mock/Documents/',
    readDirectoryAsync: readDirectoryAsync as unknown as ReaperFileSystem['readDirectoryAsync'],
    getInfoAsync: getInfoAsync as unknown as ReaperFileSystem['getInfoAsync'],
    deleteAsync: deleteAsync as unknown as ReaperFileSystem['deleteAsync'],
  } as ReaperFileSystem & {
    readDirectoryAsync: jest.Mock;
    getInfoAsync: jest.Mock;
    deleteAsync: jest.Mock;
  };
}

const DIR = 'file:///mock/Documents/plants/unattached/';
const NOW_MS = 1_700_000_000_000; // arbitrary fixed wall clock

// ─── Tests ──────────────────────────────────────────────────────────────

describe('orphanPhotoReaper', () => {
  it('exports a 7-day TTL constant', () => {
    expect(ORPHAN_TTL_MS).toBe(7 * 86_400_000);
  });

  it('deletes files older than the TTL', async () => {
    const eightDaysAgoSec = (NOW_MS - 8 * 86_400_000) / 1000;
    const fs = makeFs(DIR, {
      'old.jpg': { kind: 'file', mtimeSec: eightDaysAgoSec },
    });
    const result = await reapOrphanPhotos({ nowMs: NOW_MS, fs, dirPath: DIR });
    expect(result).toEqual({ scanned: 1, deleted: 1, skipped: 0 });
    expect(fs.deleteAsync).toHaveBeenCalledWith(`${DIR}old.jpg`, {
      idempotent: true,
    });
  });

  it('preserves files newer than the TTL', async () => {
    const oneDayAgoSec = (NOW_MS - 1 * 86_400_000) / 1000;
    const fs = makeFs(DIR, {
      'fresh.jpg': { kind: 'file', mtimeSec: oneDayAgoSec },
    });
    const result = await reapOrphanPhotos({ nowMs: NOW_MS, fs, dirPath: DIR });
    expect(result).toEqual({ scanned: 1, deleted: 0, skipped: 1 });
    expect(fs.deleteAsync).not.toHaveBeenCalled();
  });

  it('treats mtime exactly at the TTL boundary as preserved (<= ttl)', async () => {
    // Exactly 7 days old should NOT be deleted — the predicate is age > ttl.
    const exactlySevenDaysSec = (NOW_MS - 7 * 86_400_000) / 1000;
    const fs = makeFs(DIR, {
      'edge.jpg': { kind: 'file', mtimeSec: exactlySevenDaysSec },
    });
    const result = await reapOrphanPhotos({ nowMs: NOW_MS, fs, dirPath: DIR });
    expect(result.deleted).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it('mixed cohort: deletes old, preserves fresh, skips dirs and no-mtime', async () => {
    const oldSec = (NOW_MS - 10 * 86_400_000) / 1000;
    const freshSec = (NOW_MS - 1 * 86_400_000) / 1000;
    const fs = makeFs(DIR, {
      'old1.jpg': { kind: 'file', mtimeSec: oldSec },
      'old2.jpg': { kind: 'file', mtimeSec: oldSec },
      'fresh.jpg': { kind: 'file', mtimeSec: freshSec },
      'subdir': { kind: 'dir' },
      'no-mtime.jpg': { kind: 'no-mtime' },
    });
    const result = await reapOrphanPhotos({ nowMs: NOW_MS, fs, dirPath: DIR });
    expect(result).toEqual({ scanned: 5, deleted: 2, skipped: 3 });
    expect(fs.deleteAsync).toHaveBeenCalledTimes(2);
    expect(fs.deleteAsync).toHaveBeenCalledWith(`${DIR}old1.jpg`, expect.anything());
    expect(fs.deleteAsync).toHaveBeenCalledWith(`${DIR}old2.jpg`, expect.anything());
  });

  it('returns zero counts when the orphan directory does not exist', async () => {
    const fs: ReaperFileSystem = {
      documentDirectory: 'file:///mock/Documents/',
      readDirectoryAsync: jest.fn(async () => []) as never,
      getInfoAsync: jest.fn(async () => ({ exists: false })) as never,
      deleteAsync: jest.fn(async () => {}) as never,
    };
    const result = await reapOrphanPhotos({ nowMs: NOW_MS, fs, dirPath: DIR });
    expect(result).toEqual({ scanned: 0, deleted: 0, skipped: 0 });
    expect(fs.readDirectoryAsync).not.toHaveBeenCalled();
    expect(fs.deleteAsync).not.toHaveBeenCalled();
  });

  it('returns zero counts when documentDirectory is null', async () => {
    const fs: ReaperFileSystem = {
      documentDirectory: null,
      readDirectoryAsync: jest.fn(async () => []) as never,
      getInfoAsync: jest.fn(async () => ({ exists: false })) as never,
      deleteAsync: jest.fn(async () => {}) as never,
    };
    const result = await reapOrphanPhotos({ nowMs: NOW_MS, fs });
    expect(result).toEqual({ scanned: 0, deleted: 0, skipped: 0 });
  });

  it('does not throw when readDirectoryAsync fails', async () => {
    const fs = makeFs(DIR, {}, { readDirThrows: true });
    const result = await reapOrphanPhotos({ nowMs: NOW_MS, fs, dirPath: DIR });
    expect(result).toEqual({ scanned: 0, deleted: 0, skipped: 0 });
  });

  it('continues past a per-file getInfo failure (counted as skipped)', async () => {
    const oldSec = (NOW_MS - 10 * 86_400_000) / 1000;
    const fs = makeFs(DIR, {
      'unreadable.jpg': { kind: 'unreadable' },
      'old.jpg': { kind: 'file', mtimeSec: oldSec },
    });
    const result = await reapOrphanPhotos({ nowMs: NOW_MS, fs, dirPath: DIR });
    expect(result.scanned).toBe(2);
    expect(result.deleted).toBe(1);
    expect(result.skipped).toBe(1);
  });

  it('continues past a per-file delete failure (counted as skipped)', async () => {
    const oldSec = (NOW_MS - 10 * 86_400_000) / 1000;
    const fs = makeFs(
      DIR,
      {
        'fails.jpg': { kind: 'file', mtimeSec: oldSec },
        'ok.jpg': { kind: 'file', mtimeSec: oldSec },
      },
      { deleteThrowsFor: ['fails.jpg'] },
    );
    const result = await reapOrphanPhotos({ nowMs: NOW_MS, fs, dirPath: DIR });
    expect(result.scanned).toBe(2);
    expect(result.deleted).toBe(1);
    expect(result.skipped).toBe(1);
  });

  it('respects a custom ttlMs override', async () => {
    // With a 1ms TTL, every file older than 1ms is deleted.
    const twoSecondsAgoSec = (NOW_MS - 2000) / 1000;
    const fs = makeFs(DIR, {
      'a.jpg': { kind: 'file', mtimeSec: twoSecondsAgoSec },
    });
    const result = await reapOrphanPhotos({
      nowMs: NOW_MS,
      ttlMs: 1,
      fs,
      dirPath: DIR,
    });
    expect(result.deleted).toBe(1);
  });

  it('interprets modificationTime as SECONDS (not ms)', async () => {
    // A file whose mtime is 1_699_999_999 SECONDS is 1 second before NOW_MS.
    // If the implementation treated mtime as ms, the file would appear
    // ancient (1.7 billion ms ago = 19 days ago) and get deleted.
    // Correct behavior: it's fresh, preserve.
    const oneSecAgoSec = NOW_MS / 1000 - 1;
    const fs = makeFs(DIR, {
      'fresh.jpg': { kind: 'file', mtimeSec: oneSecAgoSec },
    });
    const result = await reapOrphanPhotos({ nowMs: NOW_MS, fs, dirPath: DIR });
    expect(result.deleted).toBe(0);
    expect(result.skipped).toBe(1);
  });
});
