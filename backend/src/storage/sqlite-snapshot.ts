import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, mkdir, open, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const checkSqliteIntegrity = (db: DatabaseSync): void => {
  const result = db.prepare('PRAGMA quick_check').all();
  if (result.length !== 1 || result[0].quick_check !== 'ok') throw new Error('SQLite integrity check failed');
  if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('SQLite foreign key check failed');
};

export const fileSha256 = async (file: string): Promise<string> => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
};

export const createSqliteSnapshot = async (
  source: string,
  directory: string,
  name: string,
): Promise<{ file: string; sizeBytes: number; digest: string }> => {
  await mkdir(directory, { recursive: true });
  const file = join(directory, `${name}.sqlite`);
  const partial = `${file}.partial`;
  try { await access(file); throw new Error('Backup file already exists'); }
  catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
  const reservation = await open(partial, 'wx', 0o600);
  await reservation.close();
  try {
    const sourceDb = new DatabaseSync(source, { readOnly: true });
    try {
      sourceDb.exec('PRAGMA trusted_schema = OFF; PRAGMA busy_timeout = 5000');
      checkSqliteIntegrity(sourceDb);
      sourceDb.prepare('VACUUM INTO ?').run(partial);
    } finally { sourceDb.close(); }
    const handle = await open(partial, 'r+');
    try { await handle.sync(); } finally { await handle.close(); }
    const backupDb = new DatabaseSync(partial, { readOnly: true });
    try {
      backupDb.exec('PRAGMA trusted_schema = OFF');
      checkSqliteIntegrity(backupDb);
    } finally { backupDb.close(); }
    const sizeBytes = (await stat(partial)).size;
    const digest = await fileSha256(partial);
    await rename(partial, file);
    return { file, sizeBytes, digest };
  } catch (error) {
    await unlink(partial).catch(() => {});
    throw error;
  }
};
