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

const schema = JSON.parse(await readFile(new URL('../../../schema/store-schema.json', import.meta.url), 'utf8')) as {
  $defs: Record<string, object>;
  properties: Record<string, { $ref?: string; items?: object }>;
};
const ajv = new Ajv2020({ allErrors: true });
(formatsPlugin as unknown as (instance: Ajv2020) => Ajv2020)(ajv);
const validate = ajv.compile(schema) as ValidateFunction<DatabaseState>;
const validateMeta = ajv.compile({ $defs: schema.$defs, ...schema.properties.meta });
const recordValidators = new Map(Object.entries(schema.properties)
  .filter(([, definition]) => definition.items)
  .map(([name, definition]) => [name, ajv.compile({ $defs: schema.$defs, ...definition.items })]));

export const assertValidStore: (data: unknown) => asserts data is DatabaseState = (data) => {
  if (validate(data)) return;
  throw new StoreValidationError(structuredClone(validate.errors ?? []));
};

export const assertValidStoreChanges = (before: DatabaseState, candidate: DatabaseState): void => {
  const keys = Object.keys(candidate);
  if (keys.length !== Object.keys(schema.properties).length || keys.some((key) => !(key in schema.properties))) {
    return assertValidStore(candidate);
  }
  const issues: ErrorObject[] = [];
  if (!validateMeta(candidate.meta)) issues.push(...(validateMeta.errors ?? []));
  for (const [name, validateRecord] of recordValidators) {
    const oldRows = before[name as keyof DatabaseState] as unknown[];
    const rows = candidate[name as keyof DatabaseState];
    if (rows === oldRows) continue;
    if (!Array.isArray(rows)) return assertValidStore(candidate);
    rows.forEach((row, index) => {
      if (row === oldRows[index] || validateRecord(row)) return;
      issues.push(...(validateRecord.errors ?? []).map((issue) => ({
        ...issue, instancePath: `/${name}/${index}${issue.instancePath}`,
      })));
    });
  }
  if (issues.length) throw new StoreValidationError(issues);
};
