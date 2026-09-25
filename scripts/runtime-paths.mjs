import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

export const userDataDirectory = (platform = process.platform, env = process.env, home = homedir()) => {
  if (env.GLORYCOURSE_DATA_DIR) return resolve(env.GLORYCOURSE_DATA_DIR);
  if (platform === 'win32') return join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'Glorycourse');
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'Glorycourse');
  return join(env.XDG_DATA_HOME && isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : join(home, '.local', 'share'), 'glorycourse');
};

export const desktopOpenCommand = (target, platform = process.platform) => {
  if (platform === 'win32') {
    const encodedTarget = Buffer.from(target, 'utf8').toString('base64');
    const command = `Start-Process -FilePath ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedTarget}'))) -ErrorAction Stop`;
    return { command: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-EncodedCommand',
      Buffer.from(command, 'utf16le').toString('base64')] };
  }
  return platform === 'darwin' ? { command: 'open', args: [target] } : { command: 'xdg-open', args: [target] };
};

export const openDesktop = (target) => new Promise((resolveOpen, reject) => {
  const { command, args } = desktopOpenCommand(target);
  const child = spawn(command, args, { windowsHide: true, stdio: 'ignore' });
  child.once('error', reject);
  child.once('exit', (code) => {
    if (code === 0) resolveOpen();
    else reject(new Error(`대상을 열지 못했습니다. 운영체제 명령 종료 코드: ${code}`));
  });
});
