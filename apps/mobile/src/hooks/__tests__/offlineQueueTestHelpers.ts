/**
 * Test helpers shared by the three E7-004 hook tests.
 * Provides a real better-sqlite3 in-memory database wrapped in the
 * QueueExecutor shape the hooks consume.
 */
import Database from 'better-sqlite3';

import { runMigrations, type SqlExecutor } from '../../db/migrations';
import { type QueueBindValue, type QueueExecutor } from '../../sync';

type DatabaseSync = Database.Database;

export function makeQueueExecutor(db: DatabaseSync): QueueExecutor {
  let txTail: Promise<void> = Promise.resolve();
  return {
    async runAsync(source: string, params: QueueBindValue[]) {
      db.prepare(source).run(...params);
    },
    async getFirstAsync<T>(source: string, params: QueueBindValue[]): Promise<T | null> {
      const r = db.prepare(source).get(...params) as T | undefined;
      return r ?? null;
    },
    async getAllAsync<T>(source: string, params: QueueBindValue[]): Promise<T[]> {
      return db.prepare(source).all(...params) as T[];
    },
    async withExclusiveTransactionAsync(task) {
      const myTurn = txTail.then(async () => {
        db.exec('BEGIN IMMEDIATE');
        try {
          await task();
          db.exec('COMMIT');
        } catch (err) {
          db.exec('ROLLBACK');
          throw err;
        }
      });
      txTail = myTurn.catch(() => undefined);
      await myTurn;
    },
  };
}

function makeMigrationAdapter(db: DatabaseSync): SqlExecutor {
  return {
    async execAsync(source: string) {
      db.exec(source);
    },
    async getFirstAsync<T>(source: string): Promise<T | null> {
      const r = db.prepare(source).get() as T | undefined;
      return r ?? null;
    },
    async withTransactionAsync(task) {
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

export interface FreshQueueDb {
  raw: DatabaseSync;
  q: QueueExecutor;
}

export async function freshQueueDb(): Promise<FreshQueueDb> {
  const raw = new Database(':memory:');
  raw.exec('PRAGMA foreign_keys = ON');
  await runMigrations(makeMigrationAdapter(raw));
  return { raw, q: makeQueueExecutor(raw) };
}

export interface QueueRowSnapshot {
  id: string;
  endpoint: string;
  payload_json: string;
  ref_table: string;
  ref_id: string;
  status: string;
  attempt_count: number;
  next_attempt_at: number;
  created_at: number;
  expires_at: number;
  last_error: string | null;
}

export function readAllQueueRows(raw: DatabaseSync): QueueRowSnapshot[] {
  return raw
    .prepare(
      "SELECT id, endpoint, payload_json, ref_table, ref_id, status, " +
        "attempt_count, next_attempt_at, created_at, expires_at, last_error " +
        "FROM sync_queue ORDER BY created_at ASC, id ASC",
    )
    .all() as QueueRowSnapshot[];
}
