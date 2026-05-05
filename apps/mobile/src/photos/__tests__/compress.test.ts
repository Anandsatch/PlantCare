/**
 * Unit tests for the photo compression helper.
 *
 * `expo-image-manipulator` and `expo-file-system/legacy` are native modules
 * that don't load in Jest's Node environment. We replace both with
 * `jest.mock` factories that return spy-able stand-ins, so the tests assert
 * against the wire shape the helper produces (resize action, save options,
 * destination path, cleanup calls) rather than against pixel output.
 *
 * Why `jest.mock('expo-file-system/legacy', ...)` instead of `expo-file-system`:
 * the helper imports the legacy entry explicitly so it can use the
 * `documentDirectory` + `*Async` style API that SDK 55's class-based default
 * export no longer exposes.
 */
import { describe, expect, it, jest, beforeEach } from '@jest/globals';

// ─── mocks ──────────────────────────────────────────────────────────────────
//
// `jest.mock` factories are hoisted ABOVE imports by `babel-jest`, so any
// variable they close over must either be `var`-hoisted into the same
// pre-import block or live inside the factory itself. Pattern used here: the
// factory creates the spies and returns them; the test reads them back via
// `jest.requireMock` after the mocks register. This keeps the typed
// outer-scope `const` style without tripping the hoisting rules.

const DOC_DIR = 'file:///mock/Documents/';

jest.mock('expo-image-manipulator', () => ({
  __esModule: true,
  manipulateAsync: jest.fn(),
  SaveFormat: { JPEG: 'jpeg', PNG: 'png' },
}));

jest.mock('expo-file-system/legacy', () => {
  let documentDirectory: string | null = 'file:///mock/Documents/';
  return {
    __esModule: true,
    get documentDirectory() {
      return documentDirectory;
    },
    __setDocumentDirectory: (val: string | null) => {
      documentDirectory = val;
    },
    makeDirectoryAsync: jest.fn(),
    copyAsync: jest.fn(),
    deleteAsync: jest.fn(),
    getInfoAsync: jest.fn(),
  };
});

// Pull the mocks back out so the tests can assert on them directly.
const ImageManipulatorMock = jest.requireMock('expo-image-manipulator') as {
  manipulateAsync: jest.Mock;
  SaveFormat: { JPEG: 'jpeg'; PNG: 'png' };
};
const FileSystemMock = jest.requireMock('expo-file-system/legacy') as {
  documentDirectory: string | null;
  __setDocumentDirectory: (val: string | null) => void;
  makeDirectoryAsync: jest.Mock;
  copyAsync: jest.Mock;
  deleteAsync: jest.Mock;
  getInfoAsync: jest.Mock;
};

const manipulateAsync = ImageManipulatorMock.manipulateAsync;
const makeDirectoryAsync = FileSystemMock.makeDirectoryAsync;
const copyAsync = FileSystemMock.copyAsync;
const deleteAsync = FileSystemMock.deleteAsync;
const getInfoAsync = FileSystemMock.getInfoAsync;

import { compressPhoto, getPhotoDirectory, PhotoCompressError } from '../compress';

// ─── helpers ────────────────────────────────────────────────────────────────

const PROBE_CACHE_URI = 'file:///mock/cache/probe.jpg';
const FINAL_CACHE_URI = 'file:///mock/cache/final.jpg';

interface ProbeOpts {
  width: number;
  height: number;
}

/**
 * Wire up `manipulateAsync` so the first call (the dimension probe with
 * `actions: []`) returns the requested width/height, and the second call
 * (the actual compress) returns the post-resize dimensions.
 *
 * `postWidth`/`postHeight` default to the resized values (longer edge clamped
 * to 1024 with aspect preserved) if omitted, which matches the helper's
 * expected behavior on real device.
 */
function wireManipulator(probe: ProbeOpts, postWidth?: number, postHeight?: number) {
  const longer = Math.max(probe.width, probe.height);
  let outW = probe.width;
  let outH = probe.height;
  if (longer > 1024) {
    if (probe.width >= probe.height) {
      outW = 1024;
      outH = Math.round((probe.height / probe.width) * 1024);
    } else {
      outH = 1024;
      outW = Math.round((probe.width / probe.height) * 1024);
    }
  }
  const finalWidth = postWidth ?? outW;
  const finalHeight = postHeight ?? outH;

  manipulateAsync
    .mockResolvedValueOnce({
      uri: PROBE_CACHE_URI,
      width: probe.width,
      height: probe.height,
    } as never)
    .mockResolvedValueOnce({
      uri: FINAL_CACHE_URI,
      width: finalWidth,
      height: finalHeight,
    } as never);
}

beforeEach(() => {
  manipulateAsync.mockReset();
  makeDirectoryAsync.mockReset();
  makeDirectoryAsync.mockResolvedValue(undefined as never);
  copyAsync.mockReset();
  copyAsync.mockResolvedValue(undefined as never);
  deleteAsync.mockReset();
  deleteAsync.mockResolvedValue(undefined as never);
  getInfoAsync.mockReset();
  getInfoAsync.mockResolvedValue({
    exists: true,
    size: 12345,
    isDirectory: false,
    uri: '',
  } as never);
  FileSystemMock.__setDocumentDirectory(DOC_DIR);
});

// ─── tests ──────────────────────────────────────────────────────────────────

describe('compressPhoto', () => {
  it('landscape source larger than 1024 → resizes by width', async () => {
    wireManipulator({ width: 2048, height: 1536 });

    const result = await compressPhoto({
      sourceUri: 'file:///camera/img.jpg',
      plantId: 'plant_42',
      nowMs: 1_700_000_000_000,
    });

    // Second call is the real compress; first call is the probe.
    expect(manipulateAsync).toHaveBeenCalledTimes(2);
    const compressArgs = manipulateAsync.mock.calls[1];
    expect(compressArgs[1]).toEqual([{ resize: { width: 1024 } }]);
    expect(result.width).toBe(1024);
    expect(result.height).toBe(768);
  });

  it('portrait source larger than 1024 → resizes by height', async () => {
    wireManipulator({ width: 1536, height: 2048 });

    const result = await compressPhoto({
      sourceUri: 'file:///camera/img.jpg',
      plantId: 'plant_42',
    });

    const compressArgs = manipulateAsync.mock.calls[1];
    expect(compressArgs[1]).toEqual([{ resize: { height: 1024 } }]);
    expect(result.height).toBe(1024);
    expect(result.width).toBe(768);
  });

  it('source already ≤ 1024 longer edge → no resize, recompress only', async () => {
    wireManipulator({ width: 800, height: 600 });

    await compressPhoto({ sourceUri: 'file:///camera/small.jpg', plantId: 'plant_42' });

    const compressArgs = manipulateAsync.mock.calls[1];
    expect(compressArgs[1]).toEqual([]);
    // Save options still requested at quality 0.7.
    expect(compressArgs[2]).toMatchObject({ compress: 0.7 });
  });

  it('always passes compress: 0.7 to manipulateAsync', async () => {
    wireManipulator({ width: 4032, height: 3024 });

    await compressPhoto({ sourceUri: 'file:///camera/img.jpg', plantId: 'p1' });

    const compressArgs = manipulateAsync.mock.calls[1];
    expect(compressArgs[2]).toMatchObject({ compress: 0.7 });
  });

  it('always passes JPEG format (not PNG)', async () => {
    wireManipulator({ width: 4032, height: 3024 });

    await compressPhoto({ sourceUri: 'file:///camera/img.jpg', plantId: 'p1' });

    const compressArgs = manipulateAsync.mock.calls[1];
    expect(compressArgs[2]).toMatchObject({ format: 'jpeg' });
  });

  it('writes output under documentDirectory + plants/<plantId>/', async () => {
    wireManipulator({ width: 2048, height: 1536 });

    const result = await compressPhoto({
      sourceUri: 'file:///camera/img.jpg',
      plantId: 'plant_42',
      nowMs: 1_700_000_000_000,
    });

    expect(result.uri.startsWith(`${DOC_DIR}plants/plant_42/`)).toBe(true);
    expect(copyAsync).toHaveBeenCalledWith({
      from: FINAL_CACHE_URI,
      to: result.uri,
    });
  });

  it('plantId omitted → falls back to unattached/ subdir', async () => {
    wireManipulator({ width: 2048, height: 1536 });

    const result = await compressPhoto({ sourceUri: 'file:///camera/img.jpg' });

    expect(result.uri.startsWith(`${DOC_DIR}plants/unattached/`)).toBe(true);
  });

  it('filename includes nowMs and an 8-char hex suffix', async () => {
    wireManipulator({ width: 2048, height: 1536 });

    const result = await compressPhoto({
      sourceUri: 'file:///camera/img.jpg',
      plantId: 'p1',
      nowMs: 1_700_000_000_000,
    });

    // expected pattern: file:///mock/Documents/plants/p1/<ts>-<8hex>.jpg
    const filename = result.uri.split('/').pop()!;
    expect(filename).toMatch(/^1700000000000-[0-9a-f]{8}\.jpg$/);
  });

  it('returned uri starts with documentDirectory prefix', async () => {
    wireManipulator({ width: 2048, height: 1536 });

    const result = await compressPhoto({ sourceUri: 'file:///camera/img.jpg', plantId: 'p1' });

    expect(result.uri.startsWith(DOC_DIR)).toBe(true);
  });

  it('returned sizeBytes comes from getInfoAsync', async () => {
    wireManipulator({ width: 2048, height: 1536 });
    getInfoAsync.mockResolvedValueOnce({
      exists: true,
      size: 254_321,
      isDirectory: false,
      uri: '',
    } as never);

    const result = await compressPhoto({ sourceUri: 'file:///camera/img.jpg', plantId: 'p1' });

    expect(result.sizeBytes).toBe(254_321);
  });

  it('empty source uri → throws PhotoCompressError with kind source-missing', async () => {
    await expect(compressPhoto({ sourceUri: '', plantId: 'p1' })).rejects.toMatchObject({
      name: 'PhotoCompressError',
      kind: 'source-missing',
    });
    // Whitespace-only counts as missing too.
    await expect(compressPhoto({ sourceUri: '   ', plantId: 'p1' })).rejects.toBeInstanceOf(
      PhotoCompressError,
    );
  });

  it('manipulateAsync throws → wraps in PhotoCompressError(manipulate-failed) with cause preserved', async () => {
    const underlying = new Error('native module crashed');
    manipulateAsync.mockRejectedValueOnce(underlying as never);

    let caught: unknown;
    try {
      await compressPhoto({ sourceUri: 'file:///camera/img.jpg', plantId: 'p1' });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(PhotoCompressError);
    expect((caught as PhotoCompressError).kind).toBe('manipulate-failed');
    // Error.cause is the load-bearing observability hook — assert it survives.
    expect((caught as PhotoCompressError).cause).toBe(underlying);
  });

  it('directory creation uses intermediates: true', async () => {
    wireManipulator({ width: 2048, height: 1536 });

    await compressPhoto({ sourceUri: 'file:///camera/img.jpg', plantId: 'p1' });

    expect(makeDirectoryAsync).toHaveBeenCalledWith(
      `${DOC_DIR}plants/p1/`,
      { intermediates: true },
    );
  });

  it('cleans up the manipulator cache file after copy', async () => {
    wireManipulator({ width: 2048, height: 1536 });

    await compressPhoto({ sourceUri: 'file:///camera/img.jpg', plantId: 'p1' });

    // deleteAsync should have been called for the FINAL_CACHE_URI (the
    // post-compress cache file). The probe cache URI may also be deleted but
    // we only assert on the post-compress one — that's the load-bearing
    // cleanup.
    const deletedUris = (deleteAsync.mock.calls as unknown[][]).map((c) => c[0]);
    expect(deletedUris).toContain(FINAL_CACHE_URI);
  });

  it('documentDirectory unavailable → throws storage-unavailable', async () => {
    FileSystemMock.__setDocumentDirectory(null);

    await expect(
      compressPhoto({ sourceUri: 'file:///camera/img.jpg', plantId: 'p1' }),
    ).rejects.toMatchObject({
      name: 'PhotoCompressError',
      kind: 'storage-unavailable',
    });
    expect(manipulateAsync).not.toHaveBeenCalled();
  });

  it('plantId with path traversal characters is sanitized', async () => {
    wireManipulator({ width: 2048, height: 1536 });

    const result = await compressPhoto({
      sourceUri: 'file:///camera/img.jpg',
      plantId: '../../../etc/passwd',
    });

    // All `.` and `/` are stripped; only the alnum tail survives. The URI
    // must still live under the plants/ root.
    expect(result.uri.startsWith(`${DOC_DIR}plants/`)).toBe(true);
    expect(result.uri.includes('..')).toBe(false);
    expect(result.uri.includes('etc/passwd')).toBe(false);
  });
});

describe('getPhotoDirectory', () => {
  it('returns the documentDirectory + plants/<id>/ for a given plantId', () => {
    expect(getPhotoDirectory('plant_42')).toBe(`${DOC_DIR}plants/plant_42/`);
  });

  it('throws storage-unavailable when documentDirectory is null', () => {
    FileSystemMock.__setDocumentDirectory(null);
    expect(() => getPhotoDirectory('p1')).toThrow(PhotoCompressError);
  });
});
