import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const directory = resolve(import.meta.dirname, '../schema/migrations');
const unsafeSql = /\b(?:BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|VACUUM|ATTACH|DETACH)\b|\bPRAGMA\s+(?:journal_mode|foreign_keys|synchronous|writable_schema)\b|\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|DROP\s+TABLE|ALTER\s+TABLE)\s+schema_migrations\b/i;
const names = (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort();
if (!names.length || names.some((name) => !/^[1-9]\d{9}_[a-z][a-z0-9_]*\.sql$/.test(name))) {
  throw new Error('Migration filenames must use Unix seconds: 1234567890_description.sql');
}
if (new Set(names.map((name) => name.slice(0, 10))).size !== names.length) throw new Error('Duplicate migration version');
const migrations = [];
for (const name of names) {
  const bytes = await readFile(join(directory, name));
  if (!bytes.length || bytes[0] === 0xef || bytes.includes(13)) throw new Error(`Invalid migration encoding: ${name}`);
  if (unsafeSql.test(bytes.toString('utf8'))) throw new Error(`Unsafe migration transaction or history control: ${name}`);
  migrations.push({ version: Number(name.slice(0, 10)), name, checksum: createHash('sha256').update(bytes).digest('hex') });
}
const text = `${JSON.stringify({ targetVersion: migrations.at(-1).version, migrations }, null, 2)}\n`;
const file = join(directory, 'manifest.json');
if (process.argv.includes('--check')) {
  if (await readFile(file, 'utf8') !== text) throw new Error('Migration manifest differs from SQL files');
} else await writeFile(file, text);
console.log(`${migrations.length} migration(s) verified`);
