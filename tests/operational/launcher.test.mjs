import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { desktopOpenCommand, userDataDirectory } from '../../scripts/runtime-paths.mjs';

const exec = promisify(execFile);
const launcher = resolve('scripts/launcher.mjs');
const fixture = (name) => new URL(`../fixtures/launcher-${name}.mjs`, import.meta.url).href;
const environment = (directory) => ({ ...process.env, GLORYCOURSE_DATA_DIR: directory, GLORYCOURSE_NO_OPEN: '1' });
const publish = async (file, contents) => {
  await writeFile(`${file}.next`, contents);
  await rename(`${file}.next`, file);
};
const failedStart = async (pending, expected) => assert.rejects(pending, (error) => {
  assert.equal(error.code, 1, `launcher must exit itself: ${error.message}`);
  assert.equal(error.killed, false);
  assert.match(error.stderr, expected);
  return true;
});
const output = async (pending, expected) => {
  pending.catch(() => {});
  const [data] = await once(pending.child.stdout, 'data', { signal: AbortSignal.timeout(5000) });
  assert.match(data.toString(), expected);
};
const finishLauncher = async (pending) => {
  if (!pending) return;
  if (pending.child.exitCode === null) pending.child.kill('SIGKILL');
  await pending.catch(() => {});
};
const heldBackend = async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'glorycourse-startup-owner-'));
  const child = spawn(process.execPath, ['--import', fixture('hold-listen'), '--experimental-strip-types',
    '--disable-warning=ExperimentalWarning', resolve('backend/src/main.ts')], {
    env: { ...environment(directory), PORT: '0' }, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  const exited = once(child, 'exit');
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGKILL');
    await exited;
    await rm(directory, { recursive: true, force: true });
  });
  const [message] = await Promise.race([
    once(child, 'message', { signal: AbortSignal.timeout(10_000) }),
    exited.then(() => { throw new Error('Backend exited before holding its listen boundary'); }),
  ]);
  assert.equal(message, 'listen-held');
  return { directory, child };
};

for (const { name, contents } of [
  { name: 'empty lock', contents: '' },
  { name: 'malformed JSON lock', contents: '{' },
  { name: 'null lock', contents: 'null' },
  { name: 'zero PID', contents: '{"pid":0}' },
  { name: 'negative PID', contents: '{"pid":-1}' },
  { name: 'string PID', contents: '{"pid":"123"}' },
]) {
  test(`start diagnoses ${name} without changing the lock or business database`, { timeout: 7000 }, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'glorycourse-invalid-lock-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const lock = join(directory, '.glorycourse.lock');
    const file = join(directory, 'db.sqlite');
    const db = new DatabaseSync(file);
    db.exec("CREATE TABLE business_data (name TEXT); INSERT INTO business_data VALUES ('보존할 자료')");
    db.close();
    await writeFile(lock, contents);
    const before = await readFile(file);
    const started = performance.now();
    await assert.rejects(exec(process.execPath, [launcher, 'start'], {
      env: { ...process.env, GLORYCOURSE_DATA_DIR: directory, GLORYCOURSE_NO_OPEN: '1' }, timeout: 5000,
    }), (error) => {
      assert.equal(error.code, 1, `launcher must exit itself: ${error.message}`);
      assert.equal(error.killed, false);
      assert.match(error.stderr, /잠금.*확인할 수 없/);
      assert.ok(error.stderr.includes(lock), error.stderr);
      assert.ok(error.stderr.includes(join(directory, 'launcher.log')), error.stderr);
      return true;
    });
    assert.ok(performance.now() - started < 5000);
    assert.equal(await readFile(lock, 'utf8'), contents);
    assert.deepEqual(await readFile(file), before);
  });
}

for (const state of [undefined, { state: 'migrating', pid: 2147483647, message: '오래된 자료 확인' },
  { state: 'failed', message: '자료 형식 변경 실패' }]) {
  test(`start reports a child exit with ${state?.state ?? 'missing'} runtime information`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'glorycourse-child-exit-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    if (state) {
      await writeFile(join(directory, 'runtime.json'), JSON.stringify(state));
      await writeFile(join(directory, '.glorycourse.lock'), JSON.stringify({ pid: 2147483647 }));
    }
    await failedStart(exec(process.execPath, ['--import', fixture('child-exit'), launcher, 'start'], {
      env: environment(directory), timeout: 5000,
    }), state?.state === 'failed' ? /자료 형식 변경 실패/ : /프로그램을 시작하지 못했습니다/);
    if (state) assert.deepEqual(JSON.parse(await readFile(join(directory, 'runtime.json'), 'utf8')), state);
  });
}

test('EPERM owner inspection remains UNKNOWN and preserves the possible owner lock', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'glorycourse-owner-eperm-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const lock = JSON.stringify({ pid: process.pid, token: 'possible-owner' });
  await writeFile(join(directory, '.glorycourse.lock'), lock);
  const started = performance.now();
  await failedStart(exec(process.execPath, ['--import', fixture('owner-eperm'), '--import', fixture('child-exit'), launcher, 'start'], {
    env: environment(directory), timeout: 5000,
  }), /UNKNOWN:.*EPERM/);
  assert.ok(performance.now() - started >= 2000, 'Permission denial must retain the initialization grace period');
  assert.equal(await readFile(join(directory, '.glorycourse.lock'), 'utf8'), lock);
  process.kill(process.pid, 0);
});

for (const initialLock of ['', JSON.stringify({ pid: process.pid, token: 'initializing-owner' })]) {
  test(`start connects when ${initialLock ? 'live migration' : 'an initially empty lock'} becomes ready`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'glorycourse-transient-start-'));
    let pending;
    const version = JSON.parse(await readFile(resolve('package.json'), 'utf8')).version;
    const server = createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(req.url.endsWith('/session') ? { token: 'same-owner-session' }
        : { application: 'glorycourse', instanceId: 'initializing-owner', version, dataDirectory: directory }));
    });
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    t.after(async () => {
      await finishLauncher(pending);
      await new Promise((done) => server.close(done));
      await rm(directory, { recursive: true, force: true });
    });
    await writeFile(join(directory, '.glorycourse.lock'), initialLock);
    await writeFile(join(directory, 'runtime.json'), JSON.stringify({ state: 'migrating', pid: process.pid, message: '자료 준비 중' }));
    pending = exec(process.execPath, ['--import', fixture('child-exit'), launcher, 'start'], { env: environment(directory), timeout: 5000 });
    await output(pending, /자료 준비 중/);
    const lock = JSON.stringify({ pid: process.pid, token: 'initializing-owner' });
    await writeFile(join(directory, '.glorycourse.lock'), lock);
    await publish(join(directory, 'runtime.json'), JSON.stringify({ state: 'ready', pid: process.pid,
      origin: `http://127.0.0.1:${server.address().port}`, instanceId: 'initializing-owner', version }));
    const result = await pending;
    assert.match(result.stdout, new RegExp(`Glorycourse ${version}: http://127.0.0.1:`));
    assert.equal(await readFile(join(directory, '.glorycourse.lock'), 'utf8'), lock);
  });
}

test('a real live backend survives the normal 30 second launcher deadline with its lock and database intact', { timeout: 40_000 }, async (t) => {
  const { directory, child } = await heldBackend(t);
  await rm(join(directory, 'runtime.json'));
  const lock = await readFile(join(directory, '.glorycourse.lock'));
  const database = await readFile(join(directory, 'db.sqlite'));
  const started = performance.now();
  await failedStart(exec(process.execPath, [launcher, 'start'], { env: environment(directory), timeout: 36_000 }), /준비 확인 시간이 초과/);
  const elapsed = performance.now() - started;
  assert.ok(elapsed >= 30_000 && elapsed < 36_000, `Deadline elapsed ${elapsed} ms`);
  t.diagnostic(`Normal startup deadline: ${elapsed.toFixed(1)} ms`);
  process.kill(child.pid, 0);
  assert.deepEqual(await readFile(join(directory, '.glorycourse.lock')), lock);
  assert.deepEqual(await readFile(join(directory, 'db.sqlite')), database);
});

for (const matchingOwner of [true, false]) {
  test(`migration with ${matchingOwner ? 'matching' : 'different'} owner obeys its absolute startup deadline`, { timeout: 10_000 }, async (t) => {
    let pending;
    t.after(() => finishLauncher(pending));
    const { directory, child } = await heldBackend(t);
    const state = JSON.parse(await readFile(join(directory, 'runtime.json'), 'utf8'));
    if (!matchingOwner) state.pid = 2147483647;
    state.message = '첫 자료 확인';
    await writeFile(join(directory, 'runtime.json'), JSON.stringify(state));
    await writeFile(join(directory, 'launcher-clock'), '0');
    const lock = await readFile(join(directory, '.glorycourse.lock'));
    const database = await readFile(join(directory, 'db.sqlite'));
    pending = exec(process.execPath, ['--import', fixture('child-exit'), '--import', fixture('clock'), launcher, 'start'], { env: environment(directory), timeout: 7000 });
    await output(pending, /첫 자료 확인/);
    if (matchingOwner) {
      await publish(join(directory, 'launcher-clock'), '299000');
      await publish(join(directory, 'runtime.json'), JSON.stringify({ ...state, message: '늦은 자료 확인' }));
      await output(pending, /늦은 자료 확인/);
    }
    await publish(join(directory, 'launcher-clock'), matchingOwner ? '300001' : '30001');
    await failedStart(pending, /준비 확인 시간이 초과/);
    process.kill(child.pid, 0);
    assert.deepEqual(await readFile(join(directory, '.glorycourse.lock')), lock);
    assert.deepEqual(await readFile(join(directory, 'db.sqlite')), database);
  });
}

test('an UNKNOWN owner replaced during a stalled probe can still connect after its grace expires', { timeout: 7000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'glorycourse-recovered-owner-'));
  let pending;
  let requests = 0;
  const version = JSON.parse(await readFile(resolve('package.json'), 'utf8')).version;
  const lock = JSON.stringify({ pid: process.pid, token: 'recovered-owner' });
  const server = createServer((req, res) => {
    if (req.url.endsWith('/session') && requests++ === 0) {
      void (async () => {
        await publish(join(directory, '.glorycourse.lock'), lock);
        await writeFile(join(directory, 'launcher-child-requested'), '');
      })();
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(req.url.endsWith('/session') ? { token: 'recovered-session' }
      : { application: 'glorycourse', instanceId: 'recovered-owner', version, dataDirectory: directory }));
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(async () => {
    await writeFile(join(directory, 'launcher-child-requested'), '');
    await finishLauncher(pending);
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
    await rm(directory, { recursive: true, force: true });
  });
  await writeFile(join(directory, '.glorycourse.lock'), '');
  await writeFile(join(directory, 'launcher-child-await-request'), '');
  await writeFile(join(directory, 'runtime.json'), JSON.stringify({ state: 'starting', message: '소유자 준비 중' }));
  pending = exec(process.execPath, ['--import', fixture('child-exit'), launcher, 'start'], { env: environment(directory), timeout: 5000 });
  await output(pending, /소유자 준비 중/);
  await publish(join(directory, 'runtime.json'), JSON.stringify({ state: 'ready',
    origin: `http://127.0.0.1:${server.address().port}`, instanceId: 'recovered-owner', version }));
  assert.match((await pending).stdout, /Glorycourse .*http:\/\/127\.0\.0\.1:/);
  assert.ok(requests >= 2);
  assert.equal(await readFile(join(directory, '.glorycourse.lock'), 'utf8'), lock);
});

for (const stalled of ['session', 'runtime']) {
  test(`a stalled ${stalled} response cannot extend the startup deadline`, { timeout: 7000 }, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'glorycourse-stalled-connect-'));
    let pending;
    const version = JSON.parse(await readFile(resolve('package.json'), 'utf8')).version;
    let stalledRequests = 0;
    const server = createServer((req, res) => {
      if (req.url.endsWith(`/${stalled}`)) { stalledRequests++; return; }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ token: 'startup-session' }));
    });
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    t.after(async () => {
      await finishLauncher(pending);
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
      await rm(directory, { recursive: true, force: true });
    });
    await writeFile(join(directory, '.glorycourse.lock'), JSON.stringify({ pid: process.pid, token: 'live-owner' }));
    await writeFile(join(directory, 'runtime.json'), JSON.stringify({ state: 'starting', message: '접속 대기' }));
    await writeFile(join(directory, 'launcher-clock'), '0');
    pending = exec(process.execPath, ['--import', fixture('child-exit'), '--import', fixture('clock'), launcher, 'start'], {
      env: environment(directory), timeout: 5000,
    });
    await output(pending, /접속 대기/);
    const advanced = performance.now();
    await publish(join(directory, 'launcher-clock'), '29000');
    await publish(join(directory, 'runtime.json'), JSON.stringify({ state: 'ready',
      origin: `http://127.0.0.1:${server.address().port}`, instanceId: 'live-owner', version }));
    await failedStart(pending, /준비 확인 시간이 초과/);
    assert.equal(stalledRequests, 1);
    assert.ok(performance.now() - advanced < 2000, 'Remaining startup budget must cap the pending fetch');
    process.kill(process.pid, 0);
  });
}

for (const inFlight of [false, true]) for (const stalled of ['session', 'runtime']) {
  test(`a child exiting ${inFlight ? 'during' : 'before'} a stalled ${stalled} diagnoses UNKNOWN within the initialization grace`, { timeout: 7000 }, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'glorycourse-unknown-connect-'));
    let pending;
    const server = createServer((req, res) => {
      if (req.url.endsWith(`/${stalled}`)) {
        if (inFlight) void writeFile(join(directory, 'launcher-child-requested'), '');
        return;
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ token: 'stale-owner-session' }));
    });
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    t.after(async () => {
      if (inFlight) await writeFile(join(directory, 'launcher-child-requested'), '');
      await finishLauncher(pending);
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
      await rm(directory, { recursive: true, force: true });
    });
    await writeFile(join(directory, '.glorycourse.lock'), '');
    if (inFlight) await writeFile(join(directory, 'launcher-child-await-request'), '');
    await writeFile(join(directory, 'runtime.json'), JSON.stringify({ state: 'starting', message: '접속 대기' }));
    const started = performance.now();
    pending = exec(process.execPath, ['--import', fixture('child-exit'), launcher, 'start'], {
      env: environment(directory), timeout: 5000,
    });
    await output(pending, /접속 대기/);
    if (!inFlight) {
      const deadline = performance.now() + 2000;
      while (!await readFile(join(directory, 'launcher-child-exited')).then(() => true, () => false)) {
        assert.ok(performance.now() < deadline, 'The injected backend child must exit before the ready probe');
        await new Promise((done) => setTimeout(done, 10));
      }
    }
    await publish(join(directory, 'runtime.json'), JSON.stringify({ state: 'ready',
      origin: `http://127.0.0.1:${server.address().port}`, instanceId: 'stale-owner', version: '0.3.0' }));
    await assert.rejects(pending, (error) => {
      assert.equal(error.code, 1);
      assert.equal(error.killed, false);
      assert.match(error.stderr, /UNKNOWN/);
      assert.ok(error.stderr.includes(join(directory, '.glorycourse.lock')), error.stderr);
      return true;
    });
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 3500, `UNKNOWN grace elapsed ${elapsed} ms`);
    assert.equal(await readFile(join(directory, '.glorycourse.lock'), 'utf8'), '');
    t.diagnostic(`UNKNOWN + stalled ${stalled}: ${elapsed.toFixed(1)} ms`);
  });
}
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
