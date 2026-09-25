import assert from 'node:assert/strict';
import test from 'node:test';

import { PAGE_HELP, PROGRESS_WORKFLOW, WORKFLOW } from '../../frontend/help-content.js';

test('uses the page help summaries for the dashboard workflow', () => {
  assert.deepEqual(WORKFLOW.map(({ key }) => key), [
    'catalog', 'applications', 'drafts', 'enrollments', 'backups',
  ]);
  for (const step of WORKFLOW) assert.equal(step.description, PAGE_HELP[step.key].summary);
});

test('keeps optional backup guidance outside the required semester progress', () => {
  assert.deepEqual(PROGRESS_WORKFLOW.map(({ key }) => key), [
    'catalog', 'applications', 'drafts', 'enrollments',
  ]);
});
