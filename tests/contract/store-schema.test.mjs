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

test('requires nullable student affiliation on each cached record and snapshot', async () => {
  const input = await readJson(new URL('../fixtures/store/store-valid-affiliation.json', import.meta.url));
  assert.equal(validate(input), true, JSON.stringify(validate.errors));
  const records = (data) => [data.applications[0], data.enrollments[0], data.allocationDraftItems[0],
    data.allocationDrafts[0].inputSnapshot.applications[0], data.allocationDrafts[0].inputSnapshot.existingEnrollments[0]];
  for (let index = 0; index < records(input).length; index += 1) {
    for (const [value, expected] of [[null, true], ['x'.repeat(200), true], ['x'.repeat(201), false], [5, false]]) {
      const candidate = structuredClone(input);
      records(candidate)[index].affiliation = value;
      assert.equal(validate(candidate), expected, JSON.stringify(validate.errors));
    }
    const candidate = structuredClone(input);
    delete records(candidate)[index].affiliation;
    assert.equal(validate(candidate), false);
    assert.ok(validate.errors.some(({ keyword, params }) => keyword === 'required' && params.missingProperty === 'affiliation'));
  }
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
