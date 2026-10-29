const kill = process.kill;
process.kill = (pid, signal) => {
  if (signal === 0) throw Object.assign(new Error('Owner inspection denied'), { code: 'EPERM' });
  return kill(pid, signal);
};
