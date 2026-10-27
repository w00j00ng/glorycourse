import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Advance only the launcher clock; its polling and subprocesses still run normally.
const now = performance.now.bind(performance);
const started = now();
Object.defineProperty(performance, 'now', {
  value: () => Number(readFileSync(join(process.env.GLORYCOURSE_DATA_DIR, 'launcher-clock'), 'utf8')) + now() - started,
});
