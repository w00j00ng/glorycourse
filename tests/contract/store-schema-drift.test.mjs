import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const schema = JSON.parse(await readFile(new URL('../../schema/store-schema.json', import.meta.url), 'utf8'));

test('checks handwritten store schema against actual TypeScript fields, nullability, enums and nested arrays', async () => {
  const { checkStoreSchema } = await import('../../scripts/store-schema-check.mjs');
  const cases = [
    { change: () => {}, valid: true },
    { change: (value) => { delete value.$defs.application.properties.ministry; }, valid: false },
    { change: (value) => { value.$defs.enrollment.properties.ministry.type = 'string'; }, valid: false },
    { change: (value) => { value.$defs.snapshotApplication.properties.memberName.type = 'number'; }, valid: false },
    { change: (value) => { value.$defs.application.properties.applicationOrderStatus.enum.pop(); }, valid: false },
    { change: (value) => { value.$defs.application.properties.applicationOrderStatus.type = 'number'; }, valid: false },
    { change: (value) => { value.$defs.policySettings.properties.fallbackMode.type = 'number'; }, valid: false },
    { change: (value) => { value.$defs.application.required = value.$defs.application.required.filter((key) => key !== 'memberId'); }, valid: false },
    { change: (value) => { value.$defs.inputSnapshot.properties.existingEnrollments = { type: 'array', items: { type: 'string' } }; }, valid: false },
    { change: (value) => { value.$defs.timestamps.properties.createdAt = { type: 'number' }; }, valid: false },
  ];
  for (const input of cases) {
    const candidate = structuredClone(schema);
    input.change(candidate);
    if (input.valid) assert.doesNotThrow(() => checkStoreSchema(candidate));
    else assert.throws(() => checkStoreSchema(candidate), /Store schema structure differs/);
  }
});

test('rejects structural keyword combinations instead of ignoring constraints beside refs, unions and objects', async () => {
  const { checkStoreSchema } = await import('../../scripts/store-schema-check.mjs');
  const cases = [
    { name: 'reference annotation', change: (value) => { value.$defs.allocationDraft.properties.enrollmentReportDownloadedAt.description = 'Export timestamp'; }, valid: true },
    { name: 'union annotation', change: (value) => { value.$defs.nullableTimestamp.description = 'Optional timestamp'; }, valid: true },
    { name: 'reference with type', change: (value) => { value.$defs.allocationDraft.properties.enrollmentReportDownloadedAt.type = 'string'; }, valid: false },
    { name: 'union with type', change: (value) => { value.$defs.nullableTimestamp.type = 'string'; }, valid: false },
    { name: 'object with structural allOf', change: (value) => { value.$defs.application.allOf.push({ properties: { ministry: { type: 'number' } } }); }, valid: false },
    { name: 'inheritance with sibling properties', change: (value) => { value.$defs.semester.properties = { name: { type: 'number' } }; }, valid: false },
    { name: 'unsupported anyOf', change: (value) => { value.$defs.enrollment.properties.ministry.anyOf = [{ type: 'number' }]; }, valid: false },
    { name: 'unsupported not', change: (value) => { value.$defs.enrollment.properties.ministry.not = { type: 'string' }; }, valid: false },
    { name: 'required field without a declaration', change: (value) => { value.required.push('missingField'); }, valid: false },
    { name: 'duplicate union branch', change: (value) => { value.$defs.nullableTimestamp.oneOf.push(structuredClone(value.$defs.nullableTimestamp.oneOf[0])); }, valid: false },
    { name: 'enum with a narrower const', change: (value) => { value.$defs.application.properties.applicationOrderStatus.const = 'NORMAL'; }, valid: false },
    { name: 'disjoint enum union', change: (value) => { value.$defs.application.properties.applicationOrderStatus = { oneOf: [{ enum: ['NORMAL', 'CONFLICT'] }, { enum: ['MISSING', 'INVALID'] }] }; }, valid: true },
    { name: 'partially overlapping enum union', change: (value) => { value.$defs.application.properties.applicationOrderStatus = { oneOf: [{ enum: ['NORMAL', 'CONFLICT'] }, { enum: ['CONFLICT', 'MISSING', 'INVALID'] }] }; }, valid: false },
    { name: 'hybrid array with a conflicting prefix', change: (value) => { value.properties.applications.prefixItems = [{ type: 'number' }]; }, valid: false },
  ];
  for (const input of cases) {
    const candidate = structuredClone(schema);
    input.change(candidate);
    if (input.valid) assert.doesNotThrow(() => checkStoreSchema(candidate), input.name);
    else assert.throws(() => checkStoreSchema(candidate), /Store schema structure differs/, input.name);
  }
});
