import { readFileSync } from 'node:fs';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import formatsPlugin from 'ajv-formats';
import { StoreValidationError } from '../domain/errors.ts';
import type { DatabaseState } from '../domain/records.ts';

const schema = JSON.parse(readFileSync(new URL('../../../schema/store-schema.json', import.meta.url), 'utf8'));
const ajv = new Ajv2020({ allErrors: true });
(formatsPlugin as unknown as (instance: Ajv2020) => Ajv2020)(ajv);
const validators = new Map<string, ValidateFunction>();

export const validateRecord = (collection: Exclude<keyof DatabaseState, 'meta'>, value: unknown): void => {
  let validate = validators.get(collection);
  if (!validate) {
    validate = ajv.compile({ $defs: schema.$defs, ...schema.properties[collection].items });
    validators.set(collection, validate);
  }
  if (!validate(value)) throw new StoreValidationError(structuredClone(validate.errors ?? []));
};
