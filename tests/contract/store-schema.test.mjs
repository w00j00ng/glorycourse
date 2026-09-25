import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));
const schema = await readJson(new URL('../../schema/store-schema.json', import.meta.url));
const ajv = new Ajv2020({ allErrors: true });
addFormats(ajv);
const validate = ajv.compile(schema);

test('accepts a valid empty store', async () => {
  const input = await readJson(new URL('../fixtures/store/store-valid-empty.json', import.meta.url));

  assert.equal(validate(input), true, JSON.stringify(validate.errors));
});

for (const [name, fixture, expectedKeyword] of [
  ['NORMAL application without a positive order', 'store-invalid-normal-order.json', 'if'],
  ['selected draft item without a course', 'store-invalid-selected-item.json', 'if'],
  ['negative course capacity', 'store-invalid-negative-capacity.json', 'minimum'],
  ['unsafe integer revision', 'store-invalid-unsafe-integer.json', 'maximum'],
]) {
  test(`rejects ${name}`, async () => {
    const input = await readJson(new URL(`../fixtures/store/${fixture}`, import.meta.url));

    assert.equal(validate(input), false);
    assert.ok(validate.errors.some(({ keyword }) => keyword === expectedKeyword), JSON.stringify(validate.errors));
  });
}
