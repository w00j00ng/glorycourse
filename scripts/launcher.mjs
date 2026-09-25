import { spawn } from 'node:child_process';
import { mkdir, open, readFile, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { openDesktop, userDataDirectory } from './runtime-paths.mjs';

const root = resolve(import.meta.dirname, '..');
const currentVersion = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
const directory = userDataDirectory();
const stateFile = join(directory, 'runtime.json');
const lockFile = join(directory, '.glorycourse.lock');
const logFile = join(directory, 'launcher.log');
const exists = async (file) => access(file).then(() => true, (error) => { if (error.code === 'ENOENT') return false; throw error; });

const readState = async () => {
  let state;
  try { state = JSON.parse(await readFile(stateFile, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return; throw new Error('실행 정보 파일을 읽을 수 없습니다. 자료 폴더의 runtime.json을 확인하세요.'); }
  return state;
};

const connect = async () => {
  const state = await readState();
  if (!state || (state.state && state.state !== 'ready')) return;
  if (!/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(state.origin) || typeof state.instanceId !== 'string') {
    throw new Error('실행 정보가 올바르지 않습니다. 다른 프로그램에 연결하지 않았습니다.');
  }
  const request = async (path, options = {}) => {
    const response = await fetch(`${state.origin}/api/v1${path}`, {
      ...options, redirect: 'error', signal: AbortSignal.timeout(5000),
      headers: { Origin: state.origin, ...options.headers },
    });
    if (!response.ok) throw new Error('기존 프로그램이 응답하지 않습니다. 잠시 후 다시 시도하세요.');
    return response.json();
  };
  let session;
  try { session = await request('/session', { method: 'POST' }); }
  catch (error) { if (error.cause?.code === 'ECONNREFUSED') return; throw error; }
  const headers = { 'X-Glorycourse-Session': session.token };
  const info = await request('/runtime', { headers });
  if (info.application !== 'glorycourse' || info.instanceId !== state.instanceId
    || info.dataDirectory !== directory || info.version !== state.version) {
    throw new Error('실행 정보와 응답한 프로그램이 다릅니다. 다른 프로그램을 종료하지 않았습니다.');
  }
  return { ...state, headers };
};

const start = async () => {
  let running = await connect();
  if (!running) {
    const log = await open(logFile, 'a');
    let spawnError;
    let childExit;
    try {
      const child = spawn(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', join(root, 'backend', 'src', 'main.ts')], {
        cwd: root, detached: true, windowsHide: true, stdio: ['ignore', log.fd, log.fd],
        env: { ...process.env, GLORYCOURSE_DATA_DIR: directory, PORT: '0' },
      });
      child.once('error', (error) => { spawnError = error; });
      child.once('exit', (code) => { childExit = code ?? 1; });
      child.unref();
    } finally { await log.close(); }
    let lastMessage;
    for (;;) {
      if (spawnError) throw spawnError;
      running = await connect();
      if (running) break;
      const state = await readState();
      if (state?.state === 'failed' && !(await liveLock())) throw new Error(state.message ?? '프로그램을 시작하지 못했습니다.');
      if (childExit !== undefined && !(await liveLock())) {
        throw new Error('프로그램을 시작하지 못했습니다. 자료 폴더의 launcher.log를 확인하세요.');
      }
      if (state?.message && state.message !== lastMessage) {
        console.log(state.message);
        lastMessage = state.message;
      }
      await delay(200);
    }
  }
  if (running.version !== currentVersion) {
    throw new Error(`다른 버전(${running.version})이 실행 중입니다. 먼저 종료한 뒤 ${currentVersion}을 다시 시작하세요.`);
  }
  console.log(`Glorycourse ${running.version}: ${running.origin}`);
  if (process.env.GLORYCOURSE_NO_OPEN !== '1') await openDesktop(running.origin);
};

const liveLock = async () => {
  let pid;
  try { pid = JSON.parse(await readFile(lockFile, 'utf8')).pid; }
  catch (error) { if (error.code === 'ENOENT') return false; return true; }
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
};

const stop = async () => {
  const running = await connect();
  if (!running) {
    if (await exists(lockFile)) throw new Error('실행 중이거나 비정상 종료된 상태입니다. 시작 파일로 화면을 연 뒤 종료하세요.');
    console.log('Glorycourse가 이미 종료되어 있습니다.');
    return;
  }
  const response = await fetch(`${running.origin}/api/v1/shutdown`, {
    method: 'POST', headers: { ...running.headers, Origin: running.origin }, redirect: 'error', signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok || (await response.json()).state !== 'stopped') throw new Error('종료를 확인하지 못했습니다. 잠시 후 다시 시도하세요.');
  for (let attempt = 0; attempt < 150; attempt++) {
    if (!await exists(lockFile)) { console.log('Glorycourse가 종료되었습니다.'); return; }
    await delay(200);
  }
  throw new Error('저장 요청은 완료했지만 종료 정리가 진행 중입니다. 잠시 후 다시 시도하세요.');
};

try {
  await mkdir(directory, { recursive: true });
  const action = process.argv[2] ?? 'start';
  if (action === 'start') await start();
  else if (action === 'stop') await stop();
  else if (action === 'data') await openDesktop(directory);
  else throw new Error('start, stop, data 중 하나를 선택하세요.');
} catch (error) {
  console.error(`Glorycourse: ${error.message}\n자료 폴더: ${directory}\n실행 기록: ${logFile}`);
  process.exitCode = 1;
}
