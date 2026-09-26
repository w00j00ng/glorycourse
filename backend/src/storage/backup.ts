import type { Dirent } from 'node:fs';
import { copyFile, mkdir, mkdtemp, open, readdir, rm, stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { inspectMigrationHistory, migrateDatabase } from './migrations.ts';
import { readStoreFromDatabase, SQLiteAdapter } from './sqlite.ts';
import { createSqliteSnapshot, fileSha256 } from './sqlite-snapshot.ts';
import { assertValidStore, type DatabaseState } from './store.ts';

export type Backup = {
  id: string;
  file: string;
  createdAt: string;
  storeRevision: number;
  storeEpoch: string;
  databaseVersion: string;
  status: 'READY' | 'OLDER' | 'NEWER' | 'INVALID';
  sizeBytes: number;
  digest: string;
};

export type BackupRetentionEntry = { file: string; createdAt: string; digest: string; sizeBytes: number };
export type BackupRetentionPlan = {
  directory: string;
  keep: number;
  total: number;
  kept: BackupRetentionEntry[];
  toDelete: BackupRetentionEntry[];
  warning: string;
};

export class BackupConfirmationError extends Error {
  constructor() {
    super('Backup deletion requires exact confirmation of every planned file');
    this.name = 'BackupConfirmationError';
  }
}

export class BackupValidationError extends Error {
  constructor(message: string) { super(message); this.name = 'BackupValidationError'; }
}

const maximumBackupBytes = 512 * 1024 * 1024;
const backupIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

export const createBackup = async (
  dataFile: string,
  backupDirectory: string,
  options: { id: string; now: Date },
): Promise<Backup> => {
  if (!backupIdPattern.test(options.id)) throw new Error('Backup id contains unsupported filename characters');
  const name = `${options.now.toISOString().replaceAll(':', '-')}-${options.id}`;
  const snapshot = await createSqliteSnapshot(dataFile, backupDirectory, name);
  const data = await new SQLiteAdapter(snapshot.file).read();
  assertValidStore(data);
  const { databaseVersion, pending } = await inspectMigrationHistory(snapshot.file);
  if (pending) throw new Error('Backup is not at the current database version');
  return {
    id: options.id, file: snapshot.file, createdAt: options.now.toISOString(),
    storeRevision: data.meta.storeRevision, storeEpoch: data.meta.storeEpoch,
    databaseVersion, status: 'READY', sizeBytes: snapshot.sizeBytes, digest: snapshot.digest,
  };
};

export const listBackups = async (backupDirectory: string): Promise<Backup[]> => {
  let directoryEntries: Dirent[];
  try { directoryEntries = await readdir(backupDirectory, { withFileTypes: true }); }
  catch (error) { if (isMissing(error)) return []; throw error; }
  const backups: Backup[] = [];
  for (const entry of directoryEntries) {
    if (!entry.isFile()) continue;
    const identity = backupIdentity(entry.name);
    if (!identity) continue;
    const file = resolve(backupDirectory, entry.name);
    const base = {
      id: identity.id, file, createdAt: identity.createdAt,
      sizeBytes: (await stat(file)).size, digest: await fileSha256(file),
    };
    try {
      const { databaseVersion, pending } = await inspectMigrationHistory(file);
      const db = new DatabaseSync(file, { readOnly: true });
      let meta: { storeRevision: number; storeEpoch: string };
      try {
        db.exec('PRAGMA trusted_schema = OFF');
        meta = db.prepare(`SELECT store_revision AS storeRevision, store_epoch AS storeEpoch
          FROM store_meta WHERE id = 1`).get() as typeof meta;
        if (!meta) throw new Error('SQLite store metadata is missing');
        if (!pending) assertValidStore(readStoreFromDatabase(db));
      } finally { db.close(); }
      backups.push({ ...base, ...meta, databaseVersion, status: pending ? 'OLDER' : 'READY' });
    } catch (error) {
      backups.push({
        ...base, storeRevision: 0, storeEpoch: '', databaseVersion: '',
        status: error instanceof Error && /newer migration/.test(error.message) ? 'NEWER' : 'INVALID',
      });
    }
  }
  return backups.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
};

export const readBackupFile = async (
  sourceFile: string,
  workDirectory = tmpdir(),
  migrationDirectory?: string,
): Promise<DatabaseState> => {
  const source = await open(sourceFile, 'r');
  try {
    const header = Buffer.alloc(16);
    const { bytesRead } = await source.read(header, 0, header.byteLength, 0);
    validateBackup((await source.stat()).size, header.subarray(0, bytesRead));
  } finally { await source.close(); }
  await mkdir(workDirectory, { recursive: true });
  const directory = await mkdtemp(join(workDirectory, 'restore-'));
  try {
    const file = join(directory, 'candidate.sqlite');
    await copyFile(sourceFile, file);
    return await readBackupCandidate(file, migrationDirectory);
  } finally { await rm(directory, { recursive: true, force: true }); }
};

export const planBackupRetention = async (
  backupDirectory: string,
  keep = 10,
): Promise<BackupRetentionPlan> => {
  if (!Number.isSafeInteger(keep) || keep < 1) throw new Error('Backup retention must keep at least one file');
  const backups = (await listBackups(backupDirectory)).filter(({ status }) => status === 'READY' || status === 'OLDER');
  const entries = backups.map(({ file, createdAt, digest, sizeBytes }) => ({ file, createdAt, digest, sizeBytes }));
  entries.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.file.localeCompare(right.file));
  const deleteCount = Math.max(0, entries.length - keep);
  return {
    directory: resolve(backupDirectory), keep, total: entries.length,
    kept: entries.slice(deleteCount), toDelete: entries.slice(0, deleteCount),
    warning: deleteCount === 0 ? 'No backup will be deleted.' : `${deleteCount} older backup file(s) will be permanently deleted.`,
  };
};

export const pruneBackups = async (
  plan: BackupRetentionPlan,
  confirmedFiles: string[],
): Promise<{ deleted: number }> => {
  const planned = plan.toDelete.map(({ file }) => resolve(file)).sort();
  const confirmed = [...new Set(confirmedFiles.map((file) => resolve(file)))].sort();
  if (planned.length !== confirmed.length || planned.some((file, index) => file !== confirmed[index])) {
    throw new BackupConfirmationError();
  }
  for (const entry of plan.toDelete) {
    const file = resolve(entry.file);
    if (dirname(file) !== resolve(plan.directory) || await fileSha256(file) !== entry.digest) {
      throw new BackupConfirmationError();
    }
    try { await inspectMigrationHistory(file); } catch { throw new BackupConfirmationError(); }
  }
  for (const file of planned) await unlink(file);
  return { deleted: planned.length };
};

export const restoreBackup = async (options: {
  dataFile: string;
  backupFile: string;
  backupDirectory: string;
  newEpoch: string;
  now: Date;
  backupId: string;
}): Promise<{ previousBackup: Backup; storeEpoch: string; storeRevision: number }> => {
  const candidate = await readBackupFile(options.backupFile, join(dirname(options.dataFile), 'recovery-work'));
  const previousBackup = await createBackup(options.dataFile, options.backupDirectory, {
    id: options.backupId, now: options.now,
  });
  candidate.meta.storeEpoch = options.newEpoch;
  const adapter = new SQLiteAdapter(options.dataFile);
  const current = await adapter.read();
  assertValidStore(current);
  candidate.restoreReceipts = current.restoreReceipts;
  await adapter.write(candidate);
  const restored = await adapter.read();
  assertValidStore(restored);
  if (restored.meta.storeEpoch !== options.newEpoch) throw new Error('Restore verification failed');
  return { previousBackup, storeEpoch: restored.meta.storeEpoch, storeRevision: restored.meta.storeRevision };
};

const backupIdentity = (filename: string): { createdAt: string; id: string } | null => {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2}\.\d{3}Z)-([A-Za-z0-9][A-Za-z0-9._-]{0,199})\.sqlite$/.exec(filename);
  if (!match) return null;
  const createdAt = `${match[1]}:${match[2]}:${match[3]}`;
  return Number.isFinite(Date.parse(createdAt)) ? { createdAt, id: match[4] } : null;
};

const isMissing = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === 'ENOENT';

const validateBackup = (size: number, header: Uint8Array): void => {
  if (!size || size > maximumBackupBytes) throw new BackupValidationError('Backup size is unsupported');
  if (Buffer.from(header).toString() !== 'SQLite format 3\0') throw new BackupValidationError('Backup is not a SQLite database');
};

const readBackupCandidate = async (file: string, migrationDirectory?: string): Promise<DatabaseState> => {
  await migrateDatabase(file, undefined, { directory: migrationDirectory, skipBackup: true, rotateEpoch: false });
  const data = await new SQLiteAdapter(file).read();
  assertValidStore(data);
  return structuredClone(data);
};
