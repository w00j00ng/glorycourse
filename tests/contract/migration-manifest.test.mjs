import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { inspectMigrationHistory } from '../../backend/src/storage/migrations.ts';
import { migrateDatabase } from '../../backend/src/bootstrap/database.ts';

const empty = JSON.parse(await readFile(new URL('../fixtures/store/store-valid-empty.json', import.meta.url), 'utf8'));
const current = JSON.parse(await readFile(new URL('../../schema/migrations/manifest.json', import.meta.url), 'utf8'));
const futureVersion = current.targetVersion + 86400;
const preserved = JSON.parse(await readFile(new URL('../../schema/migrations/legacy-manifest.json', import.meta.url), 'utf8'));

test('generator and runtime agree on legacy metadata rejection and allow future up/down pairs', async () => {
  const cases = [
    { name: 'preserved metadata', change: () => {}, valid: true },
    { name: 'new migration with the preserved prefix', change: () => {}, future: true, valid: true },
    { name: 'extra legacy row', change: (value) => value.migrations.push({ version: 1791244800, name: '1791244800_missing.sql', checksum: '0'.repeat(64) }), valid: false },
    { name: 'invalid initial checksum format', change: (value) => { value.migrations[0].checksum = 'x'.repeat(64); }, valid: false },
    { name: 'changed up checksum', change: (value) => { value.migrations[1].checksum = '0'.repeat(64); }, valid: false },
    { name: 'wrong filename', change: (value) => { value.migrations[0].name = '1790294400_wrong.sql'; }, valid: false },
    { name: 'string version', change: (value) => { value.migrations[0].version = String(value.migrations[0].version); }, valid: false },
    { name: 'missing middle version', change: (value) => value.migrations.splice(1, 1), valid: false },
    { name: 'duplicate version', change: (value) => value.migrations.splice(1, 0, value.migrations[0]), valid: false },
    { name: 'null legacy row', change: (value) => { value.migrations[0] = null; }, valid: false },
    { name: 'legacy rows are not an array', change: (value) => { value.migrations = {}; }, valid: false },
  ];
  for (const input of cases) {
    const directory = await mkdtemp(join(tmpdir(), 'glorycourse-manifest-contract-'));
    try {
      await mkdir(join(directory, 'scripts'));
      const script = join(directory, 'scripts/migrations-manifest.mjs');
      await cp(new URL('../../scripts/migrations-manifest.mjs', import.meta.url), script);
      await cp(new URL('../../schema/', import.meta.url), join(directory, 'schema'), { recursive: true });
      const migrations = join(directory, 'schema/migrations');
      const file = join(directory, 'db.sqlite');
      await migrateDatabase(file, empty);
      const before = await readFile(file);
      const outputs = [join(migrations, 'manifest.json'), join(directory, 'schema/migration_target/schema.sql')];
      const original = await Promise.all(outputs.map((path) => readFile(path)));
      const legacy = structuredClone(preserved);
      input.change(legacy);
      await writeFile(join(migrations, 'legacy-manifest.json'), JSON.stringify(legacy));
      if (input.future) {
        await writeFile(join(migrations, `${futureVersion}_future.up.sql`), 'CREATE TABLE future_data (value TEXT) STRICT;\n');
        await writeFile(join(migrations, `${futureVersion}_future.down.sql`), 'DROP TABLE future_data;\n');
      }
      const result = spawnSync(process.execPath, [script], { encoding: 'utf8' });
      assert.equal(result.status, input.valid ? 0 : 1, `${input.name}: ${result.error?.message ?? result.stderr}`);
      if (input.valid) {
        const check = spawnSync(process.execPath, [script, '--check'], { encoding: 'utf8' });
        assert.equal(check.status, 0, `${input.name}: ${check.error?.message ?? check.stderr}`);
        assert.deepEqual(await inspectMigrationHistory(file, migrations), {
          databaseVersion: String(current.targetVersion), dirty: false, pending: input.future ? 1 : 0,
        }, input.name);
      } else {
        assert.match(result.stderr, /legacy/i, input.name);
        await assert.rejects(inspectMigrationHistory(file, migrations), /legacy/i, input.name);
        for (const [index, path] of outputs.entries()) assert.deepEqual(await readFile(path), original[index], input.name);
      }
      assert.deepEqual(await readFile(file), before, input.name);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
});
