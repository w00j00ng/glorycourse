import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { fileExists, readStoreFromDatabase, writeStoreToDatabase } from './sqlite.ts';
import { checkSqliteIntegrity, createSqliteSnapshot } from './sqlite-snapshot.ts';
import type { DatabaseState } from './store.ts';
import { assertValidStore } from './validate-store.ts';

type SqlFile = { name: string; checksum: string };
type History = SqlFile & { version: number };
type Migration = History & { sql: string; down: SqlFile & { sql: string }; legacy?: History };
type State = { version: number; dirty: boolean; legacy: boolean };
type Options = {
  directory?: string;
  backupDirectory?: string;
  onProgress?: (message: string) => void;
  skipBackup?: boolean;
  rotateEpoch?: boolean;
  /** Explicit down destination. Startup omits this and always targets the latest up. */
  targetVersion?: number;
};

const defaultDirectory = resolve(import.meta.dirname, '../../../schema/migrations');
const applicationId = 0x47434f55;
const migrationName = /^[1-9]\d{9}_[a-z][a-z0-9_]*\.up\.sql$/;
const unsafeSql = /\b(?:BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|VACUUM|ATTACH|DETACH)\b|\bPRAGMA\s+(?:journal_mode|foreign_keys|synchronous|writable_schema)\b|\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|DROP\s+TABLE|ALTER\s+TABLE)\s+schema_migrations\b/i;
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const stateSql = `CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY NOT NULL CHECK (version = 0 OR version BETWEEN 1000000000 AND 9999999999),
  dirty INTEGER NOT NULL CHECK (dirty IN (0, 1))
) STRICT;`;

const loadMigrations = async (directory: string): Promise<Migration[]> => {
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')) as {
    targetVersion?: number; migrations?: Array<History & { down: SqlFile }>;
  };
  const legacy = JSON.parse(await readFile(join(directory, 'legacy-manifest.json'), 'utf8')) as { migrations: History[] };
  if (!Array.isArray(legacy?.migrations)) throw new Error('Legacy migration manifest must contain an array');
  const names = (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort();
  if (!Array.isArray(manifest.migrations) || !names.length || names.length !== manifest.migrations.length * 2) {
    throw new Error('Migration manifest and up/down SQL file list differ');
  }
  const migrations: Migration[] = [];
  for (const [index, entry] of manifest.migrations.entries()) {
    if (!migrationName.test(entry.name) || entry.version !== Number(entry.name.slice(0, 10))
      || entry.down?.name !== entry.name.replace('.up.sql', '.down.sql')
      || !names.includes(entry.name) || !names.includes(entry.down.name)
      || (index > 0 && migrations[index - 1].version >= entry.version)) {
      throw new Error('Migration manifest order or up/down filename is invalid');
    }
    const sqls: string[] = [];
    for (const file of [entry, entry.down]) {
      const bytes = await readFile(join(directory, file.name));
      if (!bytes.length || bytes[0] === 0xef || bytes.includes(13) || file.checksum !== hash(bytes)) {
        throw new Error(`Migration checksum or encoding differs: ${file.name}`);
      }
      const sql = bytes.toString('utf8');
      if (unsafeSql.test(sql)) throw new Error(`Unsafe migration transaction or history control: ${file.name}`);
      sqls.push(sql);
    }
    migrations.push({ ...entry, sql: sqls[0], down: { ...entry.down, sql: sqls[1] } });
  }
  if (manifest.targetVersion !== migrations.at(-1)?.version) throw new Error('Migration target version differs');
  for (const [index, row] of legacy.migrations.entries()) {
    const migration = migrations[index];
    if (!row || !migration || row.version !== migration.version || row.name !== migration.name.replace('.up.sql', '.sql')
      || !/^[a-f0-9]{64}$/.test(row.checksum) || (index > 0 && row.checksum !== migration.checksum)) {
      throw new Error('Legacy migration manifest differs from preserved up files');
    }
    migration.legacy = row;
  }
  return migrations;
};

const readState = (db: DatabaseSync, migrations: Migration[]): State => {
  const columns = db.prepare('PRAGMA table_info(schema_migrations)').all().map(({ name }) => name).join(',');
  if (!columns) {
    if (db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").get()?.count !== 0) {
      throw new Error('Unmanaged SQLite database: schema_migrations is missing');
    }
    return { version: 0, dirty: false, legacy: false };
  }
  if (db.prepare('PRAGMA application_id').get()?.application_id !== applicationId) {
    throw new Error('Unsupported Glorycourse SQLite database');
  }
  if (columns === 'version,name,checksum,applied_at,app_version') {
    const history = db.prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version').all() as History[];
    if (!history.length) throw new Error('Incomplete SQLite migration history');
    if (history.length > migrations.length) throw new Error('Database has a newer migration version');
    for (const [index, row] of history.entries()) {
      const expected = migrations[index].legacy;
      if (!expected || row.version !== expected.version || row.name !== expected.name || row.checksum !== expected.checksum) {
        throw new Error('Database legacy migration history differs from this program');
      }
    }
    return { version: history.at(-1)!.version, dirty: false, legacy: true };
  }
  if (columns !== 'version,dirty') throw new Error('Unsupported SQLite migration state columns');
  const rows = db.prepare('SELECT version, dirty FROM schema_migrations').all();
  if (rows.length !== 1 || !Number.isSafeInteger(rows[0].version) || (rows[0].dirty !== 0 && rows[0].dirty !== 1)) {
    throw new Error('SQLite migration state must contain one valid row');
  }
  return { version: Number(rows[0].version), dirty: rows[0].dirty === 1, legacy: false };
};

const checkState = (db: DatabaseSync, state: State, migrations: Migration[], allowDirty = false): void => {
  if (state.dirty && !allowDirty) throw new Error('Database migration is dirty; restore the pre-update backup before retrying');
  if (state.version > migrations.at(-1)!.version) throw new Error('Database has a newer migration version');
  if (state.version !== 0 && !migrations.some(({ version }) => version === state.version)) throw new Error('Database migration version is unknown');
  if (state.version === 0 && !state.dirty
    && db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations'").get()?.count !== 0) {
    throw new Error('Zero migration version requires an empty business database');
  }
};

export const migrateDatabase = async (
  file: string,
  initial?: DatabaseState,
  options: Options = {},
): Promise<{ applied: string[]; backupFile?: string }> => {
  const migrations = await loadMigrations(options.directory ?? defaultDirectory);
  let state: State = { version: 0, dirty: false, legacy: false };
  if (await fileExists(file)) {
    // A crashed database may need to roll back a hot journal first.
    const existing = new DatabaseSync(file);
    try {
      existing.exec('PRAGMA trusted_schema = OFF; PRAGMA busy_timeout = 5000');
      checkSqliteIntegrity(existing);
      state = readState(existing, migrations);
      checkState(existing, state, migrations);
    } finally { existing.close(); }
  }
  const target = options.targetVersion ?? migrations.at(-1)!.version;
  if (!Number.isSafeInteger(target) || (target !== 0 && !migrations.some(({ version }) => version === target))) {
    throw new Error('Requested migration target is unknown');
  }
  if (options.targetVersion !== undefined && target > state.version) throw new Error('Explicit down target cannot exceed the current database version');
  const down = target < state.version;
  const pending = down
    ? migrations.filter(({ version }) => version > target && version <= state.version).reverse().map(({ down: sql }) => sql)
    : migrations.filter(({ version }) => version > state.version);
  if (!pending.length && !state.legacy) return { applied: [] };
  const fresh = state.version === 0;
  if (fresh) {
    if (!initial) throw new Error('Initial store data is required for a new database');
    assertValidStore(initial);
  }
  let backupFile: string | undefined;
  if (!fresh && !options.skipBackup) {
    options.onProgress?.('변경 전 자료를 백업하고 있습니다.');
    const backup = await createSqliteSnapshot(file,
      options.backupDirectory ?? join(dirname(file), 'update-backups'),
      `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}`);
    backupFile = backup.file;
    const copy = new DatabaseSync(backup.file, { readOnly: true });
    try { checkState(copy, readState(copy, migrations), migrations); }
    finally { copy.close(); }
  }
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA trusted_schema = OFF; PRAGMA busy_timeout = 5000; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; BEGIN IMMEDIATE');
    try {
      const latest = readState(db, migrations);
      checkState(db, latest, migrations);
      if (latest.version !== state.version || latest.legacy !== state.legacy) throw new Error('Database migration state changed before applying DDL');
      if (state.legacy) db.exec('ALTER TABLE schema_migrations RENAME TO schema_migrations_legacy');
      if (state.legacy || fresh) {
        db.exec(`PRAGMA application_id = ${applicationId}; ${stateSql}`);
        db.exec('DELETE FROM schema_migrations');
        db.prepare('INSERT INTO schema_migrations (version, dirty) VALUES (?, 0)').run(state.version);
      }
      if (state.legacy) db.exec('DROP TABLE schema_migrations_legacy');
      db.prepare('UPDATE schema_migrations SET version = ?, dirty = ?').run(target, pending.length ? 1 : 0);
      // Commit dirty separately so a failed DDL transaction cannot erase the failure marker.
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* SQLite may already have rolled back. */ }
      throw error;
    }
    if (!pending.length) return { applied: [], backupFile };
    db.exec('BEGIN IMMEDIATE');
    try {
      const marked = readState(db, migrations);
      if (marked.version !== target || !marked.dirty) throw new Error('Database dirty state changed before applying DDL');
      for (const migration of pending) {
        options.onProgress?.(`자료 형식을 갱신하고 있습니다: ${migration.name}`);
        db.exec(migration.sql);
      }
      if (fresh) writeStoreToDatabase(db, initial!);
      else if (target !== 0 && options.rotateEpoch !== false) db.prepare('UPDATE store_meta SET store_epoch = ? WHERE id = 1').run(randomUUID());
      checkSqliteIntegrity(db);
      if (!down) assertValidStore(readStoreFromDatabase(db));
      db.prepare('UPDATE schema_migrations SET dirty = 0').run();
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* SQLite may already have rolled back. */ }
      throw error;
    }
  } finally { db.close(); }
  return { applied: pending.map(({ name }) => name), backupFile };
};

export const inspectMigrationHistory = async (
  file: string,
  directory = defaultDirectory,
): Promise<{ databaseVersion: string; dirty: boolean; pending: number }> => {
  const migrations = await loadMigrations(directory);
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec('PRAGMA trusted_schema = OFF');
    checkSqliteIntegrity(db);
    const state = readState(db, migrations);
    checkState(db, state, migrations, true);
    return { databaseVersion: String(state.version), dirty: state.dirty,
      pending: migrations.filter(({ version }) => version > state.version).length };
  } finally { db.close(); }
};
