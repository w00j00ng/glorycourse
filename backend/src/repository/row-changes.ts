import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

type RecordKey = { id: string } | { idempotencyKey: string };
const keyOf = (item: RecordKey): string => 'id' in item ? item.id : item.idempotencyKey;

export const changedRecords = <T extends RecordKey>(
  items: T[], previous: T[] = [], resetChildren: (item: T) => boolean = () => false,
): { item: T; position: number; before?: T }[] => {
  if (items === previous) return [];
  const old = new Map(previous.map((item, position) => [keyOf(item), { item, position }]));
  return items.flatMap((item, position) => {
    const stored = old.get(keyOf(item));
    const reset = stored !== undefined && resetChildren(stored.item);
    if (!reset && stored?.position === position && (item === stored.item || isDeepStrictEqual(item, stored.item))) return [];
    return [{ item, position, before: reset ? undefined : stored?.item }];
  });
};

type RowChange =
  | { type: 'remove'; key: string }
  | { type: 'move'; key: string; position: number }
  | { type: 'unique'; key: string; index: number; value: string };

export const planRowChanges = <T extends RecordKey>(
  items: T[], previous: T[], maximum: number, positions: ReadonlyMap<string, number> | undefined,
  uniqueValues: ((item: T) => string)[], duplicateMessage: string,
): RowChange[] => {
  const current = new Map(items.map((item, position) => [keyOf(item), { item, position }]));
  if (current.size !== items.length) throw new Error(duplicateMessage);
  const changes: RowChange[] = [];
  const moved: { key: string; position: number }[] = [];
  const desiredValues = uniqueValues.map(value => new Map(items.map(item => [value(item), keyOf(item)])));
  const temporaryPrefix = `pending-${randomUUID()}-`;
  // Preserve operation order while vacating changing unique values and positive positions.
  previous.forEach((item, position) => {
    const key = keyOf(item);
    const next = current.get(key);
    if (!next) { changes.push({ type: 'remove', key }); return; }
    if (next.position !== (positions?.get(key) ?? position)) {
      changes.push({ type: 'move', key, position: Math.max(items.length, maximum + 1) + position });
      moved.push({ key, position: next.position });
    }
    uniqueValues.forEach((value, index) => {
      const destination = desiredValues[index].get(value(item));
      if (value(item) !== value(next.item) && destination !== undefined && destination !== key) {
        changes.push({ type: 'unique', key, index, value: `${temporaryPrefix}${index}-${position}` });
      }
    });
  });
  for (const item of moved) changes.push({ type: 'move', ...item });
  return changes;
};
