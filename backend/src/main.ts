import { resolve } from 'node:path';
import { renameSync, writeFileSync } from 'node:fs';
import { readFile, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

import { startLocalServer } from './server.ts';

const root = resolve(import.meta.dirname, '../..');
const dataDirectory = resolve(process.env.GLORYCOURSE_DATA_DIR ?? resolve(root, '.data'));
const instanceId = randomUUID();
const version = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')).version ?? 'development';
const stateFile = resolve(dataDirectory, 'runtime.json');
const temporary = `${stateFile}.${instanceId}.tmp`;
const retryWait = new Int32Array(new SharedArrayBuffer(4));
const writeState = (state: Record<string, unknown>): void => {
  writeFileSync(temporary, JSON.stringify({ instanceId, version, pid: process.pid, ...state }), { mode: 0o600 });
  // Windows may briefly lock runtime.json while another launcher reads it; retry for up to 500 ms.
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(temporary, stateFile);
      return;
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? error.code : undefined;
      if (attempt === 49 || !['EACCES', 'EBUSY', 'EPERM'].includes(String(code))) throw error;
      Atomics.wait(retryWait, 0, 0, 10);
    }
  }
};
let runtime: Awaited<ReturnType<typeof startLocalServer>>;
try {
  runtime = await startLocalServer({
  dataDirectory,
  staticDirectory: resolve(root, 'frontend'),
  port: process.env.PORT ? Number(process.env.PORT) : 4173,
  instanceId,
  version,
  onProgress: (message) => writeState({ state: 'migrating', message }),
  onClose: async () => {
    try {
      if (JSON.parse(await readFile(stateFile, 'utf8')).instanceId === instanceId) await unlink(stateFile);
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
  },
  });
} catch (error) {
  try {
    if (JSON.parse(await readFile(stateFile, 'utf8')).instanceId === instanceId) {
      writeState({ state: 'failed', message: error instanceof Error ? error.message : '시작 실패' });
    }
  }
  catch { /* Keep the original startup error. */ }
  throw error;
}
try {
  writeState({ state: 'ready', origin: runtime.origin });
} catch (error) {
  await unlink(temporary).catch(() => {});
  await runtime.close();
  throw error;
}

console.log(`Glorycourse: ${runtime.origin}`);
console.log(`Data: ${dataDirectory}`);

const close = async (): Promise<void> => {
  await runtime.close();
  process.exitCode = 0;
};
process.once('SIGINT', () => { void close(); });
process.once('SIGTERM', () => { void close(); });
