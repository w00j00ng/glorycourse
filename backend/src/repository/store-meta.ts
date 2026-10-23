import type { DatabaseSync } from 'node:sqlite';
import type { DatabaseState } from '../domain/records.ts';

export class StoreMetaQueries {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) { this.db = db; }

  get(): DatabaseState['meta'] {
    const row = this.db.prepare(`SELECT store_epoch AS storeEpoch, store_revision AS storeRevision
      FROM store_meta WHERE id = 1`).get();
    if (!row) throw new Error('SQLite store metadata is missing');
    return { storeEpoch: String(row.storeEpoch), storeRevision: Number(row.storeRevision) };
  }

  updateRevision({ revision }: { revision: number }): void {
    this.db.prepare('UPDATE store_meta SET store_revision = ? WHERE id = 1').run(revision);
  }
}

export const readSnapshotRow = (db: DatabaseSync): { storeEpoch: string; storeRevision: number } | undefined => {
  const row = db.prepare('SELECT store_epoch AS storeEpoch, store_revision AS storeRevision FROM store_meta WHERE id = 1').get();
  return row ? { ...row } as { storeEpoch: string; storeRevision: number } : undefined;
};

export const prepareSnapshotPresence = (db: DatabaseSync) => db.prepare('SELECT 1 FROM store_meta WHERE id = 1');

export const prepareSnapshotWrite = (db: DatabaseSync) => {
  const insert = db.prepare(`INSERT INTO store_meta (id, store_epoch, store_revision)
      VALUES (?, ?, ?)`);
  const read = db.prepare(`SELECT id, store_epoch, store_revision
      FROM store_meta WHERE id = ?`);
  const update = db.prepare(`UPDATE store_meta SET store_epoch = ?, store_revision = ?
      WHERE id = ?`);
  const written = new Set<string | number | null>();
  return { run: (...values: (string | number | null)[]): void => {
    if (written.has(values[0])) throw new Error('Duplicate store_meta key');
    written.add(values[0]);
    const stored = read.get(values[0]);
    if (!stored) { insert.run(...values); return; }
    if (Object.values(stored).some((value, index) => value !== values[index])) update.run(...values.slice(1), values[0]);
  } };
};
