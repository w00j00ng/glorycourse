import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { createServer } from 'node:http';
import { desktopOpenCommand, userDataDirectory } from '../../scripts/runtime-paths.mjs';

const exec = promisify(execFile);
const launcher = resolve('scripts/launcher.mjs');
test('uses the platform user folder and explicit data override', () => {
  const cases = [
    ['win32', { LOCALAPPDATA: '/local' }, '/home', join('/local', 'Glorycourse')],
    ['darwin', {}, '/home', join('/home', 'Library', 'Application Support', 'Glorycourse')],
    ['linux', { XDG_DATA_HOME: '/custom' }, '/home', join('/custom', 'glorycourse')],
    ['linux', { XDG_DATA_HOME: 'relative' }, '/home', join('/home', '.local', 'share', 'glorycourse')],
    ['win32', { GLORYCOURSE_DATA_DIR: './test-data' }, '/home', resolve('test-data')],
  ];
  for (const [platform, env, home, expected] of cases) assert.equal(userDataDirectory(platform, env, home), expected);
});

test('passes browser URLs and localized folder paths literally to Windows', { skip: process.platform !== 'win32' }, async () => {
  const targets = [
    'http://127.0.0.1:4173/',
    join(tmpdir(), "Glorycourse 자료 ' & $(throw 'unexpected') %folder%"),
    join(tmpdir(), 'Glorycourse ‘자료’'),
    join(tmpdir(), "Glorycourse ’; throw 'unexpected'; ‘자료"),
  ];
  for (const target of targets) {
    const { command, args } = desktopOpenCommand(target, 'win32');
    // Intercept the OS launch boundary while exercising the actual PowerShell parser.
    const capture = `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
function Start-Process { [CmdletBinding()] param([string]$FilePath) [Console]::Write($FilePath) }
`;
    const script = capture + Buffer.from(args.at(-1), 'base64').toString('utf16le');
    const { stdout } = await exec(command, [...args.slice(0, -1), Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true });
    assert.equal(stdout, target);
  }
});

test('double start reuses one process; stop and restart preserve data in a path with spaces', { timeout: 60_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'Glorycourse 한글 자료 '));
  const run = (action) => exec(process.execPath, [launcher, action], {
    env: { ...process.env, GLORYCOURSE_DATA_DIR: directory, GLORYCOURSE_NO_OPEN: '1' }, timeout: 35_000,
  });
  t.after(async () => { await run('stop').catch(() => {}); await rm(directory, { recursive: true, force: true }); });
  await Promise.all([run('start'), run('start')]);
  const first = JSON.parse(await readFile(join(directory, 'runtime.json'), 'utf8'));
  await run('start');
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'runtime.json'), 'utf8')), first);
  const { token } = await fetch(`${first.origin}/api/v1/session`, { method: 'POST', headers: { Origin: first.origin } }).then((r) => r.json());
  const saved = await fetch(`${first.origin}/api/v1/applications`, {
    method: 'POST', headers: { Origin: first.origin, 'X-Glorycourse-Session': token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ semesterName: '2033 봄', memberName: '배포 시험', applicationOrder: 1, choices: [{ courseName: '연기', preference: 1 }] }),
  });
  assert.equal(saved.status, 201);
  await saved.arrayBuffer();
  await run('stop');
  await assert.rejects(readFile(join(directory, '.glorycourse.lock')), { code: 'ENOENT' });
  await run('stop');
  await run('start');
  const second = JSON.parse(await readFile(join(directory, 'runtime.json'), 'utf8'));
  assert.notEqual(second.instanceId, first.instanceId);
  const session = await fetch(`${second.origin}/api/v1/session`, { method: 'POST', headers: { Origin: second.origin } }).then((r) => r.json());
  const result = await fetch(`${second.origin}/api/v1/applications`, { headers: { 'X-Glorycourse-Session': session.token } }).then((r) => r.json());
  assert.deepEqual(result.items.map((item) => item.memberName), ['배포 시험']);
});

test('refuses to stop an unrelated service at the recorded port', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'glorycourse-wrong-instance-'));
  let shutdownCalls = 0;
  const server = createServer((req, res) => {
    if (req.url.endsWith('/shutdown')) shutdownCalls++;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(req.url.endsWith('/session') ? { token: 'unrelated' } : { application: 'other', instanceId: 'different' }));
  });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  t.after(async () => { await new Promise((done) => server.close(done)); await rm(directory, { recursive: true, force: true }); });
  await writeFile(join(directory, 'runtime.json'), JSON.stringify({ origin: `http://127.0.0.1:${server.address().port}`, instanceId: 'expected' }));
  await assert.rejects(exec(process.execPath, [launcher, 'stop'], { env: { ...process.env, GLORYCOURSE_DATA_DIR: directory } }));
  assert.equal(shutdownCalls, 0);
});

test('a new launcher refuses to reuse a different running program version', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'glorycourse-old-version-'));
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(req.url.endsWith('/session')
      ? { token: 'running-version' }
      : { application: 'glorycourse', instanceId: 'old-instance', version: '0.0.0', dataDirectory: directory }));
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(async () => { await new Promise((done) => server.close(done)); await rm(directory, { recursive: true, force: true }); });
  await writeFile(join(directory, 'runtime.json'), JSON.stringify({
    origin: `http://127.0.0.1:${server.address().port}`, instanceId: 'old-instance', version: '0.0.0', state: 'ready',
  }));
  await assert.rejects(exec(process.execPath, [launcher, 'start'], {
    env: { ...process.env, GLORYCOURSE_DATA_DIR: directory, GLORYCOURSE_NO_OPEN: '1' }, timeout: 5000,
  }), /다른 버전/);
});
