import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { fileExists, readStoreFromDatabase, writeStoreToDatabase } from './sqlite.ts';
import { checkSqliteIntegrity, createSqliteSnapshot } from './sqlite-snapshot.ts';
import type { DatabaseState } from './store.ts';
import { assertValidStore } from './validate-store.ts';

type Migration = { version: number; name: string; checksum: string; sql: string };
type History = { version: number; name: string; checksum: string };
type Options = {
  directory?: string;
  backupDirectory?: string;
  appVersion?: string;
  onProgress?: (message: string) => void;
  skipBackup?: boolean;
  rotateEpoch?: boolean;
};

const defaultDirectory = resolve(import.meta.dirname, '../../../schema/migrations');
const applicationId = 0x47434f55;
const migrationName = /^[1-9]\d{9}_[a-z][a-z0-9_]*\.sql$/;
const unsafeSql = /\b(?:BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|VACUUM|ATTACH|DETACH)\b|\bPRAGMA\s+(?:journal_mode|foreign_keys|synchronous|writable_schema)\b|\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|DROP\s+TABLE|ALTER\s+TABLE)\s+schema_migrations\b/i;
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

const loadMigrations = async (directory: string): Promise<Migration[]> => {
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')) as {
    targetVersion?: number;
    migrations?: History[];
  };
  const names = (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort();
  if (!Array.isArray(manifest.migrations) || !names.length || names.length !== manifest.migrations.length) {
    throw new Error('Migration manifest and SQL file list differ');
  }
  const migrations: Migration[] = [];
  for (const [index, entry] of manifest.migrations.entries()) {
    const name = names[index];
    if (!migrationName.test(name) || entry.name !== name || entry.version !== Number(name.slice(0, 10))
      || (index > 0 && migrations[index - 1].version >= entry.version)) {
      throw new Error('Migration manifest order or filename is invalid');
    }
    const bytes = await readFile(join(directory, name));
    if (!bytes.length || bytes[0] === 0xef || bytes.includes(13) || entry.checksum !== hash(bytes)) {
      throw new Error(`Migration checksum or encoding differs: ${name}`);
    }
    const sql = bytes.toString('utf8');
    if (unsafeSql.test(sql)) throw new Error(`Unsafe migration transaction or history control: ${name}`);
    migrations.push({ ...entry, sql });
  }
  if (manifest.targetVersion !== migrations.at(-1)?.version) throw new Error('Migration target version differs');
  return migrations;
};

const readHistory = (db: DatabaseSync): History[] => {
  const hasLedger = db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get()?.count === 1;
  if (!hasLedger) {
    const hasOtherObjects = db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").get()?.count !== 0;
    if (hasOtherObjects) throw new Error('Unmanaged SQLite database: schema_migrations is missing');
    return [];
  }
  if (db.prepare('PRAGMA application_id').get()?.application_id !== applicationId) {
    throw new Error('Unsupported Glorycourse SQLite database');
  }
  const history = db.prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version').all() as History[];
  if (!history.length) throw new Error('Incomplete SQLite migration history');
  return history;
};

const checkHistory = (history: History[], migrations: Migration[]): void => {
  if (history.length > migrations.length) throw new Error('Database has a newer migration version');
  for (const [index, row] of history.entries()) {
    const expected = migrations[index];
    if (row.version !== expected.version || row.name !== expected.name || row.checksum !== expected.checksum) {
      throw new Error('Database migration history differs from this program');
    }
  }
};

export const migrateDatabase = async (
  file: string,
  initial?: DatabaseState,
  options: Options = {},
): Promise<{ applied: string[]; backupFile?: string }> => {
  const migrations = await loadMigrations(options.directory ?? defaultDirectory);
  const existed = await fileExists(file);
  let history: History[] = [];
  if (existed) {
    // Reading a crashed database may need to roll back a hot journal first.
    const existing = new DatabaseSync(file);
    try {
      existing.exec('PRAGMA trusted_schema = OFF; PRAGMA busy_timeout = 5000');
      checkSqliteIntegrity(existing);
      history = readHistory(existing);
    } finally { existing.close(); }
  }
  checkHistory(history, migrations);
  const pending = migrations.slice(history.length);
  if (!pending.length) return { applied: [] };
  const fresh = !existed || history.length === 0;
  if (fresh) {
    if (!initial) throw new Error('Initial store data is required for a new database');
    assertValidStore(initial);
  }
  let backupFile: string | undefined;
  if (!fresh && !options.skipBackup) {
    options.onProgress?.('변경 전 자료를 백업하고 있습니다.');
    const backup = await createSqliteSnapshot(
      file,
      options.backupDirectory ?? join(dirname(file), 'update-backups'),
      `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}`,
    );
    backupFile = backup.file;
    const copy = new DatabaseSync(backup.file, { readOnly: true });
    try {
      copy.exec('PRAGMA trusted_schema = OFF');
      checkHistory(readHistory(copy), migrations);
    } finally { copy.close(); }
  }
  const appVersion = options.appVersion ?? String(JSON.parse(await readFile(new URL('../../../package.json', import.meta.url), 'utf8')).version);
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA trusted_schema = OFF; PRAGMA busy_timeout = 5000; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; BEGIN IMMEDIATE');
    try {
      checkHistory(readHistory(db), migrations);
      for (const migration of pending) {
        options.onProgress?.(`자료 형식을 갱신하고 있습니다: ${migration.name}`);
        db.exec(migration.sql);
        db.prepare('INSERT INTO schema_migrations (version, name, checksum, applied_at, app_version) VALUES (?, ?, ?, ?, ?)')
          .run(migration.version, migration.name, migration.checksum, new Date().toISOString(), appVersion);
      }
      if (fresh) writeStoreToDatabase(db, structuredClone(initial!));
      else if (options.rotateEpoch !== false) {
        db.prepare('UPDATE store_meta SET store_epoch = ? WHERE id = 1').run(randomUUID());
      }
      checkSqliteIntegrity(db);
      assertValidStore(readStoreFromDatabase(db));
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* SQLite may already have rolled back the failed transaction. */ }
      throw error;
    }
  } finally { db.close(); }
  return { applied: pending.map(({ name }) => name), backupFile };
};

export const inspectMigrationHistory = async (
  file: string,
  directory = defaultDirectory,
): Promise<{ databaseVersion: string; pending: number }> => {
  const migrations = await loadMigrations(directory);
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec('PRAGMA trusted_schema = OFF');
    checkSqliteIntegrity(db);
    const history = readHistory(db);
    checkHistory(history, migrations);
    if (!history.length) throw new Error('Incomplete SQLite migration history');
    return { databaseVersion: String(history.at(-1)!.version), pending: migrations.length - history.length };
  } finally { db.close(); }
};
