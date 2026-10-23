import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';

import { openRepository } from '../../backend/src/bootstrap/database.ts';

export const createTestRepository = async (initial) => {
  const directory = await mkdtemp(join(tmpdir(), 'glorycourse-repository-'));
  const repository = await openRepository(join(directory, 'db.sqlite'), initial);
  after(async () => {
    repository.close();
    await rm(directory, { recursive: true, force: true });
  });
  return repository;
};

export const seedRepository = async (repository, mutate) => {
  const candidate = repository.snapshot();
  const { storeRevision, storeEpoch } = candidate.meta;
  await mutate(candidate);
  candidate.meta.storeRevision = storeRevision + 1;
  await repository.restore(candidate, {
    expectedRevision: storeRevision,
    expectedEpoch: storeEpoch,
    backup: async () => {},
  });
};
