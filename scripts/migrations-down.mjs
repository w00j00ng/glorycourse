import { realpath } from 'node:fs/promises';
import { dirname } from 'node:path';
import { acquireInstanceLock } from '../backend/src/storage/instance-lock.ts';
import { migrateDatabase } from '../backend/src/bootstrap/database.ts';

const [file, version, ...extra] = process.argv.slice(2);
if (!file || !/^(0|[1-9]\d{9})$/.test(version ?? '') || extra.length) {
  throw new Error('Usage: npm run migrations:down -- <db.sqlite> <target Unix version or 0>');
}
const database = await realpath(file);
const lock = await acquireInstanceLock(dirname(database));
try {
  const result = await migrateDatabase(database, undefined, { targetVersion: Number(version), onProgress: console.log });
  console.log(JSON.stringify(result, null, 2));
} finally { await lock.release(); }
