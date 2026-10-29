import { open, readFile, stat, unlink, writeFile, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export class InstanceAlreadyRunningError extends Error {
  constructor() {
    super('Another Glorycourse process is using this data directory');
    this.name = 'InstanceAlreadyRunningError';
  }
}

export type InstanceLock = {
  release(): Promise<void>;
};

export const acquireInstanceLock = async (directory: string): Promise<InstanceLock> => {
  const file = join(directory, '.glorycourse.lock');
  const token = randomUUID();
  const metadata = JSON.stringify({ pid: process.pid, token });
  // Keep this sidecar in place so every contender locks the same file.
  const guard = new DatabaseSync(join(directory, '.glorycourse.instance.sqlite'));
  try {
    guard.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');
  } catch (error) {
    guard.close();
    if (isSqliteBusy(error)) throw new InstanceAlreadyRunningError();
    throw error;
  }
  let handle: FileHandle | undefined;

  try {
    try {
      handle = await open(file, 'wx');
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      if (await lockOwnerIsAlive(file)) throw new InstanceAlreadyRunningError();
      try { await unlink(file); }
      catch (error) { if (!isMissing(error)) throw error; }
      try { handle = await open(file, 'wx'); }
      catch (error) {
        if (isAlreadyExists(error)) throw new InstanceAlreadyRunningError();
        throw error;
      }
    }

    await writeFile(handle, metadata, 'utf8');
    await handle.close();
  } catch (error) {
    try {
      if (handle) {
        const created = await handle.stat({ bigint: true });
        await handle.close();
        const current = await stat(file, { bigint: true });
        // Windows reports different device IDs for handles and paths.
        const sameDevice = process.platform === 'win32' || created.dev === current.dev;
        if (created.ino === current.ino && sameDevice && metadata.startsWith(await readFile(file, 'utf8'))) await unlink(file);
      }
    } catch { /* Preserve the acquisition failure if metadata cleanup also fails. */ }
    finally {
      try { await handle?.close(); }
      finally { guard.close(); }
    }
    throw error;
  }
  let released = false;

  return {
    async release() {
      if (released) return;
      released = true;
      try {
        const owner = JSON.parse(await readFile(file, 'utf8')) as { token?: string };
        if (owner.token === token) await unlink(file);
      } catch (error) {
        if (!isMissing(error)) throw error;
      } finally {
        try { guard.exec('ROLLBACK'); }
        finally { guard.close(); }
      }
    },
  };
};

const lockOwnerIsAlive = async (file: string): Promise<boolean> => {
  let contents: string;
  try { contents = await readFile(file, 'utf8'); }
  catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
  try {
    const owner = JSON.parse(contents) as { pid?: unknown; token?: unknown } | null;
    if (!owner || !Number.isSafeInteger(owner.pid) || (owner.pid as number) <= 0
      || typeof owner.token !== 'string' || owner.token.trim() === '') return true;
    process.kill(owner.pid as number, 0);
    return true;
  } catch (error) {
    if (isNoSuchProcess(error)) return false;
    return true;
  }
};

const isSqliteBusy = (error: unknown): boolean => (
  error instanceof Error && 'errcode' in error && typeof error.errcode === 'number'
  && [5, 6].includes(error.errcode & 0xff)
);

const isAlreadyExists = (error: unknown): boolean => (
  error instanceof Error && 'code' in error && error.code === 'EEXIST'
);

const isMissing = (error: unknown): boolean => (
  error instanceof Error && 'code' in error && error.code === 'ENOENT'
);

const isNoSuchProcess = (error: unknown): boolean => (
  error instanceof Error && 'code' in error && error.code === 'ESRCH'
);
