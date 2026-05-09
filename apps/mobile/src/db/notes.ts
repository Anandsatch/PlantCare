/**
 * `notes` table CRUD. Mirrors the `usePlants` raw-SQL pattern: a pure
 * `createNotesApi(executor)` factory that returns INSERT / SELECT helpers,
 * plus a thin React `useNotes()` hook backed by the memoized `openDb()`
 * connection.
 *
 * Schema (from `db/schema.ts`):
 *
 *   CREATE TABLE notes (
 *     id              TEXT PRIMARY KEY,
 *     plant_id        TEXT NOT NULL REFERENCES plants(id) ON DELETE CASCADE,
 *     written_at      INTEGER NOT NULL,         -- unix ms
 *     user_text       TEXT NOT NULL,
 *     llm_response    TEXT,                     -- JSON-serialized ConsultResponse
 *     consult_status  TEXT NOT NULL             -- discriminated union, stored verbatim
 *   );
 *
 * Storage choices (codex review brief: discriminated kind storage as TEXT):
 *
 *   - `consult_status` is TEXT, not a CHECK enum. The mobile client's
 *     `ApiResult.kind` union evolves; adding a new variant must NOT trigger
 *     a SQLite migration. Validation happens at the boundary in `addNote` —
 *     hostile / typo'd values throw before SQL runs. CONSULT_STATUS_VALUES
 *     in `types.ts` is the authoritative list.
 *   - `llm_response` is JSON-serialized to a TEXT cell. The full
 *     `ConsultResponse` body is small (≤ ~600 bytes), the column is rarely
 *     queried-on, and storing the structured response lets `/api/review`
 *     reasoning carry through to the next interaction without losing fields.
 *     `null` is used for queued / non-LLM saves.
 *   - INSERT ... RETURNING for the write-then-read atomic shape (Wave 1
 *     lesson; same as `usePlants.create`). SQLite ≥ 3.35 supports RETURNING;
 *     expo-sqlite ≥ 14 ships SQLite 3.45+, and better-sqlite3 ships 3.46+.
 *
 * UTC ms only — no calendar math. `written_at` is unix milliseconds
 * (`Date.now()`); the watering-engine DST regression test (E4-002) is the
 * project-wide lock and applies here too.
 */
import { useMemo } from 'react';

import { openDb } from './db';
import {
  CONSULT_STATUS_VALUES,
  type NoteConsultStatus,
  type CreateNoteInput,
  type Note,
  type NoteRow,
} from './types';

// Reuse the executor shape from usePlants — same surface, same backends.
import type { PlantsExecutor, SqlBindValue } from '../hooks/usePlants';

export type NotesExecutor = PlantsExecutor;

const SELECT_COLUMNS =
  'id, plant_id, written_at, user_text, llm_response, consult_status';

/** O(1) membership check for the discriminated-status validator. */
const CONSULT_STATUS_SET: ReadonlySet<string> = new Set(CONSULT_STATUS_VALUES);

function isNoteConsultStatus(value: string): value is NoteConsultStatus {
  return CONSULT_STATUS_SET.has(value);
}

function rowToNote(row: NoteRow): Note {
  // `consult_status` is widened to `string` on the row to match what
  // better-sqlite3 / expo-sqlite return; we narrow back to the union after
  // verifying membership. A row with an unknown value pre-dates a deployed
  // schema-extension and shouldn't crash reads — clamp to 'parse_error' so
  // the UI surfaces it as a generic problem rather than a hard throw on
  // every list render.
  //
  // Codex P3 (read-layer fidelity): clamping loses the original discriminator
  // for analytics / future-aware UI. Mitigation: the row is "stored verbatim"
  // in SQLite — callers that need the raw value (e.g. a future migration
  // backfill or an analytics export) should run a direct SELECT, not the
  // narrowed read API. The narrowed API is the typed safe path; the column
  // remains the source of truth for end-to-end fidelity.
  const status: NoteConsultStatus = isNoteConsultStatus(row.consult_status)
    ? row.consult_status
    : 'parse_error';
  return {
    id: row.id,
    plant_id: row.plant_id,
    written_at: row.written_at,
    user_text: row.user_text,
    llm_response: row.llm_response,
    consult_status: status,
  };
}

function generateId(): string {
  // Same path as `usePlants` — Hermes (RN 0.74+) and Node 20+ both expose
  // `crypto.randomUUID`. Failure here is an environment problem, not a
  // recoverable one; throw loudly.
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (!c?.randomUUID) {
    throw new Error('crypto.randomUUID is unavailable; cannot generate note id');
  }
  return c.randomUUID();
}

/**
 * Pure-data notes API. Takes a `NotesExecutor` and returns the public
 * methods. Exported for tests + for the persist hook + for any future code
 * that needs to operate on notes outside a React render (drainer tasks,
 * /api/review aggregation).
 */
export function createNotesApi(executor: NotesExecutor) {
  async function addNote(input: CreateNoteInput): Promise<Note> {
    const userText = input.user_text;
    if (!userText || userText.trim() === '') {
      // Defensive — the AddNoteSheet UI also disables Save on empty trim.
      // Throw at the boundary so the caller's bug isn't silently committed.
      throw new Error('addNote: user_text is required (non-empty after trim)');
    }
    if (!input.plant_id || input.plant_id.trim() === '') {
      throw new Error('addNote: plant_id is required');
    }
    if (!isNoteConsultStatus(input.consult_status)) {
      // Boundary check for the discriminated union. SQLite-level CHECK is
      // intentionally absent (see file header); this throw is the equivalent
      // type guard in JS land.
      throw new Error(
        `addNote: unknown consult_status "${input.consult_status}" — must be one of ${CONSULT_STATUS_VALUES.join(', ')}`,
      );
    }

    const id = input.id ?? generateId();
    const written_at = input.written_at ?? Date.now();
    // `llm_response` is JSON-serialized so the full ConsultResponse can
    // round-trip. `null` stays NULL on the wire (not the literal string
    // "null"). Stringify is wrapped: a circular ref or non-serializable
    // value should fail loudly at the boundary, not silently corrupt the
    // row.
    let llmResponseJson: string | null;
    if (input.llm_response === null || input.llm_response === undefined) {
      llmResponseJson = null;
    } else {
      try {
        llmResponseJson = JSON.stringify(input.llm_response);
      } catch (err) {
        throw new Error(
          `addNote: llm_response is not JSON-serializable: ${(err as Error).message}`,
        );
      }
    }

    // INSERT ... RETURNING for atomic write-then-read. A separate INSERT +
    // SELECT could race against a concurrent DELETE on the plant id (CASCADE
    // would remove the row before our SELECT lands) and return `null`.
    // RETURNING gives us the row produced by THIS statement.
    const params: SqlBindValue[] = [
      id,
      input.plant_id,
      written_at,
      userText,
      llmResponseJson,
      input.consult_status,
    ];

    const row = await executor.getFirstAsync<NoteRow>(
      `INSERT INTO notes (id, plant_id, written_at, user_text, llm_response, consult_status)
       VALUES (?, ?, ?, ?, ?, ?)
       RETURNING ${SELECT_COLUMNS}`,
      params,
    );
    if (!row) {
      // Should be impossible: a successful INSERT always returns a row from
      // RETURNING. Surface loudly if it ever happens.
      throw new Error(`addNote: insert succeeded but RETURNING produced no row for ${id}`);
    }
    return rowToNote(row);
  }

  async function selectNotesForPlant(opts: {
    plant_id: string;
    /** Default 50; clamped to [1, 200]. */
    limit?: number;
  }): Promise<Note[]> {
    const requestedLimit = opts.limit ?? 50;
    if (!Number.isFinite(requestedLimit) || requestedLimit <= 0) {
      throw new Error(`selectNotesForPlant: limit must be a positive integer (got ${requestedLimit})`);
    }
    // Clamp to a generous cap so a runaway caller doesn't dump every row
    // into memory. V1 expects ≤ 50 notes/plant.
    const limit = Math.min(Math.floor(requestedLimit), 200);

    const rows = await executor.getAllAsync<NoteRow>(
      `SELECT ${SELECT_COLUMNS} FROM notes
       WHERE plant_id = ?
       ORDER BY written_at DESC
       LIMIT ?`,
      [opts.plant_id, limit],
    );
    return rows.map(rowToNote);
  }

  return { addNote, selectNotesForPlant };
}

export type NotesApi = ReturnType<typeof createNotesApi>;

function createOpenDbExecutor(): NotesExecutor {
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

/**
 * React hook surface. Stable callbacks via `useMemo` (empty dep array — the
 * underlying `openDb()` is module-memoized so identity doesn't change).
 */
export function useNotes(): NotesApi {
  return useMemo(() => createNotesApi(createOpenDbExecutor()), []);
}
