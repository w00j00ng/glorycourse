import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { acquireInstanceLock } from '../../backend/src/storage/instance-lock.ts';

const [directory, mode] = process.argv.slice(2);
let lock;
try {
  if (mode === 'sqlite') {
    const db = new DatabaseSync(join(directory, '.glorycourse.instance.sqlite'));
    try { db.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE'); }
    catch (error) { db.close(); throw error; }
    lock = { release: async () => { db.exec('ROLLBACK'); db.close(); } };
  } else {
    lock = await acquireInstanceLock(directory);
  }
  process.send({ status: 'acquired', pid: process.pid, nodeVersion: process.version });
  process.once('message', async () => {
    await lock.release();
    process.disconnect();
  });
} catch (error) {
  process.send({ status: 'rejected', name: error.name, code: error.code, errcode: error.errcode });
  process.disconnect();
}
