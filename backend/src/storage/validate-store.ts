import { readFile } from 'node:fs/promises';

import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import formatsPlugin from 'ajv-formats';

import type { DatabaseState } from '../domain/records.ts';
import { StoreValidationError } from '../domain/errors.ts';

const schema = JSON.parse(await readFile(new URL('../../../schema/store-schema.json', import.meta.url), 'utf8')) as {
  $defs: Record<string, object>;
  properties: Record<string, { $ref?: string; items?: object }>;
};
const ajv = new Ajv2020({ allErrors: true });
(formatsPlugin as unknown as (instance: Ajv2020) => Ajv2020)(ajv);
const validate = ajv.compile(schema) as ValidateFunction<DatabaseState>;
export const assertValidStore: (data: unknown) => asserts data is DatabaseState = (data) => {
  if (validate(data)) return;
  throw new StoreValidationError(structuredClone(validate.errors ?? []));
};
