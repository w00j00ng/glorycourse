import { open, readFile, unlink, writeFile, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

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
  let handle: FileHandle;

  try {
    handle = await open(file, 'wx');
  } catch (error) {
    if (!isAlreadyExists(error) || await lockOwnerIsAlive(file)) {
      throw new InstanceAlreadyRunningError();
    }
    await unlink(file);
    try {
      handle = await open(file, 'wx');
    } catch {
      throw new InstanceAlreadyRunningError();
    }
  }

  await writeFile(handle, JSON.stringify({ pid: process.pid, token }), 'utf8');
  await handle.close();
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
      }
    },
  };
};

const lockOwnerIsAlive = async (file: string): Promise<boolean> => {
  try {
    const owner = JSON.parse(await readFile(file, 'utf8')) as { pid?: unknown };
    if (!Number.isSafeInteger(owner.pid) || (owner.pid as number) <= 0) return true;
    process.kill(owner.pid as number, 0);
    return true;
  } catch (error) {
    if (isNoSuchProcess(error)) return false;
    return true;
  }
};

const isAlreadyExists = (error: unknown): boolean => (
  error instanceof Error && 'code' in error && error.code === 'EEXIST'
);

const isMissing = (error: unknown): boolean => (
  error instanceof Error && 'code' in error && error.code === 'ENOENT'
);

const isNoSuchProcess = (error: unknown): boolean => (
  error instanceof Error && 'code' in error && error.code === 'ESRCH'
);
