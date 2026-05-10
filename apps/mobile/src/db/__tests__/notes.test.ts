/**
 * `notes` table tests — drive the pure data API (`createNotesApi`) against
 * a `better-sqlite3`-backed adapter. Same harness shape as
 * `usePlants.test.tsx` and `migrations.test.ts`: native expo-sqlite doesn't
 * load in Jest's Node environment, but every SQL byte we ship is identical
 * between the two backends, so the SQL contract is what gets tested here.
 *
 * Coverage targets the codex review brief items:
 *   (a) INSERT ... RETURNING atomic pattern
 *   (b) discriminated kind storage as TEXT — boundary validation, no CHECK
 *   (c) FK behavior on plant_id (PRAGMA foreign_keys = ON)
 *   (d) migration idempotency (re-runs of runMigrations don't error)
 *   (f) UTC ms only — `written_at` matches `Date.now()` window
 *   selectNotesForPlant ordering + limit clamping
 */
import Database from 'better-sqlite3';
type DatabaseSync = Database.Database;

import { runMigrations } from '../../db/migrations';
import { createNotesApi } from '../../db/notes';
import type { NoteRow } from '../../db/types';
import type { PlantsExecutor, SqlBindValue } from '../../hooks/usePlants';

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

async function setupDb(): Promise<{
  raw: DatabaseSync;
  api: ReturnType<typeof createNotesApi>;
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
  const api = createNotesApi(makeAdapter(raw));
  return { raw, api, plantId };
}

describe('addNote -- INSERT then RETURNING', () => {
  it('inserts a row with all fields and returns the inserted row atomically', async () => {
    const { raw, api, plantId } = await setupDb();
    const before = Date.now();
    const note = await api.addNote({
      plant_id: plantId,
      user_text: 'Just repotted, leaves drooping',
      llm_response: { kind: 'recommendation', reasoning: 'hold off 3 days' },
      consult_status: 'ok',
    });
    const after = Date.now();

    expect(note.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(note.plant_id).toBe(plantId);
    expect(note.user_text).toBe('Just repotted, leaves drooping');
    expect(note.consult_status).toBe('ok');
    expect(note.llm_response).toBe(
      JSON.stringify({ kind: 'recommendation', reasoning: 'hold off 3 days' }),
    );
    expect(note.written_at).toBeGreaterThanOrEqual(before);
    expect(note.written_at).toBeLessThanOrEqual(after);

    const row = raw
      .prepare(
        'SELECT id, plant_id, user_text, consult_status, llm_response FROM notes WHERE id = ?',
      )
      .get(note.id) as {
      id: string;
      plant_id: string;
      user_text: string;
      consult_status: string;
      llm_response: string | null;
    };
    expect(row).toEqual({
      id: note.id,
      plant_id: plantId,
      user_text: 'Just repotted, leaves drooping',
      consult_status: 'ok',
      llm_response: JSON.stringify({ kind: 'recommendation', reasoning: 'hold off 3 days' }),
    });
  });

  it('honors a caller-supplied id and timestamp', async () => {
    const { api, plantId } = await setupDb();
    const note = await api.addNote({
      id: 'note_custom_42',
      plant_id: plantId,
      user_text: 'A',
      llm_response: null,
      consult_status: 'queued',
      written_at: 1_700_000_000_000,
    });
    expect(note.id).toBe('note_custom_42');
    expect(note.written_at).toBe(1_700_000_000_000);
  });
});

describe('addNote -- discriminated kind storage', () => {
  it('stores the consult_status verbatim for every locked kind', async () => {
    const { raw, api, plantId } = await setupDb();
    const kinds = [
      'ok',
      'queued',
      'rejected_off_topic',
      'low_confidence',
      'timeout',
      'server',
      'parse_error',
    ] as const;
    for (const kind of kinds) {
      await api.addNote({
        plant_id: plantId,
        user_text: `note for ${kind}`,
        llm_response: null,
        consult_status: kind,
      });
    }
    const rows = raw
      .prepare('SELECT consult_status FROM notes ORDER BY written_at ASC')
      .all() as { consult_status: string }[];
    expect(rows.map((r) => r.consult_status)).toEqual(kinds);
  });

  it('rejects an unknown consult_status at the boundary (no SQL runs)', async () => {
    const { raw, api, plantId } = await setupDb();
    await expect(
      api.addNote({
        plant_id: plantId,
        user_text: 'note',
        llm_response: null,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        consult_status: 'bogus' as any,
      }),
    ).rejects.toThrow(/unknown consult_status/);

    const count = (raw.prepare('SELECT count(*) AS c FROM notes').get() as { c: number }).c;
    expect(count).toBe(0);
  });
});

describe('addNote -- llm_response JSON serialization', () => {
  it('persists null when llmResponse is null', async () => {
    const { raw, api, plantId } = await setupDb();
    const note = await api.addNote({
      plant_id: plantId,
      user_text: 'queued offline',
      llm_response: null,
      consult_status: 'queued',
    });
    expect(note.llm_response).toBeNull();
    const row = raw
      .prepare('SELECT llm_response FROM notes WHERE id = ?')
      .get(note.id) as { llm_response: string | null };
    expect(row.llm_response).toBeNull();
  });

  it('round-trips a structured ConsultResponse through JSON', async () => {
    const { api, plantId } = await setupDb();
    const response = {
      kind: 'recommendation',
      revised_interval_days: 5,
      reasoning: 'hold off -- the soil is still moist',
      confidence: 82,
      source: 'free_then_paid',
      latency_ms: 1234,
    };
    const note = await api.addNote({
      plant_id: plantId,
      user_text: 'leaves yellowing',
      llm_response: response,
      consult_status: 'ok',
    });
    const parsed = JSON.parse(note.llm_response as string);
    expect(parsed).toEqual(response);
  });
});

describe('addNote -- input validation', () => {
  it('throws on empty user_text', async () => {
    const { api, plantId } = await setupDb();
    await expect(
      api.addNote({
        plant_id: plantId,
        user_text: '',
        llm_response: null,
        consult_status: 'ok',
      }),
    ).rejects.toThrow(/user_text/);
    await expect(
      api.addNote({
        plant_id: plantId,
        user_text: '   \n\t  ',
        llm_response: null,
        consult_status: 'ok',
      }),
    ).rejects.toThrow(/user_text/);
  });

  it('throws on missing plant_id', async () => {
    const { api } = await setupDb();
    await expect(
      api.addNote({
        plant_id: '',
        user_text: 'note',
        llm_response: null,
        consult_status: 'ok',
      }),
    ).rejects.toThrow(/plant_id/);
  });
});

describe('addNote -- foreign key constraint', () => {
  it('enforces plant_id existence with PRAGMA foreign_keys = ON', async () => {
    const { api } = await setupDb();
    await expect(
      api.addNote({
        plant_id: 'does-not-exist',
        user_text: 'orphan note',
        llm_response: null,
        consult_status: 'ok',
      }),
    ).rejects.toThrow(/FOREIGN KEY/i);
  });

  it('cascade-deletes notes when the parent plant is removed', async () => {
    const { raw, api, plantId } = await setupDb();
    await api.addNote({
      plant_id: plantId,
      user_text: 'note',
      llm_response: null,
      consult_status: 'ok',
    });
    expect(
      (raw.prepare('SELECT count(*) AS c FROM notes').get() as { c: number }).c,
    ).toBe(1);

    raw.prepare('DELETE FROM plants WHERE id = ?').run(plantId);

    expect(
      (raw.prepare('SELECT count(*) AS c FROM notes').get() as { c: number }).c,
    ).toBe(0);
  });
});

describe('selectNotesForPlant', () => {
  it('returns recent notes for a plant ordered by written_at DESC', async () => {
    const { raw, api, plantId } = await setupDb();
    raw.prepare(
      `INSERT INTO notes (id, plant_id, written_at, user_text, consult_status) VALUES
       ('n1', ?, 1000, 'first', 'ok'),
       ('n2', ?, 3000, 'third', 'ok'),
       ('n3', ?, 2000, 'second', 'ok')`,
    ).run(plantId, plantId, plantId);
    const notes = await api.selectNotesForPlant({ plant_id: plantId });
    expect(notes.map((n) => n.id)).toEqual(['n2', 'n3', 'n1']);
  });

  it('respects the limit and clamps to the 200 cap', async () => {
    const { raw, api, plantId } = await setupDb();
    for (let i = 0; i < 10; i++) {
      raw
        .prepare(
          "INSERT INTO notes (id, plant_id, written_at, user_text, consult_status) VALUES (?, ?, ?, ?, 'ok')",
        )
        .run(`n${i}`, plantId, i * 1000, `text-${i}`);
    }
    const limited = await api.selectNotesForPlant({ plant_id: plantId, limit: 3 });
    expect(limited).toHaveLength(3);
    expect(limited.map((n) => n.id)).toEqual(['n9', 'n8', 'n7']);

    const huge = await api.selectNotesForPlant({ plant_id: plantId, limit: 5000 });
    expect(huge).toHaveLength(10);
  });

  it('rejects non-positive limits', async () => {
    const { api, plantId } = await setupDb();
    await expect(
      api.selectNotesForPlant({ plant_id: plantId, limit: 0 }),
    ).rejects.toThrow(/positive integer/);
    await expect(
      api.selectNotesForPlant({ plant_id: plantId, limit: -1 }),
    ).rejects.toThrow(/positive integer/);
  });

  it('does not return notes from other plants', async () => {
    const { raw, api, plantId } = await setupDb();
    raw
      .prepare(
        "INSERT INTO plants (id, species_slug, added_at, is_indoor) VALUES ('plant-2', 'monstera', 1000, 1)",
      )
      .run();
    raw
      .prepare(
        "INSERT INTO notes (id, plant_id, written_at, user_text, consult_status) VALUES ('n1', ?, 1000, 'mine', 'ok')",
      )
      .run(plantId);
    raw
      .prepare(
        "INSERT INTO notes (id, plant_id, written_at, user_text, consult_status) VALUES ('n2', 'plant-2', 2000, 'theirs', 'ok')",
      )
      .run();
    const notes = await api.selectNotesForPlant({ plant_id: plantId });
    expect(notes).toHaveLength(1);
    expect(notes[0]!.id).toBe('n1');
  });

  it('clamps an out-of-range stored consult_status to parse_error on read (forward-compat)', async () => {
    const { raw, api, plantId } = await setupDb();
    raw
      .prepare(
        "INSERT INTO notes (id, plant_id, written_at, user_text, consult_status) VALUES ('n1', ?, 1000, 'note', 'mystery_future_kind')",
      )
      .run(plantId);
    const notes = await api.selectNotesForPlant({ plant_id: plantId });
    expect(notes[0]!.consult_status).toBe('parse_error');
  });
});

describe('migrations + notes table', () => {
  it('migration is idempotent -- running runMigrations twice does not error', async () => {
    const raw = new Database(':memory:');
    raw.exec('PRAGMA foreign_keys = ON');
    await runMigrations(makeMigrationAdapter(raw));
    await expect(runMigrations(makeMigrationAdapter(raw))).resolves.toBeUndefined();

    const v = (raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    expect(v).toBe(2);
  });

  it('SCHEMA_V1_SQL creates a notes table with the expected NOT NULL columns', async () => {
    const raw = new Database(':memory:');
    raw.exec('PRAGMA foreign_keys = ON');
    await runMigrations(makeMigrationAdapter(raw));
    const cols = raw
      .prepare("PRAGMA table_info('notes')")
      .all() as { name: string; notnull: number }[];
    const colMap = Object.fromEntries(cols.map((c) => [c.name, c.notnull]));
    expect(colMap).toEqual({
      id: 0,
      plant_id: 1,
      written_at: 1,
      user_text: 1,
      llm_response: 0,
      consult_status: 1,
    });
  });
});

describe('NoteRow shape -- what better-sqlite3 actually returns', () => {
  it('written_at is a number; llm_response is string when set, null when not', async () => {
    const { raw, api, plantId } = await setupDb();
    await api.addNote({
      plant_id: plantId,
      user_text: 'note',
      llm_response: { foo: 'bar' },
      consult_status: 'ok',
    });
    const row = raw
      .prepare('SELECT id, plant_id, written_at, user_text, llm_response, consult_status FROM notes')
      .get() as NoteRow;
    expect(typeof row.written_at).toBe('number');
    expect(typeof row.llm_response).toBe('string');
    expect(JSON.parse(row.llm_response as string)).toEqual({ foo: 'bar' });
  });
});
