/**
 * usePersistNote tests. Drives the hook against a better-sqlite3-backed
 * createNotesApi (real SQL contract) plus injectable txWrap + insertPhotoFn
 * test seams, plus the in-process subscribeToNoteEvents bus.
 */
import { describe, expect, it, jest } from '@jest/globals';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import Database from 'better-sqlite3';

import { runMigrations } from '../../db/migrations';
import { createNotesApi } from '../../db/notes';
import type { Note, NoteConsultStatus } from '../../db/types';
import {
  _resetNoteListenersForTests,
  payloadToPersistInput,
  subscribeToNoteEvents,
  usePersistNote,
} from '../usePersistNote';
import type { PlantsExecutor, SqlBindValue } from '../usePlants';
import type { AddNoteSavedPayload } from '../../components/AddNoteSheet';

type DatabaseSync = Database.Database;

function makeAdapter(db: DatabaseSync): PlantsExecutor {
  return {
    async runAsync(source: string, params: SqlBindValue[]) {
      db.prepare(source).run(...params);
    },
    async getFirstAsync<T>(source: string, params: SqlBindValue[]): Promise<T | null> {
      const row = db.prepare(source).get(...params) as T | undefined;
      return row ?? null;
    },
    async getAllAsync<T>(source: string, params: SqlBindValue[]): Promise<T[]> {
      return db.prepare(source).all(...params) as T[];
    },
  };
}

function makeMigrationAdapter(db: DatabaseSync) {
  return {
    async execAsync(source: string) {
      db.exec(source);
    },
    async getFirstAsync<T>(source: string): Promise<T | null> {
      const row = db.prepare(source).get() as T | undefined;
      return row ?? null;
    },
    async withTransactionAsync(task: () => Promise<void>) {
      db.exec('BEGIN');
      try {
        await task();
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
  };
}

async function setupHarness(): Promise<{
  raw: DatabaseSync;
  notesApi: ReturnType<typeof createNotesApi>;
  txWrap: (task: () => Promise<void>) => Promise<void>;
  plantId: string;
}> {
  const raw = new Database(':memory:');
  raw.exec('PRAGMA foreign_keys = ON');
  await runMigrations(makeMigrationAdapter(raw));
  const plantId = 'plant-1';
  raw
    .prepare(
      "INSERT INTO plants (id, species_slug, added_at, is_indoor) VALUES (?, 'pothos', 1000, 1)",
    )
    .run(plantId);
  const notesApi = createNotesApi(makeAdapter(raw));
  const txWrap = async (task: () => Promise<void>) => {
    raw.exec('BEGIN');
    try {
      await task();
      raw.exec('COMMIT');
    } catch (err) {
      raw.exec('ROLLBACK');
      throw err;
    }
  };
  return { raw, notesApi, txWrap, plantId };
}

beforeEach(() => {
  _resetNoteListenersForTests();
});

describe('usePersistNote -- happy path', () => {
  it('persist with success kind: addNote called and the saved note is returned', async () => {
    const { notesApi, txWrap, plantId, raw } = await setupHarness();
    const insertPhotoFn = jest.fn(async () => undefined);

    const { result } = renderHook(() =>
      usePersistNote(plantId, { notesApi, txWrap, insertPhotoFn }),
    );

    expect(result.current.status).toBe('idle');
    expect(result.current.error).toBeNull();

    let outcome: Awaited<ReturnType<typeof result.current.persist>> | undefined;
    await act(async () => {
      outcome = await result.current.persist({
        note: 'Just repotted',
        llmResponse: { kind: 'recommendation', reasoning: 'hold off' },
        kind: 'ok',
      });
    });

    if (!outcome) throw new Error('outcome undefined');
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('expected ok');
    expect(outcome.note.user_text).toBe('Just repotted');
    expect(outcome.note.consult_status).toBe('ok');
    expect(insertPhotoFn).not.toHaveBeenCalled();

    expect(result.current.status).toBe('saved');
    expect(result.current.error).toBeNull();

    const row = raw.prepare('SELECT count(*) AS c FROM notes').get() as { c: number };
    expect(row.c).toBe(1);
  });

  it('emits a note-saved event after the SQL commit (event fires for the right plant)', async () => {
    const { notesApi, txWrap, plantId } = await setupHarness();
    const events: Note[] = [];
    subscribeToNoteEvents(plantId, (note) => events.push(note));

    const { result } = renderHook(() =>
      usePersistNote(plantId, { notesApi, txWrap }),
    );

    await act(async () => {
      await result.current.persist({ note: 'a note', llmResponse: null, kind: 'ok' });
    });

    expect(events).toHaveLength(1);
    expect(events[0]!.user_text).toBe('a note');
  });

  it('does NOT emit events for other plants', async () => {
    const { notesApi, txWrap, plantId } = await setupHarness();
    const otherEvents: Note[] = [];
    subscribeToNoteEvents('plant-other', (note) => otherEvents.push(note));

    const { result } = renderHook(() =>
      usePersistNote(plantId, { notesApi, txWrap }),
    );

    await act(async () => {
      await result.current.persist({ note: 'mine', llmResponse: null, kind: 'ok' });
    });

    expect(otherEvents).toHaveLength(0);
  });
});

describe('usePersistNote -- with photoUri', () => {
  it('addNote AND insertPhotoFn called inside one transaction', async () => {
    const { notesApi, plantId, raw } = await setupHarness();
    const txCalls: ('begin' | 'inside' | 'commit')[] = [];
    const insertPhotoFn = jest.fn(async () => {
      txCalls.push('inside');
    });
    const txWrap = async (task: () => Promise<void>) => {
      txCalls.push('begin');
      raw.exec('BEGIN');
      try {
        await task();
        raw.exec('COMMIT');
        txCalls.push('commit');
      } catch (err) {
        raw.exec('ROLLBACK');
        throw err;
      }
    };

    const { result } = renderHook(() =>
      usePersistNote(plantId, { notesApi, txWrap, insertPhotoFn }),
    );

    await act(async () => {
      await result.current.persist({
        note: 'with a photo',
        llmResponse: null,
        kind: 'ok',
        photoUri: 'file:///photos/abc.jpg',
        timestamp: 1_700_000_000_000,
      });
    });

    expect(insertPhotoFn).toHaveBeenCalledTimes(1);
    expect(insertPhotoFn).toHaveBeenCalledWith({
      plant_id: plantId,
      uri: 'file:///photos/abc.jpg',
      taken_at: 1_700_000_000_000,
    });
    expect(txCalls).toEqual(['begin', 'inside', 'commit']);

    const row = raw.prepare('SELECT user_text, written_at FROM notes').get() as {
      user_text: string;
      written_at: number;
    };
    expect(row.user_text).toBe('with a photo');
    expect(row.written_at).toBe(1_700_000_000_000);
  });

  it('atomic rollback: if photo INSERT throws, the note INSERT does not commit', async () => {
    const { notesApi, txWrap, plantId, raw } = await setupHarness();
    const insertPhotoFn = jest.fn(async () => {
      throw new Error('photo write failed');
    });

    const { result } = renderHook(() =>
      usePersistNote(plantId, { notesApi, txWrap, insertPhotoFn }),
    );

    await act(async () => {
      const outcome = await result.current.persist({
        note: 'doomed note',
        llmResponse: null,
        kind: 'ok',
        photoUri: 'file:///bad.jpg',
      });
      expect(outcome.ok).toBe(false);
    });

    expect(result.current.status).toBe('error');
    expect(result.current.error?.message).toMatch(/photo write failed/);

    const count = (raw.prepare('SELECT count(*) AS c FROM notes').get() as { c: number }).c;
    expect(count).toBe(0);
  });

  it('persist without photoUri does NOT call the tx wrapper or photo writer', async () => {
    const { notesApi, plantId } = await setupHarness();
    const insertPhotoFn = jest.fn(async () => undefined);
    const txWrap = jest.fn(async (task: () => Promise<void>) => {
      await task();
    });

    const { result } = renderHook(() =>
      usePersistNote(plantId, { notesApi, txWrap, insertPhotoFn }),
    );

    await act(async () => {
      await result.current.persist({ note: 'just text', llmResponse: null, kind: 'ok' });
    });

    expect(insertPhotoFn).not.toHaveBeenCalled();
    expect(txWrap).not.toHaveBeenCalled();
  });
});

describe('usePersistNote -- non-success kinds still persist', () => {
  it('persist with rejected_off_topic kind saves the note (we keep the user text)', async () => {
    const { notesApi, txWrap, plantId, raw } = await setupHarness();
    const { result } = renderHook(() =>
      usePersistNote(plantId, { notesApi, txWrap }),
    );

    await act(async () => {
      const outcome = await result.current.persist({
        note: 'best pasta recipe?',
        llmResponse: null,
        kind: 'rejected_off_topic',
      });
      expect(outcome.ok).toBe(true);
    });

    const row = raw
      .prepare('SELECT user_text, consult_status FROM notes')
      .get() as { user_text: string; consult_status: string };
    expect(row.user_text).toBe('best pasta recipe?');
    expect(row.consult_status).toBe('rejected_off_topic');
  });

  it('persist with queued kind saves with llm_response = NULL', async () => {
    const { notesApi, txWrap, plantId, raw } = await setupHarness();
    const { result } = renderHook(() =>
      usePersistNote(plantId, { notesApi, txWrap }),
    );

    await act(async () => {
      await result.current.persist({
        note: 'offline note',
        llmResponse: null,
        kind: 'queued',
      });
    });

    const row = raw
      .prepare('SELECT consult_status, llm_response FROM notes')
      .get() as { consult_status: string; llm_response: string | null };
    expect(row.consult_status).toBe('queued');
    expect(row.llm_response).toBeNull();
  });
});

describe('usePersistNote -- failure paths', () => {
  it('SQLite error: status flips to error, error is populated, no event emitted', async () => {
    const { txWrap, plantId } = await setupHarness();
    const notesApi = {
      addNote: async () => {
        throw new Error('disk is full');
      },
      selectNotesForPlant: async () => [],
    };
    const events: Note[] = [];
    subscribeToNoteEvents(plantId, (n) => events.push(n));

    const { result } = renderHook(() =>
      usePersistNote(plantId, { notesApi, txWrap }),
    );

    await act(async () => {
      const outcome = await result.current.persist({
        note: 'doomed',
        llmResponse: null,
        kind: 'ok',
      });
      expect(outcome.ok).toBe(false);
    });

    expect(result.current.status).toBe('error');
    expect(result.current.error?.message).toMatch(/disk is full/);
    expect(events).toHaveLength(0);
  });

  it('error is cleared on the next persist call', async () => {
    const { plantId, txWrap } = await setupHarness();
    let callCount = 0;
    const notesApi = {
      addNote: async () => {
        callCount += 1;
        if (callCount === 1) throw new Error('first call fails');
        return {
          id: 'n1',
          plant_id: plantId,
          written_at: Date.now(),
          user_text: 'second',
          llm_response: null,
          consult_status: 'ok' as NoteConsultStatus,
        };
      },
      selectNotesForPlant: async () => [],
    };

    const { result } = renderHook(() =>
      usePersistNote(plantId, { notesApi, txWrap }),
    );

    await act(async () => {
      await result.current.persist({ note: 'first', llmResponse: null, kind: 'ok' });
    });
    expect(result.current.status).toBe('error');

    await act(async () => {
      await result.current.persist({ note: 'second', llmResponse: null, kind: 'ok' });
    });
    expect(result.current.status).toBe('saved');
    expect(result.current.error).toBeNull();
  });
});

describe('usePersistNote -- strict-mode double-mount latch', () => {
  it('two synchronous persist calls in the same tick do NOT issue two writes', async () => {
    const { notesApi, txWrap, plantId, raw } = await setupHarness();
    const { result } = renderHook(() =>
      usePersistNote(plantId, { notesApi, txWrap }),
    );

    await act(async () => {
      const a = result.current.persist({ note: 'a', llmResponse: null, kind: 'ok' });
      const b = result.current.persist({ note: 'b', llmResponse: null, kind: 'ok' });
      const [resA, resB] = await Promise.all([a, b]);
      expect(resA.ok).toBe(true);
      expect(resB.ok).toBe(false);
    });

    const count = (raw.prepare('SELECT count(*) AS c FROM notes').get() as { c: number }).c;
    expect(count).toBe(1);
  });

  it('after the in-flight persist resolves, a follow-up persist proceeds normally', async () => {
    const { notesApi, txWrap, plantId, raw } = await setupHarness();
    const { result } = renderHook(() =>
      usePersistNote(plantId, { notesApi, txWrap }),
    );

    await act(async () => {
      await result.current.persist({ note: 'first', llmResponse: null, kind: 'ok' });
    });
    await act(async () => {
      await result.current.persist({ note: 'second', llmResponse: null, kind: 'ok' });
    });

    const count = (raw.prepare('SELECT count(*) AS c FROM notes').get() as { c: number }).c;
    expect(count).toBe(2);
  });
});

describe('usePersistNote -- UTC ms only', () => {
  it('caller-provided timestamp passes through verbatim (no calendar math)', async () => {
    const { notesApi, txWrap, plantId, raw } = await setupHarness();
    const { result } = renderHook(() =>
      usePersistNote(plantId, { notesApi, txWrap }),
    );

    const dstMs = Date.UTC(2026, 10, 5, 3, 30);
    await act(async () => {
      await result.current.persist({
        note: 'dst note',
        llmResponse: null,
        kind: 'ok',
        timestamp: dstMs,
      });
    });

    const row = raw.prepare('SELECT written_at FROM notes').get() as {
      written_at: number;
    };
    expect(row.written_at).toBe(dstMs);
  });

  it('default timestamp is Date.now() (within a sane window)', async () => {
    const { notesApi, txWrap, plantId, raw } = await setupHarness();
    const { result } = renderHook(() =>
      usePersistNote(plantId, { notesApi, txWrap }),
    );

    const before = Date.now();
    await act(async () => {
      await result.current.persist({ note: 'now-note', llmResponse: null, kind: 'ok' });
    });
    const after = Date.now();

    const row = raw.prepare('SELECT written_at FROM notes').get() as {
      written_at: number;
    };
    expect(row.written_at).toBeGreaterThanOrEqual(before);
    expect(row.written_at).toBeLessThanOrEqual(after);
  });
});

describe('usePersistNote -- unmount safety', () => {
  it('persist that resolves after unmount does not warn (mountedRef gates setState)', async () => {
    const { notesApi, txWrap, plantId } = await setupHarness();
    const { result, unmount } = renderHook(() =>
      usePersistNote(plantId, { notesApi, txWrap }),
    );

    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    let promise: Promise<unknown> | undefined;
    await act(async () => {
      promise = result.current.persist({ note: 'mid-flight', llmResponse: null, kind: 'ok' });
      unmount();
      await promise;
    });

    const warnings = errSpy.mock.calls.flat().join(' ');
    expect(warnings).not.toMatch(/setState/);
    errSpy.mockRestore();
  });
});

describe('payloadToPersistInput', () => {
  it('maps an AddNoteSavedPayload to a PersistNoteInput', () => {
    const payload: AddNoteSavedPayload = {
      note: 'leaves drooping',
      llmResponse: { kind: 'recommendation' } as never,
      timestamp: 1_700_000_000_000,
      status: 'ok',
    };
    expect(payloadToPersistInput(payload)).toEqual({
      note: 'leaves drooping',
      llmResponse: { kind: 'recommendation' },
      kind: 'ok',
      timestamp: 1_700_000_000_000,
    });
  });

  it('maps a queued payload (llmResponse null, status queued)', () => {
    const payload: AddNoteSavedPayload = {
      note: 'offline',
      llmResponse: null,
      timestamp: 1_700_000_000_000,
      status: 'queued',
    };
    expect(payloadToPersistInput(payload)).toEqual({
      note: 'offline',
      llmResponse: null,
      kind: 'queued',
      timestamp: 1_700_000_000_000,
    });
  });
});

describe('subscribeToNoteEvents', () => {
  it('multiple listeners on the same plantId all fire', async () => {
    const { notesApi, txWrap, plantId } = await setupHarness();
    const a: Note[] = [];
    const b: Note[] = [];
    subscribeToNoteEvents(plantId, (n) => a.push(n));
    subscribeToNoteEvents(plantId, (n) => b.push(n));

    const { result } = renderHook(() =>
      usePersistNote(plantId, { notesApi, txWrap }),
    );
    await act(async () => {
      await result.current.persist({ note: 'shared', llmResponse: null, kind: 'ok' });
    });

    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });

  it('unsubscribe stops further callbacks', async () => {
    const { notesApi, txWrap, plantId } = await setupHarness();
    const seen: Note[] = [];
    const off = subscribeToNoteEvents(plantId, (n) => seen.push(n));

    const { result } = renderHook(() =>
      usePersistNote(plantId, { notesApi, txWrap }),
    );
    await act(async () => {
      await result.current.persist({ note: 'one', llmResponse: null, kind: 'ok' });
    });
    off();
    await act(async () => {
      await result.current.persist({ note: 'two', llmResponse: null, kind: 'ok' });
    });

    expect(seen.map((n) => n.user_text)).toEqual(['one']);
  });

  it('a listener that throws does not break the persist resolution or sibling listeners', async () => {
    const { notesApi, txWrap, plantId } = await setupHarness();
    const a: Note[] = [];
    const b: Note[] = [];
    subscribeToNoteEvents(plantId, () => {
      throw new Error('listener bug');
    });
    subscribeToNoteEvents(plantId, (n) => a.push(n));
    subscribeToNoteEvents(plantId, (n) => b.push(n));

    const { result } = renderHook(() =>
      usePersistNote(plantId, { notesApi, txWrap }),
    );

    let outcome: Awaited<ReturnType<typeof result.current.persist>> | undefined;
    await act(async () => {
      outcome = await result.current.persist({ note: 'survives', llmResponse: null, kind: 'ok' });
    });
    expect(outcome?.ok).toBe(true);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });
});

describe('usePersistNote -- status transitions', () => {
  it('idle -> saving -> saved (observable state machine)', async () => {
    const { plantId, txWrap } = await setupHarness();
    let resolveAdd: (v: Note) => void = () => {};
    const pending = new Promise<Note>((r) => {
      resolveAdd = r;
    });
    const notesApi = {
      addNote: () => pending,
      selectNotesForPlant: async () => [],
    };

    const { result } = renderHook(() =>
      usePersistNote(plantId, { notesApi, txWrap }),
    );

    expect(result.current.status).toBe('idle');

    let promise: Promise<unknown> | undefined;
    await act(async () => {
      promise = result.current.persist({ note: 'pending', llmResponse: null, kind: 'ok' });
    });

    await waitFor(() => expect(result.current.status).toBe('saving'));

    await act(async () => {
      resolveAdd({
        id: 'n1',
        plant_id: plantId,
        written_at: 1,
        user_text: 'pending',
        llm_response: null,
        consult_status: 'ok',
      });
      await promise;
    });
    expect(result.current.status).toBe('saved');
  });
});
