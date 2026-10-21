import type { DatabaseState } from '../domain/records.ts';
import { Repository } from '../repository/database.ts';
import { readRelationalStore, writeRelationalStore } from '../repository/relational-store.ts';
import { migrateDatabase as migrateStorage } from '../storage/migrations.ts';
import { assertValidStore } from '../storage/validate-store.ts';

type MigrationOptions = Omit<Parameters<typeof migrateStorage>[2], 'snapshot'>;

export const migrateDatabase = (
  file: string,
  initial?: DatabaseState,
  options: MigrationOptions = {},
): ReturnType<typeof migrateStorage> => migrateStorage(file, initial, {
  ...options,
  snapshot: { read: readRelationalStore, write: writeRelationalStore },
});

export const openRepository = async (
  file: string,
  defaultData: DatabaseState,
  options: MigrationOptions = {},
): Promise<Repository> => {
  await migrateDatabase(file, defaultData, options);
  const repository = new Repository(file);
  assertValidStore(repository.snapshot());
  return repository;
};
