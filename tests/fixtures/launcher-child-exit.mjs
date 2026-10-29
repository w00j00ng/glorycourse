import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Fail before the backend can publish any runtime state, using a real child exit.
const spawn = childProcess.spawn;
childProcess.spawn = (command, args, options) => {
  const directory = options.env.GLORYCOURSE_DATA_DIR;
  const child = spawn(command, ['-e', `
    const fs = require('node:fs');
    const path = require('node:path');
    const directory = ${JSON.stringify(directory)};
    if (!fs.existsSync(path.join(directory, 'launcher-child-await-request'))) process.exit(17);
    const exit = () => { if (fs.existsSync(path.join(directory, 'launcher-child-requested'))) process.exit(17); };
    fs.watch(directory, exit);
    exit();
  `], options);
  child.once('exit', () => writeFileSync(join(directory, 'launcher-child-exited'), ''));
  child.unref = () => {}; // Keep the test launcher alive until this short-lived child has actually exited.
  return child;
};
syncBuiltinESMExports();
