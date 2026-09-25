import { stat } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';

import type { StoreAdapter, DatabaseState } from './store.ts';
import { readRelationalStore, writeRelationalStore } from './queries/relational-store.ts';
const applicationId = 0x47434f55;

export class SQLiteAdapter implements StoreAdapter {
  private readonly file: string;

  constructor(file: string) { this.file = file; }

  async read(): Promise<DatabaseState | null> {
    if (!await fileExists(this.file)) return null;
    const db = new DatabaseSync(this.file);
    try {
      db.exec('PRAGMA busy_timeout = 5000; PRAGMA trusted_schema = OFF; PRAGMA foreign_keys = ON; BEGIN');
      const data = readStoreFromDatabase(db);
      db.exec('COMMIT');
      return data;
    } finally { db.close(); }
  }

  async write(data: DatabaseState): Promise<void> {
    const db = new DatabaseSync(this.file);
    try {
      db.exec('PRAGMA busy_timeout = 5000; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; BEGIN IMMEDIATE');
      try {
        if (db.prepare('PRAGMA application_id').get()?.application_id !== applicationId) {
          throw new Error('Unsupported Glorycourse SQLite database');
        }
        writeStoreToDatabase(db, data);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    } finally { db.close(); }
  }
}

export const readStoreFromDatabase = (db: DatabaseSync): DatabaseState => {
  if (db.prepare('PRAGMA application_id').get()?.application_id !== applicationId) {
    throw new Error('Unsupported Glorycourse SQLite database');
  }
  return readRelationalStore(db);
};

export const writeStoreToDatabase = (db: DatabaseSync, data: DatabaseState): void => writeRelationalStore(db, data);

export const fileExists = async (file: string): Promise<boolean> => {
  try { await stat(file); return true; }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
};
