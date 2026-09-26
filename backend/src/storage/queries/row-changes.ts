import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';

type Value = string | number | null;
type RecordKey = { id: string } | { idempotencyKey: string };
const keyOf = (item: RecordKey): string => 'id' in item ? item.id : item.idempotencyKey;

// All identifiers come from the fixed SQL mappings in relational-store.ts.
export const prepareRow = (db: DatabaseSync, table: string, columnList: string) => {
  const columns = columnList.split(',').map((column) => column.trim());
  const key = columns[0];
  const insert = db.prepare(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`);
  const read = db.prepare(`SELECT ${columns.join(',')} FROM ${table} WHERE ${key} = ?`);
  const update = db.prepare(`UPDATE ${table} SET ${columns.slice(1).map((column) => `${column} = ?`).join(',')} WHERE ${key} = ?`);
  const written = new Set<Value>();
  return { run: (...values: Value[]): void => {
    if (written.has(values[0])) throw new Error(`Duplicate ${table} key`);
    written.add(values[0]);
    const stored = read.get(values[0]);
    if (!stored) { insert.run(...values); return; }
    if (columns.some((column, index) => stored[column] !== values[index])) {
      update.run(...values.slice(1), values[0]);
    }
  } };
};

export const changedRecords = <T extends RecordKey>(
  items: T[], previous: T[] = [], resetChildren: (item: T) => boolean = () => false,
): { item: T; position: number; before?: T }[] => {
  const old = new Map(previous.map((item, position) => [keyOf(item), { item, position }]));
  return items.flatMap((item, position) => {
    const stored = old.get(keyOf(item));
    const reset = stored !== undefined && resetChildren(stored.item);
    if (!reset && stored?.position === position && isDeepStrictEqual(item, stored.item)) return [];
    return [{ item, position, before: reset ? undefined : stored?.item }];
  });
};

export const prepareChanges = <T extends RecordKey>(
  db: DatabaseSync, table: string, items: T[], previous: T[],
  uniqueFields: [string, (item: T) => string][] = [],
): void => {
  if (previous.length === 0) return;
  const keyColumn = 'idempotencyKey' in previous[0] ? 'idempotency_key' : 'id';
  const current = new Map(items.map((item, position) => [keyOf(item), { item, position }]));
  if (current.size !== items.length) throw new Error(`Duplicate ${table} key`);
  const remove = db.prepare(`DELETE FROM ${table} WHERE ${keyColumn} = ?`);
  const move = db.prepare(`UPDATE ${table} SET position = ? WHERE ${keyColumn} = ?`);
  const maximum = Number(db.prepare(`SELECT MAX(position) AS maximum FROM ${table}`).get()?.maximum ?? -1);
  // Older migrations can leave gaps; array indices then differ from persisted positions.
  const positions = maximum === previous.length - 1 ? undefined : new Map(
    db.prepare(`SELECT ${keyColumn} AS key, position FROM ${table}`).all()
      .map((row) => [String(row.key), Number(row.position)]),
  );
  const moved: { key: string; position: number }[] = [];
  const uniqueUpdates = uniqueFields.map(([column]) => db.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${keyColumn} = ?`));
  const desiredValues = uniqueFields.map(([, value]) => new Map(items.map((item) => [value(item), keyOf(item)])));
  // Vacate only changing unique values; positive positions satisfy the schema CHECK.
  // FK key swaps are deferred until the surrounding transaction commits.
  const temporaryPrefix = `pending-${randomUUID()}-`;
  previous.forEach((item, position) => {
    const next = current.get(keyOf(item));
    if (!next) { remove.run(keyOf(item)); return; }
    if (next.position !== (positions?.get(keyOf(item)) ?? position)) {
      move.run(Math.max(items.length, maximum + 1) + position, keyOf(item));
      moved.push({ key: keyOf(item), position: next.position });
    }
    uniqueFields.forEach(([, value], index) => {
      const destination = desiredValues[index].get(value(item));
      if (value(item) !== value(next.item) && destination !== undefined && destination !== keyOf(item)) {
        uniqueUpdates[index].run(`${temporaryPrefix}${index}-${position}`, keyOf(item));
      }
    });
  });
  for (const item of moved) move.run(item.position, item.key);
};

export const replaceChildren = (
  db: DatabaseSync, table: string, parentColumn: string, parentId: string, before: unknown, after: unknown,
): boolean => {
  if (isDeepStrictEqual(before, after)) return false;
  if (before !== undefined) db.prepare(`DELETE FROM ${table} WHERE ${parentColumn} = ?`).run(parentId);
  return true;
};
