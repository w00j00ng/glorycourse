import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, '../..');
const config = JSON.parse(await readFile(join(root, 'scripts/release-config.json'), 'utf8'));
const target = config.targets[`${process.platform}-${process.arch}`];
const archive = resolve(process.argv[2] ?? join(root, 'dist', target.archive));
const scratch = await mkdtemp(join(tmpdir(), 'glorycourse-package-'));
const unpacked = join(scratch, 'unpacked');
const directory = join(scratch, '사용자 자료');
const localized = join(scratch, 'Glorycourse 배포 검증');
const top = join(localized, 'Glorycourse');
const app = process.platform === 'darwin' ? join(top, 'Glorycourse.app/Contents/Resources/app') : top;
const node = join(app, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node');
const env = { ...process.env, GLORYCOURSE_DATA_DIR: directory, GLORYCOURSE_NO_OPEN: '1', NODE_PATH: '', NODE_OPTIONS: '', PATH: process.platform === 'win32' ? join(process.env.SystemRoot, 'System32') : '/usr/bin:/bin' };
const launch = (action) => {
  const label = action === 'start' ? '시작' : '종료';
  if (process.platform === 'win32') return exec(process.env.ComSpec, ['/d', '/s', '/c', `""${join(top, `${label}.cmd`)}""`], { env, timeout: 40_000, windowsVerbatimArguments: true });
  if (process.platform === 'linux') return exec(join(top, `${label}.sh`), [], { env, timeout: 40_000 });
  return exec(node, [join(app, 'scripts/launcher.mjs'), action], { env, timeout: 40_000 });
};
let running;
let token;
const connect = async () => {
  running = JSON.parse(await readFile(join(directory, 'runtime.json'), 'utf8'));
  token = (await api('/session', { method: 'POST' }, 201)).token;
};
const api = async (path, options = {}, status = 200) => {
  const response = await fetch(`${running.origin}/api/v1${path}`, {
    ...options, headers: { Origin: running.origin, ...(token ? { 'X-Glorycourse-Session': token } : {}), ...options.headers },
    signal: AbortSignal.timeout(30_000),
  });
  assert.equal(response.status, status, `${path}: ${response.status}`);
  return response.headers.get('content-type')?.includes('json') ? response.json() : Buffer.from(await response.arrayBuffer());
};
const post = (path, value, status = 200) => api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) }, status);
const application = (memberName) => ({ semesterName: '2033 봄', memberName, applicationOrder: 1, choices: [{ courseName: '연기', preference: 1 }] });

try {
  await mkdir(unpacked);
  if (process.platform === 'darwin') execFileSync('ditto', ['-x', '-k', archive, unpacked]);
  else execFileSync('tar', ['-xf', archive, '-C', unpacked]);
  await mkdir(localized);
  await rename(join(unpacked, 'Glorycourse'), top);
  const manifest = JSON.parse(await readFile(join(top, 'MANIFEST.json'), 'utf8'));
  const release = JSON.parse(await readFile(join(app, 'release.json'), 'utf8'));
  const pkg = JSON.parse(await readFile(join(app, 'package.json'), 'utf8'));
  assert.equal(release.version, pkg.version);
  assert.equal(manifest.version, pkg.version);
  for (const name of ['usage', 'development', 'releasing', 'contract-decisions', 'dependencies']) {
    assert.ok((await readFile(join(top, 'docs', `${name}.md`), 'utf8')).trim(), `README link: docs/${name}.md`);
  }
  const migrationManifest = await readFile(join(app, 'schema/migrations/manifest.json'));
  assert.equal(release.migrationManifestSha256, createHash('sha256').update(migrationManifest).digest('hex'));
  assert.equal(release.databaseVersion, String(JSON.parse(migrationManifest).targetVersion));
  assert.ok(Object.keys(manifest.files).some((name) => /(^|\/)schema\/migrations\/1790294400_init\.sql$/.test(name)));
  assert.ok(Object.keys(manifest.files).every((name) => !/^migrations\//.test(name)));
  for (const [name, hash] of Object.entries(manifest.files)) {
    assert.equal(createHash('sha256').update(await readFile(join(top, name))).digest('hex'), hash, name);
    assert.doesNotMatch(name, /(^|\/)(\.data|\.git|\.env|launcher\.log)(\/|$)/);
  }
  assert.equal(execFileSync(node, ['--version'], { env, encoding: 'utf8' }).trim(), `v${config.nodeVersion}`);
  await launch('start');
  await connect();
  const first = running.instanceId;
  await launch('start');
  await connect();
  assert.equal(running.instanceId, first);
  const page = await fetch(running.origin).then((r) => r.text());
  assert.match(page, /프로그램 종료/);
  await post('/applications', application('배포 보존 회원'), 201);
  const workbook = await api('/applications/export');
  assert.equal(workbook.subarray(0, 2).toString(), 'PK');
  const form = new FormData();
  form.set('kind', 'APPLICATIONS');
  form.set('mode', 'MERGE_KEEP_EXISTING');
  form.set('file', new Blob([workbook]), '신청.xlsx');
  const importPreview = await api('/imports/preview', { method: 'POST', body: form });
  assert.ok(importPreview);
  await api('/backups', { method: 'POST' }, 201);
  const [backup] = await readdir(join(directory, 'backups'));
  await post('/applications', application('복원으로 지울 회원'), 201);
  const review = await api('/restores/preview', {
    method: 'POST', headers: { 'Content-Type': 'application/vnd.sqlite3' }, body: await readFile(join(directory, 'backups', backup)),
  });
  await api('/restores', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'package-restore' },
    body: JSON.stringify({ preparedActionToken: review.preparedActionToken, acknowledgedWarningDigest: review.warningDigest, acknowledgementNote: '배포 복원 검증' }),
  });
  assert.deepEqual((await api('/applications')).items.map((item) => item.memberName), ['배포 보존 회원']);
  assert.deepEqual(await api('/shutdown', { method: 'POST' }), { state: 'stopped' });
  // A new launcher waits for cleanup before attempting to use the same data again.
  for (let i = 0; i < 100; i++) {
    try { await readFile(join(directory, '.glorycourse.lock')); }
    catch (error) { if (error.code === 'ENOENT') break; throw error; }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  await launch('start');
  await connect();
  assert.notEqual(running.instanceId, first);
  assert.deepEqual((await api('/applications')).items.map((item) => item.memberName), ['배포 보존 회원']);
  await launch('stop');
  await assert.rejects(readFile(join(directory, '.glorycourse.lock')), { code: 'ENOENT' });
  await launch('stop');
  console.log(`PASS ${target.name}: archive integrity, bundled runtime, start twice, save, xlsx, backup/restore, UI shutdown API, restart, stop file`);
} finally {
  try { await launch('stop'); } catch { /* Preserve failing test output; never kill unrelated processes. */ }
  await rm(scratch, { recursive: true, force: true });
}
