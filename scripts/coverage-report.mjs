import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { relative } from 'node:path';

const report = JSON.parse(await readFile('coverage/coverage-summary.json', 'utf8'));
const metrics = [['lines', '줄'], ['branches', '분기'], ['functions', '함수'], ['statements', '구문']];
for (const [file, values] of Object.entries(report)) {
  for (const [key] of metrics) {
    const metric = values?.[key];
    if (!metric || !Number.isInteger(metric.total) || metric.total < 0
      || !Number.isInteger(metric.covered) || metric.covered < 0 || metric.covered > metric.total
      || typeof metric.pct !== 'number' || !Number.isFinite(metric.pct) || metric.pct < 0 || metric.pct > 100) {
      throw new Error(`Invalid coverage metric: ${file} ${key}`);
    }
  }
}
if (!report.total?.lines.total) throw new Error('Coverage report has no measured lines');
const areas = [['Backend', 'backend/src/'], ['Frontend', 'frontend/']].map(([name, prefix]) => {
  const files = Object.entries(report).filter(([file]) => file !== 'total'
    && relative(process.cwd(), file).replaceAll('\\', '/').startsWith(prefix));
  if (!files.length) throw new Error(`Coverage report is missing ${name} source files`);
  const values = Object.fromEntries(metrics.map(([key]) => {
    const total = files.reduce((sum, [, entry]) => sum + entry[key].total, 0);
    const covered = files.reduce((sum, [, entry]) => sum + entry[key].covered, 0);
    return [key, { total, covered, pct: total === 0 ? 100 : Math.floor(10000 * covered / total) / 100 }];
  }));
  if (!values.lines.total) throw new Error(`Coverage report has no measured ${name} lines`);
  return { name, values };
});
const warnings = process.env.GITHUB_EVENT_NAME === 'pull_request'
  ? areas.filter(({ values }) => values.lines.pct < 80)
    .map(({ name, values }) => `${name} 줄 커버리지 ${values.lines.pct.toFixed(2)}%가 PR 권장 기준 80% 미만입니다.`)
  : [];
const rows = [...areas, { name: '전체 (실행기 포함)', values: report.total }].map(({ name, values }) => (
  `| ${name} | ${metrics.map(([key]) => `${values[key].pct.toFixed(2)}%`).join(' | ')} |`
));
const summary = [
  '모노레포의 백엔드와 프런트엔드를 따로 집계합니다. 배지는 줄 커버리지를 표시하며, 미실행 파일도 0%로 포함합니다.',
  '',
  '| 영역 | 줄 | 분기 | 함수 | 구문 |',
  '| --- | ---: | ---: | ---: | ---: |',
  ...rows,
  '',
  ...warnings.flatMap((warning) => [`> ⚠️ ${warning}`, '']),
].join('\n');
await writeFile('coverage/SUMMARY.md', summary);
for (const warning of warnings) console.log(`::warning title=Coverage below 80 percent::${warning.replaceAll('%', '%25')}`);

const pageDirectory = 'coverage/pages/coverage';
await mkdir(pageDirectory, { recursive: true });
for (const { name, values } of areas) {
  const percent = values.lines.pct.toFixed(2);
  const color = values.lines.pct >= 80 ? '#4c1' : '#fe7d37';
  const labelWidth = 112;
  const valueWidth = 62;
  const badge = `<svg xmlns="http://www.w3.org/2000/svg" width="${labelWidth + valueWidth}" height="20" role="img" aria-label="${name} coverage: ${percent}%">
  <title>${name} coverage: ${percent}%</title>
  <clipPath id="round"><rect width="${labelWidth + valueWidth}" height="20" rx="3"/></clipPath>
  <g clip-path="url(#round)"><rect width="${labelWidth}" height="20" fill="#555"/><rect x="${labelWidth}" width="${valueWidth}" height="20" fill="${color}"/></g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11"><text x="${labelWidth / 2}" y="14">${name} coverage</text><text x="${labelWidth + valueWidth / 2}" y="14">${percent}%</text></g>
</svg>
`;
  await writeFile(`${pageDirectory}/${name.toLowerCase()}.svg`, badge);
}

const htmlRows = [...areas, { name: '전체 (실행기 포함)', values: report.total }].map(({ name, values }) => (
  `<tr><td>${name}</td>${metrics.map(([key]) => `<td>${values[key].pct.toFixed(2)}%</td>`).join('')}</tr>`
)).join('\n');
const html = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Glorycourse 테스트 커버리지</title>
<style>body{font-family:system-ui,sans-serif;max-width:760px;margin:40px auto;padding:0 16px;color:#24292f}table{border-collapse:collapse;width:100%}th,td{border:1px solid #d0d7de;padding:8px;text-align:right}th:first-child,td:first-child{text-align:left}</style></head>
<body><h1>Glorycourse 테스트 커버리지</h1><p>모노레포의 백엔드와 프런트엔드를 따로 집계하며, 미실행 파일도 0%로 포함합니다.</p>
<table><thead><tr><th>영역</th>${metrics.map(([, label]) => `<th>${label}</th>`).join('')}</tr></thead><tbody>${htmlRows}</tbody></table></body></html>
`;
await writeFile(`${pageDirectory}/index.html`, html);
await writeFile('coverage/pages/index.html', '<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0; url=coverage/"><a href="coverage/">커버리지 보고서 열기</a>\n');
console.log(summary);
