import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const measures = (covered, total) => Object.fromEntries(['lines', 'branches', 'functions', 'statements']
  .map((key) => [key, { total, covered, pct: Math.floor(10000 * covered / total) / 100 }]));

test('creates branch-local README badges and a summary alongside Pages without changing README', () => {
  const script = fileURLToPath(new URL('../../scripts/coverage-report.mjs', import.meta.url));
  const total = measures(6, 16);
  const cases = [
    { total, status: 0 },
    { total: { ...total, lines: { ...total.lines, pct: 'Unknown' } }, status: 1 },
    { total: {}, status: 1 },
    { total, omitFrontend: true, status: 1 },
  ];
  for (const input of cases) {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'glorycourse-coverage-')));
    try {
      mkdirSync(join(directory, 'coverage'));
      const report = {
        total: input.total,
        [join(directory, 'backend/src/main.ts')]: measures(3, 8),
        ...(!input.omitFrontend ? { [join(directory, 'frontend/app.js')]: measures(3, 8) } : {}),
      };
      writeFileSync(join(directory, 'coverage/coverage-summary.json'), JSON.stringify(report));
      writeFileSync(join(directory, 'README.md'), '사용자 문서는 변경하지 않는다.\n');
      const result = spawnSync(process.execPath, [script], { cwd: directory, encoding: 'utf8' });
      assert.equal(result.status, input.status, result.error?.message ?? result.stderr);
      assert.equal(readFileSync(join(directory, 'README.md'), 'utf8'), '사용자 문서는 변경하지 않는다.\n');
      if (input.status === 0) {
        const summary = readFileSync(join(directory, 'coverage/SUMMARY.md'), 'utf8');
        const backendBadge = readFileSync(join(directory, 'coverage/pages/coverage/backend.svg'), 'utf8');
        const frontendBadge = readFileSync(join(directory, 'coverage/pages/coverage/frontend.svg'), 'utf8');
        const rootPage = readFileSync(join(directory, 'coverage/pages/index.html'), 'utf8');
        const page = readFileSync(join(directory, 'coverage/pages/coverage/index.html'), 'utf8');
        assert.equal(readFileSync(join(directory, 'docs/coverage-report/backend.svg'), 'utf8'), backendBadge);
        assert.equal(readFileSync(join(directory, 'docs/coverage-report/frontend.svg'), 'utf8'), frontendBadge);
        const readmeSummary = readFileSync(join(directory, 'docs/coverage-report/README.md'), 'utf8');
        assert.match(readmeSummary, /npm run test:coverage/);
        assert.match(readmeSummary, /\| Backend \| 37\.50% \|/);
        assert.match(readmeSummary, /\| Frontend \| 37\.50% \|/);
        assert.match(summary, /\| Backend \| 37\.50% \|/);
        assert.match(summary, /\| Frontend \| 37\.50% \|/);
        assert.match(backendBadge, /Backend coverage: 37\.50%/);
        assert.match(frontendBadge, /Frontend coverage: 37\.50%/);
        assert.match(backendBadge, /#fe7d37/);
        assert.match(rootPage, /url=coverage\//);
        assert.match(page, /<td>Backend<\/td>\s*<td>37\.50%<\/td>/);
        assert.match(page, /<td>Frontend<\/td>\s*<td>37\.50%<\/td>/);
      } else {
        assert.equal(existsSync(join(directory, 'coverage/pages/coverage/index.html')), false);
        assert.equal(existsSync(join(directory, 'docs/coverage-report')), false);
      }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }
});

test('weights file coverage and warns separately below 80 percent only on PRs', () => {
  const script = fileURLToPath(new URL('../../scripts/coverage-report.mjs', import.meta.url));
  const cases = [
    { event: 'pull_request', backend: [[7999, 10000]], frontend: [1, 1], pct: '79.99', warnings: ['Backend'] },
    { event: 'pull_request', backend: [[8000, 10000]], frontend: [1, 1], pct: '80.00', warnings: [] },
    { event: 'pull_request', backend: [[8001, 10000]], frontend: [1, 1], pct: '80.01', warnings: [] },
    { event: 'push', backend: [[7999, 10000]], frontend: [1, 1], pct: '79.99', warnings: [] },
    { event: 'pull_request', backend: [[1, 1]], frontend: [7999, 10000], pct: '100.00', warnings: ['Frontend'] },
    { event: 'pull_request', backend: [[1, 1], [1, 9]], frontend: [0, 5], pct: '20.00', warnings: ['Backend', 'Frontend'] },
  ];
  for (const input of cases) {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'glorycourse-coverage-warning-')));
    try {
      mkdirSync(join(directory, 'coverage'));
      const counts = [...input.backend, input.frontend];
      const report = {
        total: measures(counts.reduce((sum, [covered]) => sum + covered, 0), counts.reduce((sum, [, total]) => sum + total, 0)),
        ...Object.fromEntries(input.backend.map(([covered, total], index) => [join(directory, `backend/src/file${index}.ts`), measures(covered, total)])),
        [join(directory, 'frontend/app.js')]: measures(...input.frontend),
      };
      writeFileSync(join(directory, 'coverage/coverage-summary.json'), JSON.stringify(report));
      const result = spawnSync(process.execPath, [script], {
        cwd: directory, encoding: 'utf8', env: { ...process.env, GITHUB_EVENT_NAME: input.event },
      });
      assert.equal(result.status, 0, result.error?.message ?? result.stderr);
      const annotations = result.stdout.split('\n').filter((line) => line.startsWith('::warning '));
      assert.equal(annotations.length, input.warnings.length);
      const summary = readFileSync(join(directory, 'coverage/SUMMARY.md'), 'utf8');
      for (const name of ['Backend', 'Frontend']) {
        assert.equal(annotations.some((line) => line.includes(`${name} 줄 커버리지`)), input.warnings.includes(name));
        assert.equal(summary.includes(`${name} 줄 커버리지`), input.warnings.includes(name));
      }
      assert.ok(summary.includes(`| Backend | ${input.pct}% |`));
      const badge = readFileSync(join(directory, 'coverage/pages/coverage/backend.svg'), 'utf8');
      assert.match(badge, new RegExp(`Backend coverage: ${input.pct}%`));
      assert.match(badge, new RegExp(Number(input.pct) >= 80 ? '#4c1' : '#fe7d37'));
      const readmeSummary = readFileSync(join(directory, 'docs/coverage-report/README.md'), 'utf8');
      assert.ok(readmeSummary.includes(`| Backend | ${input.pct}% |`));
      assert.equal(readmeSummary.includes('PR 권장 기준'), false);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }
});

test('refreshes branch-local badges and summary when measured checkout coverage changes', () => {
  const script = fileURLToPath(new URL('../../scripts/coverage-report.mjs', import.meta.url));
  const cases = [
    { backend: [3, 8], frontend: [3, 8], backendPct: '37.50', frontendPct: '37.50' },
    { backend: [8, 8], frontend: [0, 8], backendPct: '100.00', frontendPct: '0.00' },
  ];
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'glorycourse-coverage-refresh-')));
  try {
    mkdirSync(join(directory, 'coverage'));
    for (const input of cases) {
      const report = {
        total: measures(input.backend[0] + input.frontend[0], input.backend[1] + input.frontend[1]),
        [join(directory, 'backend/src/main.ts')]: measures(...input.backend),
        [join(directory, 'frontend/app.js')]: measures(...input.frontend),
      };
      writeFileSync(join(directory, 'coverage/coverage-summary.json'), JSON.stringify(report));
      const result = spawnSync(process.execPath, [script], { cwd: directory, encoding: 'utf8' });
      assert.equal(result.status, 0, result.error?.message ?? result.stderr);
      const summary = readFileSync(join(directory, 'docs/coverage-report/README.md'), 'utf8');
      for (const [name, pct] of [['Backend', input.backendPct], ['Frontend', input.frontendPct]]) {
        const badge = readFileSync(join(directory, `docs/coverage-report/${name.toLowerCase()}.svg`), 'utf8');
        assert.ok(badge.includes(`${name} coverage: ${pct}%`));
        assert.ok(summary.includes(`| ${name} | ${pct}% |`));
      }
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
