import assert from 'node:assert/strict';
import test from 'node:test';

import { PAGE_HELP, WORKFLOW } from '../../frontend/help-content.js';

test('uses the page help summaries for the dashboard workflow', () => {
  assert.deepEqual(WORKFLOW.map(({ key }) => key), [
    'catalog', 'applications', 'drafts', 'enrollments',
  ]);
  for (const step of WORKFLOW) assert.equal(step.description, PAGE_HELP[step.key].summary);
});
