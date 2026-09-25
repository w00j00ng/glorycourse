import { readFile } from 'node:fs/promises';

import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import formatsPlugin from 'ajv-formats';

import type { DatabaseState } from './store.ts';

export class StoreValidationError extends Error {
  readonly issues: ErrorObject[];

  constructor(issues: ErrorObject[]) {
    super('Candidate store violates the storage contract');
    this.name = 'StoreValidationError';
    this.issues = issues;
  }
}

const schema = JSON.parse(await readFile(new URL('../../../schema/store-schema.json', import.meta.url), 'utf8')) as object;
const ajv = new Ajv2020({ allErrors: true });
(formatsPlugin as unknown as (instance: Ajv2020) => Ajv2020)(ajv);
const validate = ajv.compile(schema) as ValidateFunction<DatabaseState>;

export const assertValidStore: (data: unknown) => asserts data is DatabaseState = (data) => {
  if (validate(data)) return;
  throw new StoreValidationError(structuredClone(validate.errors ?? []));
};
