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

const connect = async (deadline, signal) => {
  if (deadline !== undefined && performance.now() >= deadline) return;
  const state = await readState();
  if (!state || (state.state && state.state !== 'ready')) return;
  if (!/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(state.origin) || typeof state.instanceId !== 'string') {
    throw new Error('실행 정보가 올바르지 않습니다. 다른 프로그램에 연결하지 않았습니다.');
  }
  const request = async (path, options = {}) => {
    const remaining = deadline === undefined ? 5000 : Math.min(5000, Math.ceil(deadline - performance.now()));
    if (remaining <= 0) throw new DOMException('Startup deadline exceeded', 'TimeoutError');
    const response = await fetch(`${state.origin}/api/v1${path}`, {
      ...options, redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(remaining)]) : AbortSignal.timeout(remaining),
      headers: { Origin: state.origin, ...options.headers },
    });
    if (!response.ok) throw new Error('기존 프로그램이 응답하지 않습니다. 잠시 후 다시 시도하세요.');
    return response.json();
  };
  let session;
  try { session = await request('/session', { method: 'POST' }); }
  catch (error) {
    if (error.cause?.code === 'ECONNREFUSED'
      || signal?.aborted || (['TimeoutError', 'AbortError'].includes(error.name) && deadline !== undefined && performance.now() >= deadline)) return;
    throw error;
  }
  const headers = { 'X-Glorycourse-Session': session.token };
  let info;
  try { info = await request('/runtime', { headers }); }
  catch (error) {
    if (signal?.aborted || (['TimeoutError', 'AbortError'].includes(error.name) && deadline !== undefined && performance.now() >= deadline)) return;
    throw error;
  }
  if (info.application !== 'glorycourse' || info.instanceId !== state.instanceId
    || info.dataDirectory !== directory || info.version !== state.version) {
    throw new Error('실행 정보와 응답한 프로그램이 다릅니다. 다른 프로그램을 종료하지 않았습니다.');
  }
  return { ...state, headers };
};

const start = async () => {
  const started = performance.now();
  let deadline = started + 30_000;
  let running = await connect(deadline);
  if (!running) {
    const log = await open(logFile, 'a');
    let spawnError;
    let childExit;
    let lock;
    let unknownSince;
    let connectionAbort;
    try {
      const child = spawn(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', join(root, 'backend', 'src', 'main.ts')], {
        cwd: root, detached: true, windowsHide: true, stdio: ['ignore', log.fd, log.fd],
        env: { ...process.env, GLORYCOURSE_DATA_DIR: directory, PORT: '0' },
      });
      child.once('error', (error) => { spawnError = error; });
      child.once('exit', (code) => {
        childExit = code ?? 1;
        if (lock?.state === 'UNKNOWN') {
          unknownSince ??= performance.now();
          // A child can exit while a stale ready endpoint is still being checked.
          setTimeout(() => {
            if (lock?.state === 'UNKNOWN') connectionAbort?.abort(new DOMException('Owner grace exceeded', 'TimeoutError'));
          }, 2000).unref();
        }
      });
      child.unref();
    } finally { await log.close(); }
    let lastMessage;
    for (;;) {
      if (spawnError) throw spawnError;
      const state = await readState();
      lock = await observeLock();
      const now = performance.now();
      if (lock.state === 'ALIVE' && state?.pid === lock.pid && state.state === 'migrating'
        && typeof state.message === 'string' && state.message.length > 0) deadline = started + 300_000;
      unknownSince = childExit !== undefined && lock.state === 'UNKNOWN' ? unknownSince ?? now : undefined;
      const connectionDeadline = unknownSince === undefined ? deadline : Math.min(deadline, unknownSince + 2000);
      connectionAbort = new AbortController();
      running = await connect(connectionDeadline, connectionAbort.signal);
      connectionAbort = undefined;
      if (running) break;
      const noOwner = lock.state === 'MISSING' || lock.state === 'DEAD';
      const unknownExpired = unknownSince !== undefined && performance.now() - unknownSince >= 2000;
      if ((noOwner && (childExit !== undefined || state?.state === 'failed')) || unknownExpired || performance.now() >= deadline) {
        running = await connect(unknownSince === undefined ? deadline : Math.min(deadline, unknownSince + 2000));
        if (running) break;
        const finalLock = await observeLock();
        const diagnostic = `잠금 파일: ${lockFile} (${finalLock.state}: ${finalLock.reason})`;
        if (performance.now() >= deadline) {
          throw new Error(`프로그램 준비 확인 시간이 초과되었습니다. 백그라운드에서 작업이 계속될 수 있으므로 잠시 후 시작 파일을 다시 실행하세요. ${diagnostic}`);
        }
        if (finalLock.state === 'MISSING' || finalLock.state === 'DEAD') {
          throw new Error(`${state?.state === 'failed' ? state.message ?? '프로그램을 시작하지 못했습니다.' : '프로그램을 시작하지 못했습니다.'} ${diagnostic}`);
        }
        if (unknownExpired && finalLock.state === 'UNKNOWN') {
          throw new Error(`잠금 파일의 소유자를 확인할 수 없습니다. 잠금 파일을 직접 지우지 말고 실행 기록을 확인하세요. ${diagnostic}`);
        }
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

const observeLock = async () => {
  let pid;
  try { pid = JSON.parse(await readFile(lockFile, 'utf8'))?.pid; }
  catch (error) {
    if (error.code === 'ENOENT') return { state: 'MISSING', reason: '파일 없음' };
    return { state: 'UNKNOWN', reason: error.code ?? 'JSON을 읽을 수 없음' };
  }
  if (!Number.isSafeInteger(pid) || pid <= 0) return { state: 'UNKNOWN', reason: '유효하지 않은 PID' };
  try { process.kill(pid, 0); return { state: 'ALIVE', pid, reason: `PID ${pid} 실행 중` }; }
  catch (error) {
    return { state: error.code === 'ESRCH' ? 'DEAD' : 'UNKNOWN', pid, reason: `PID ${pid}: ${error.code ?? '확인 불가'}` };
  }
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
