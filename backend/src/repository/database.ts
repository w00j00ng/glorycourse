import { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';

import { readRelationalStore, writeRelationalStore } from './relational-store.ts';
import type { DatabaseState } from '../domain/records.ts';
import { StoreEpochConflictError, StoreRecoveryRequiredError, StoreRevisionConflictError } from '../domain/errors.ts';
import { assertValidStore } from '../storage/validate-store.ts';
import { QuerySession } from './queries.ts';

type Version = DatabaseState['meta'];
type WriteOptions = { expectedRevision?: number; expectedEpoch?: string };
type TransactionOptions = { restore?: DatabaseState };

const applicationId = 0x47434f55;

const metadata = (db: DatabaseSync): Version => {
  const row = db.prepare(`
    SELECT store_epoch AS storeEpoch, store_revision AS storeRevision
    FROM store_meta WHERE id = 1
  `).get();
  if (!row) throw new Error('SQLite store metadata is missing');
  return { storeEpoch: String(row.storeEpoch), storeRevision: Number(row.storeRevision) };
};

const sameVersion = (left: Version, right: Version): boolean => (
  left.storeEpoch === right.storeEpoch && left.storeRevision === right.storeRevision
);

const checkVersion = (version: Version, options: WriteOptions): void => {
  if (options.expectedEpoch !== undefined && options.expectedEpoch !== version.storeEpoch) {
    throw new StoreEpochConflictError();
  }
  if (options.expectedRevision !== undefined && options.expectedRevision !== version.storeRevision) {
    throw new StoreRevisionConflictError(version.storeRevision);
  }
};

const connect = (file: string, readOnly = false): DatabaseSync => {
  const db = new DatabaseSync(file, { readOnly });
  try {
    db.exec('PRAGMA busy_timeout = 5000; PRAGMA trusted_schema = OFF; PRAGMA foreign_keys = ON');
    if (!readOnly) db.exec('PRAGMA synchronous = FULL');
    if (db.prepare('PRAGMA application_id').get()?.application_id !== applicationId) {
      throw new Error('Unsupported Glorycourse SQLite database');
    }
    return db;
  } catch (error) { db.close(); throw error; }
};

/** Each operation reads and writes SQLite in its own transaction. */
export class Repository {
  readonly #file: string;
  #tail: Promise<void> = Promise.resolve();
  #recoveryRequired = false;
  #closed = false;

  constructor(file: string) { this.#file = file; }

  read<T>(query: (queries: QuerySession) => T): T {
    return this.#readDatabase((db) => query(new QuerySession(db)));
  }

  write<T>(options: WriteOptions, command: (queries: QuerySession) => T | Promise<T>): Promise<T> {
    return this.#writeDatabase(options, (db) => command(new QuerySession(db)));
  }

  version(): Version {
    return this.#readDatabase(metadata);
  }

  /** Full state is reserved for migration, snapshot validation and recovery. */
  snapshot(): DatabaseState { return this.#readDatabase(readRelationalStore); }

  restore(
    input: DatabaseState,
    options: { expectedRevision: number; expectedEpoch: string; backup: () => Promise<void> },
  ): Promise<void> {
    const candidate = structuredClone(input);
    assertValidStore(candidate);
    return this.#writeDatabase(options, async (db, before) => {
      await options.backup();
      writeRelationalStore(db, candidate, before!);
    }, { restore: candidate }).then(() => { this.#recoveryRequired = false; });
  }

  close(): void { this.#closed = true; }

  #readDatabase<T>(query: (db: DatabaseSync) => T): T {
    if (this.#closed) throw new Error('Repository is closed');
    const db = connect(this.#file, true);
    try {
      db.exec('PRAGMA query_only = ON; BEGIN');
      const result = query(db);
      db.exec('COMMIT');
      return result;
    } finally { db.close(); }
  }

  #writeDatabase<T>(
    options: WriteOptions,
    command: (db: DatabaseSync, previousState?: DatabaseState) => T | Promise<T>,
    transaction: TransactionOptions = {},
  ): Promise<T> {
    const run = this.#tail.then(async () => {
      if (this.#closed) throw new Error('Repository is closed');
      if (this.#recoveryRequired && !transaction.restore) throw new StoreRecoveryRequiredError();
      const db = connect(this.#file);
      let before: Version | undefined;
      let previousState: DatabaseState | undefined;
      let expected: Version | undefined;
      let dataVersion: number | undefined;
      let committing = false;
      let result: T | undefined;
      try {
        db.exec('BEGIN IMMEDIATE; PRAGMA defer_foreign_keys = ON');
        dataVersion = Number(db.prepare('PRAGMA data_version').get()!.data_version);
        before = metadata(db);
        checkVersion(before, options);
        if (transaction.restore) previousState = readRelationalStore(db);
        result = structuredClone(await command(db, previousState));
        if (!transaction.restore) {
          db.prepare('UPDATE store_meta SET store_revision = ? WHERE id = 1').run(before.storeRevision + 1);
        }
        expected = metadata(db);
        committing = true;
        db.exec('COMMIT');
        return result;
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch { /* A completed commit has no active transaction. */ }
        if (!committing) throw error;
        let actual: Version;
        let actualState: DatabaseState | undefined;
        try {
          db.exec('BEGIN');
          actual = metadata(db);
          if (transaction.restore) actualState = readRelationalStore(db);
          if (Number(db.prepare('PRAGMA data_version').get()!.data_version) !== dataVersion) {
            throw new StoreRecoveryRequiredError();
          }
          db.exec('COMMIT');
        }
        catch {
          this.#recoveryRequired = true;
          throw new StoreRecoveryRequiredError();
        }
        if (transaction.restore) {
          if (isDeepStrictEqual(actualState, transaction.restore)) return result as T;
          if (isDeepStrictEqual(actualState, previousState)) throw error;
          this.#recoveryRequired = true;
          throw new StoreRecoveryRequiredError();
        }
        if (sameVersion(actual, expected!)) return result as T;
        if (sameVersion(actual, before!)) throw error;
        this.#recoveryRequired = true;
        throw new StoreRecoveryRequiredError();
      } finally { db.close(); }
    });
    this.#tail = run.then(() => undefined, () => undefined);
    return run;
  }
}
