import assert from 'node:assert/strict';
import test from 'node:test';

import { PAGE_HELP, WORKFLOW } from '../../frontend/help-content.js';

test('uses the page help summaries for the dashboard workflow', () => {
  assert.deepEqual(WORKFLOW.map(({ key }) => key), [
    'catalog', 'applications', 'drafts', 'enrollments',
  ]);
  for (const step of WORKFLOW) assert.equal(step.description, PAGE_HELP[step.key].summary);
});

test('application help describes the four default ranks and optional per-record student affiliation', () => {
  const applicationHelp = PAGE_HELP.applications.steps.join(' ');
  assert.match(applicationHelp, /1~4순위/);
  assert.match(applicationHelp, /5순위 강좌/);
  for (const key of ['applications', 'drafts', 'enrollments']) {
    assert.match(PAGE_HELP[key].steps.join(' '), /학생 소속/);
  }
});
