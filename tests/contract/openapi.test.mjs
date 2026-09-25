import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import YAML from 'yaml';

const api = YAML.parse(await readFile(new URL('../../openapi/openapi.yaml', import.meta.url), 'utf8'));

const requiredOperations = {
  '/shutdown': ['post'],
  '/data-folder': ['post'],
  '/session': ['post'],
  '/semesters': ['get', 'post'],
  '/semesters/{id}': ['delete'],
  '/members': ['get'],
  '/courses': ['get'],
  '/semesters/{id}/context': ['get', 'patch'],
  '/semesters/{semesterId}/courses/{semesterCourseId}': ['delete'],
  '/applications': ['get', 'post'],
  '/applications/batch': ['post'],
  '/applications/{id}': ['get', 'patch', 'delete'],
  '/enrollments': ['get', 'post'],
  '/enrollments/batch': ['post'],
  '/enrollments/batch/preview': ['post'],
  '/enrollments/{id}': ['get', 'patch', 'delete'],
  '/enrollments/preview': ['post'],
  '/applications/template': ['get'],
  '/applications/export': ['get'],
  '/enrollments/template': ['get'],
  '/enrollments/export': ['get'],
  '/imports/preview': ['post'],
  '/imports/{previewId}/stage': ['post'],
  '/imports/{previewId}/commit': ['post'],
  '/import-batches/{id}': ['get'],
  '/import-batches/{id}/preview': ['post'],
  '/allocation-policies': ['get'],
  '/allocation-drafts': ['get', 'post'],
  '/allocation-drafts/{id}': ['get', 'delete'],
  '/allocation-drafts/{id}/items': ['post'],
  '/allocation-drafts/{id}/items/{memberId}': ['patch'],
  '/allocation-drafts/{id}/finalize-preview': ['post'],
  '/allocation-drafts/{id}/finalize': ['post'],
  '/semesters/{id}/enrollment-report': ['get', 'post'],
  '/backups': ['get', 'post'],
  '/restores/preview': ['post'],
  '/restores': ['post'],
};

test('defines every designed operation with a unique operationId', () => {
  const operationIds = [];

  for (const [path, methods] of Object.entries(requiredOperations)) {
    assert.ok(api.paths[path], `missing path ${path}`);
    for (const method of methods) {
      const operation = api.paths[path][method];
      assert.ok(operation, `missing ${method.toUpperCase()} ${path}`);
      assert.match(operation.operationId, /^[a-z][A-Za-z0-9]+$/);
      operationIds.push(operation.operationId);
    }
  }

  assert.equal(new Set(operationIds).size, operationIds.length);
});

test('requires a semester when downloading the application template', () => {
  const parameters = api.paths['/applications/template'].get.parameters;
  assert.ok(parameters.some((parameter) => (
    parameter.name === 'semesterId' && parameter.in === 'query' && parameter.required === true
  )));
});

test('validates representative name input and ID response separately', () => {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const rootId = 'https://glorycourse.local/openapi.json';
  ajv.addSchema({ ...api, $id: rootId }, rootId);
  const validateRequest = ajv.getSchema(`${rootId}#/components/schemas/CreateApplicationRequest`);
  const validateResponse = ajv.getSchema(`${rootId}#/components/schemas/Application`);
  const request = {
    semesterName: ' 2027년 1학기 ',
    memberName: '홍길동',
    applicationOrder: 15,
    choices: [{ courseName: '연기', preference: 1 }],
  };

  assert.equal(validateRequest(request), true, JSON.stringify(validateRequest.errors));
  assert.equal(validateResponse(request), false, 'ID response must not accept a name-input DTO');
  assert.equal(validateRequest({ ...request, applicationOrder: 0 }), false);
});

test('requires idempotency keys on irreversible commits', () => {
  for (const [path, method] of [
    ['/imports/{previewId}/commit', 'post'],
    ['/allocation-drafts/{id}/finalize', 'post'],
    ['/restores', 'post'],
  ]) {
    const parameters = api.paths[path][method].parameters ?? [];
    const header = parameters.find(({ name, in: location }) => name === 'Idempotency-Key' && location === 'header');
    assert.equal(header?.required, true, `${method.toUpperCase()} ${path}`);
  }
});

test('publishes enforceable initial safety limits', () => {
  const limits = api['x-operational-limits'];
  assert.deepEqual(limits, {
    uploadBytes: 20 * 1024 * 1024,
    expandedWorkbookBytes: 100 * 1024 * 1024,
    workbookSheets: 20,
    workbookRows: 100_000,
    workbookCells: 1_000_000,
    storeBytes: 200 * 1024 * 1024,
    allocationApplicants: 10_000,
    semesterCourses: 1_000,
    choicesPerApplication: 100,
  });

  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const rootId = 'https://glorycourse.local/limits-openapi.json';
  ajv.addSchema({ ...api, $id: rootId }, rootId);
  const validate = ajv.getSchema(`${rootId}#/components/schemas/CreateApplicationRequest`);
  const tooManyChoices = Array.from({ length: limits.choicesPerApplication + 1 }, (_, index) => ({
    courseName: `강좌 ${index + 1}`,
    preference: index + 1,
  }));

  assert.equal(validate({
    semesterName: '2027년 1학기',
    memberName: '홍길동',
    applicationOrder: 1,
    choices: tooManyChoices,
  }), false);
});
