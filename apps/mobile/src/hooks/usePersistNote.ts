/**
 * `usePersistNote(plantId)` — wires the AddNoteSheet's `onSave` callback to
 * the local SQLite `notes` table. Owns the persistence boundary that
 * `<AddNoteSheet>` deliberately doesn't cross (per E8-003 module header:
 * "This sheet COLLECTS + EMITS. It never writes to SQLite — E8-005 owns the
 * notes table write").
 *
 * Surface:
 *
 *   const { persist, status, error } = usePersistNote(plantId);
 *   await persist({ note, llmResponse, kind, photoUri? });
 *
 *   status: 'idle' | 'saving' | 'saved' | 'error'
 *   error:  Error | null     // populated when status === 'error'
 *
 * Status state machine:
 *
 *   idle  ── persist() ──▶ saving ── DB ok ──▶ saved
 *                                  └─ DB throws ─▶ error
 *   saved ── persist() ──▶ saving (resets error)
 *   error ── persist() ──▶ saving (resets error)
 *
 * The status is observable for parents that want to render a tiny "Saved ✓"
 * affordance after onSave fires; callers that don't care can simply await
 * `persist()` and check the resolved value.
 *
 * Subscriber emit:
 *   On a successful persist, `usePersistNote` notifies a tiny in-process
 *   event bus keyed by `plant_id` so observing screens (PlantDetailScreen's
 *   note history list, future PhotoTimeline composition with note entries)
 *   can re-derive without resorting to a global query-cache. The bus is a
 *   plain Set<listener> — V1 lock: no react-query / swr / zustand. Tests
 *   exercise the listener contract directly via `subscribeToNoteEvents`.
 *
 * Photo write coupling:
 *   The brief allows an optional `photoUri` on the persist input. If
 *   present, the note INSERT and the photo INSERT happen inside a single
 *   `withTransactionAsync` so a partial failure leaves the DB unchanged.
 *   Per the codex review brief: "race risk if photo write succeeds but
 *   note write fails; consider a transaction wrapping both" — done.
 *
 *   Today's `<AddNoteSheet>` `AddNoteSavedPayload` does NOT include a
 *   photoUri (notes are text-only in V1's add-note flow), so the photo
 *   path is never exercised by the sheet. The hook still accepts it
 *   because: (a) the brief specifies it; (b) E8-007 / future "attach a
 *   photo to your note" extensions can wire it without reshaping this
 *   hook. The hook's tests exercise both paths.
 *
 * V1 scope locks honored:
 *   - No ORM. Raw SQL via `createNotesApi`.
 *   - No date-fns / dayjs. UTC ms only (`Date.now()`).
 *   - No new dep. The event bus is a Set + a tiny exported subscribe fn.
 *   - No mounting the AddNoteSheet here. That's E8-004's job.
 *   - No compressing the kind discriminated union. Stored verbatim.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { openDb } from '../db/db';
import { createNotesApi, type NotesApi, type NotesExecutor } from '../db/notes';
import type { NoteConsultStatus, Note } from '../db/types';
import type { SqlBindValue } from './usePlants';

import type { AddNoteSavedPayload } from '../components/AddNoteSheet';

// ─── Public types ───────────────────────────────────────────────────────

export type PersistNoteStatus = 'idle' | 'saving' | 'saved' | 'error';

/**
 * Input to `persist()`. Mirrors the `AddNoteSavedPayload` shape but renames
 * the discriminator to `kind` to match how the rest of the app talks about
 * `ApiResult.kind`. Keeping the boundary type slim (rather than re-using
 * AddNoteSavedPayload) means the persist hook isn't coupled to the UI's
 * choice of names — the UI can evolve without breaking persistence.
 */
export type PersistNoteInput = {
  note: string;
  /** Serializable LLM response, or `null` when queued / non-LLM. */
  llmResponse: unknown | null;
  /**
   * Discriminated `consult_status` value. Stored verbatim; CONSULT_STATUS_VALUES
   * is the authoritative list. Mapped from `AddNoteSavedPayload.status` via
   * `payloadToPersistInput()` exported below.
   */
  kind: NoteConsultStatus;
  /**
   * Optional photo URI to record alongside the note. When present, the
   * photo INSERT and the note INSERT happen inside one transaction so the
   * pair is atomic. `taken_at_ms` defaults to `Date.now()` (UTC ms only).
   *
   * Today's <AddNoteSheet> doesn't emit photoUri; the path is here for
   * forward-compat per the E8-005 brief.
   */
  photoUri?: string;
  /**
   * Optional override for the row's `written_at`. Defaults to `Date.now()`.
   * Provided so the parent can pin the timestamp to the same value the
   * `<AddNoteSheet>` emitted at submit time, keeping note + UI animations
   * in sync if a future "Just saved" affordance reads from `written_at`.
   */
  timestamp?: number;
};

export type PersistNoteResult =
  | { ok: true; note: Note }
  | { ok: false; error: Error };

export type UsePersistNoteReturn = {
  persist: (input: PersistNoteInput) => Promise<PersistNoteResult>;
  status: PersistNoteStatus;
  /** Populated when status === 'error'. Cleared on the next `persist()` call. */
  error: Error | null;
};

// ─── Subscriber bus ─────────────────────────────────────────────────────

type NoteEventListener = (note: Note) => void;
const NOTE_LISTENERS_BY_PLANT = new Map<string, Set<NoteEventListener>>();

/**
 * Subscribe to note-saved events for a single plant. Returns an unsubscribe
 * fn (the React-idiomatic shape). V1 locks: no react-query, no zustand —
 * a bare Map<plant_id, Set<listener>> is enough. Listeners run synchronously
 * after the persist resolves, AFTER React's `setState` batches have
 * dispatched (we emit from inside an async handler, not a render).
 *
 * Strict-mode safe: each subscribe registers a single listener, each
 * unsubscribe removes that listener. A double-mount in dev produces two
 * subscribe / unsubscribe pairs that net to zero.
 */
export function subscribeToNoteEvents(
  plantId: string,
  listener: NoteEventListener,
): () => void {
  let bucket = NOTE_LISTENERS_BY_PLANT.get(plantId);
  if (!bucket) {
    bucket = new Set();
    NOTE_LISTENERS_BY_PLANT.set(plantId, bucket);
  }
  bucket.add(listener);
  return () => {
    const b = NOTE_LISTENERS_BY_PLANT.get(plantId);
    if (!b) return;
    b.delete(listener);
    if (b.size === 0) NOTE_LISTENERS_BY_PLANT.delete(plantId);
  };
}

function emitNoteSaved(plantId: string, note: Note): void {
  const bucket = NOTE_LISTENERS_BY_PLANT.get(plantId);
  if (!bucket) return;
  // Snapshot the listener set before iterating so a listener that
  // unsubscribes itself during the callback doesn't shift the iteration.
  for (const listener of Array.from(bucket)) {
    try {
      listener(note);
    } catch {
      // A misbehaving listener must not break the persist resolution. Drop
      // it on the floor; the persist call is already committed in SQLite.
    }
  }
}

/** Test helper. Not exported from the barrel. */
export function _resetNoteListenersForTests(): void {
  NOTE_LISTENERS_BY_PLANT.clear();
}

// ─── Optional photo writer ──────────────────────────────────────────────

/**
 * Pure-data photo INSERT used by the optional photoUri branch. Kept inline
 * (rather than exported as a usePhotos() hook) because the `photos` table
 * has no other writers in V1 — the camera flow's E5 results land via
 * diagnose / identify, not via a generic photos helper. When E5-008 / E5-010
 * land, factor this into `db/photos.ts`.
 *
 * Schema (from `db/schema.ts`):
 *
 *   CREATE TABLE photos (
 *     id        TEXT PRIMARY KEY,
 *     plant_id  TEXT REFERENCES plants(id) ON DELETE CASCADE,
 *     uri       TEXT NOT NULL,
 *     taken_at  INTEGER NOT NULL,
 *     kind      TEXT NOT NULL,
 *     width     INTEGER,
 *     height    INTEGER,
 *     bytes     INTEGER
 *   );
 */
async function insertPhoto(
  executor: NotesExecutor,
  args: { plant_id: string; uri: string; taken_at: number },
): Promise<void> {
  const id =
    (globalThis as { crypto?: { randomUUID?: () => string } }).crypto?.randomUUID?.() ??
    null;
  if (!id) {
    throw new Error('insertPhoto: crypto.randomUUID is unavailable');
  }
  // `kind` is required NOT NULL on the photos table. 'note' is the
  // intent-carrying value — distinct from 'identify' / 'diagnose' kinds
  // used by the camera flows (E5).
  const params: SqlBindValue[] = [id, args.plant_id, args.uri, args.taken_at, 'note'];
  await executor.runAsync(
    `INSERT INTO photos (id, plant_id, uri, taken_at, kind) VALUES (?, ?, ?, ?, ?)`,
    params,
  );
}

// ─── Hook ───────────────────────────────────────────────────────────────

/**
 * Optional dep injection for tests. Real callers go through the empty-args
 * surface `usePersistNote(plantId)`. Tests pass a pre-built `notesApi` +
 * an optional `txWrap` so they don't need to spin up `openDb()`.
 *
 * Connection-coherence contract (codex P3): the three injection points
 * MUST resolve to the same SQLite connection. The default wiring resolves
 * everything through the module-memoized `openDb()`, which guarantees this
 * by construction. A test or future caller that injects a custom `txWrap`
 * alongside a custom `notesApi` whose executor wraps a DIFFERENT connection
 * will see partial commits — `txWrap` opens a transaction on connection A
 * while the `notesApi` INSERT runs on connection B, outside that
 * transaction. The injected pieces are a unit; pass all three or none.
 */
export type UsePersistNoteConfig = {
  /**
   * Override the data API. Defaults to one wired against `openDb()`.
   * Must share a connection with `txWrap` + `insertPhotoFn` (see above).
   */
  notesApi?: NotesApi;
  /**
   * Override the transaction wrapper used when both note + photo are
   * written together. Defaults to `db.withTransactionAsync` from
   * `openDb()`. Must call `task()` and rethrow if it throws. Must share a
   * connection with `notesApi` + `insertPhotoFn`.
   */
  txWrap?: (task: () => Promise<void>) => Promise<void>;
  /**
   * Override the photo writer (test seam). Defaults to inline `insertPhoto`.
   * Must share a connection with `notesApi` + `txWrap`.
   */
  insertPhotoFn?: (args: {
    plant_id: string;
    uri: string;
    taken_at: number;
  }) => Promise<void>;
};

export function usePersistNote(
  plantId: string,
  config: UsePersistNoteConfig = {},
): UsePersistNoteReturn {
  const [status, setStatus] = useState<PersistNoteStatus>('idle');
  const [error, setError] = useState<Error | null>(null);

  // Guard setState calls after unmount. React 18 + Strict Mode double-
  // mounts components in dev; without this, an in-flight persist that
  // resolves after unmount will warn (and in production would attempt to
  // update a torn-down tree).
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Dispatch latch — Strict-mode double-mount lock. Like AddNoteSheet's
  // `inFlightRef`, this prevents a synchronous double-call from issuing
  // two writes for one user-perceived submit. The latch is per-press, not
  // per-mount, so it stays correct across React 18's double-mount.
  const inFlightRef = useRef(false);

  const persist = useCallback(
    async (input: PersistNoteInput): Promise<PersistNoteResult> => {
      if (inFlightRef.current) {
        // A second synchronous call before the first resolved. Drop it
        // silently — the first call is the one the user meant. Returning a
        // tagged "skipped" would force every caller to handle a third
        // shape; the caller awaits a promise resolution either way.
        return { ok: false, error: new Error('persist: already in flight') };
      }
      inFlightRef.current = true;

      if (mountedRef.current) {
        setStatus('saving');
        setError(null);
      }

      try {
        const notesApi =
          config.notesApi ?? createNotesApi(createDefaultExecutor());
        const insertPhotoImpl = config.insertPhotoFn ?? defaultInsertPhoto;
        const txWrap = config.txWrap ?? defaultTxWrap;

        // The note + photo write share a single timestamp so a future
        // "show photo + note as one event" composition lines up. Use the
        // caller-provided timestamp when present, else `Date.now()`.
        const written_at = input.timestamp ?? Date.now();

        let savedNote: Note;

        if (input.photoUri) {
          // Atomic pair: both rows commit, or neither. Codex P-brief lock —
          // a partial commit (photo without note, or vice versa) leaves the
          // user staring at an orphan timeline entry.
          let pendingNote: Note | null = null;
          await txWrap(async () => {
            await insertPhotoImpl({
              plant_id: plantId,
              uri: input.photoUri as string,
              taken_at: written_at,
            });
            pendingNote = await notesApi.addNote({
              plant_id: plantId,
              user_text: input.note,
              llm_response: input.llmResponse,
              consult_status: input.kind,
              written_at,
            });
          });
          if (!pendingNote) {
            // Should be impossible: the txWrap resolved without throwing,
            // so addNote ran and returned a row. Surface loudly.
            throw new Error('persist: transaction completed but addNote returned no row');
          }
          savedNote = pendingNote;
        } else {
          savedNote = await notesApi.addNote({
            plant_id: plantId,
            user_text: input.note,
            llm_response: input.llmResponse,
            consult_status: input.kind,
            written_at,
          });
        }

        // Emit AFTER the SQL commit. Listeners that re-query SQLite (e.g.
        // PlantDetailScreen's history list) will see the new row. Emitting
        // before commit would risk a listener observing a row that hasn't
        // been written yet under a future transactional batch.
        emitNoteSaved(plantId, savedNote);

        if (mountedRef.current) {
          setStatus('saved');
          setError(null);
        }
        return { ok: true, note: savedNote };
      } catch (rawErr) {
        const err = rawErr instanceof Error ? rawErr : new Error(String(rawErr));
        if (mountedRef.current) {
          setStatus('error');
          setError(err);
        }
        return { ok: false, error: err };
      } finally {
        inFlightRef.current = false;
      }
    },
    [config.insertPhotoFn, config.notesApi, config.txWrap, plantId],
  );

  return { persist, status, error };
}

// ─── Default executor wiring (against openDb) ───────────────────────────

function createDefaultExecutor(): NotesExecutor {
  return {
    async runAsync(source, params) {
      const db = await openDb();
      return db.runAsync(source, params);
    },
    async getFirstAsync<T>(source: string, params: SqlBindValue[]) {
      const db = await openDb();
      return db.getFirstAsync<T>(source, params);
    },
    async getAllAsync<T>(source: string, params: SqlBindValue[]) {
      const db = await openDb();
      return db.getAllAsync<T>(source, params);
    },
  };
}

async function defaultInsertPhoto(args: {
  plant_id: string;
  uri: string;
  taken_at: number;
}): Promise<void> {
  await insertPhoto(createDefaultExecutor(), args);
}

async function defaultTxWrap(task: () => Promise<void>): Promise<void> {
  const db = await openDb();
  await db.withTransactionAsync(task);
}

// ─── AddNoteSheet payload mapper ────────────────────────────────────────

/**
 * Map the `<AddNoteSheet>` `AddNoteSavedPayload` to a `PersistNoteInput`.
 * The sheet emits a 4-field shape (`note`, `llmResponse`, `timestamp`,
 * `status`) where `status` is `'ok' | 'queued'` — the persist layer accepts
 * the broader `NoteConsultStatus` union (covering `rejected_off_topic`,
 * `low_confidence`, server / timeout / parse_error tails) so future "save
 * the user's text even when the LLM declined" wiring drops in without
 * reshaping the hook.
 *
 * The mapper is exported so the screen that mounts the sheet (E8-004) has
 * a single import: `persist(payloadToPersistInput(payload))`.
 */
export function payloadToPersistInput(
  payload: AddNoteSavedPayload,
): PersistNoteInput {
  return {
    note: payload.note,
    llmResponse: payload.llmResponse,
    kind: payload.status,
    timestamp: payload.timestamp,
  };
}
