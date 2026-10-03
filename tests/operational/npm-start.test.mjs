import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import test from 'node:test';

const exec = promisify(execFile);

test('npm start uses the installed project runtime and serves the application', { timeout: 60_000 }, async (t) => {
  const npm = process.env.npm_execpath;
  assert.ok(npm, 'Run with npm run test:npm-start');
  const bootstrapNode = process.env.npm_node_execpath ?? process.execPath;
  const { nodeVersion } = JSON.parse(await readFile('scripts/release-config.json', 'utf8'));
  assert.equal(process.version, `v${nodeVersion}`, 'npm scripts must use the installed project Node');

  const directory = await mkdtemp(join(tmpdir(), 'Glorycourse npm 시작 '));
  const env = { ...process.env, GLORYCOURSE_DATA_DIR: directory, PORT: '0' };
  const child = spawn(bootstrapNode, [npm, 'start'], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  let output = '';
  child.stdout.on('data', (bytes) => { output += bytes; });
  child.stderr.on('data', (bytes) => { output += bytes; });
  t.after(async () => {
    await exec(process.execPath, [resolve('scripts/launcher.mjs'), 'stop'], { env, timeout: 35_000 }).catch(() => {});
    if (child.exitCode === null) child.kill();
    await exited;
    await rm(directory, { recursive: true, force: true });
  });

  let state;
  for (let attempt = 0; attempt < 150; attempt++) {
    try { state = JSON.parse(await readFile(join(directory, 'runtime.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (state?.state === 'ready' || child.exitCode !== null) break;
    await delay(100);
  }
  assert.equal(state?.state, 'ready', output);
  const session = await fetch(`${state.origin}/api/v1/session`, {
    method: 'POST', headers: { Origin: state.origin }, signal: AbortSignal.timeout(5000),
  });
  assert.equal(session.status, 201);
  const { token } = await session.json();
  const page = await fetch(state.origin, { signal: AbortSignal.timeout(5000) });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Glorycourse/);
  const shutdown = await fetch(`${state.origin}/api/v1/shutdown`, {
    method: 'POST', headers: { Origin: state.origin, 'X-Glorycourse-Session': token }, signal: AbortSignal.timeout(5000),
  });
  assert.equal(shutdown.status, 200);
  assert.deepEqual(await shutdown.json(), { state: 'stopped' });
  await exited;
  assert.equal(child.exitCode, 0, output);
});
