import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, writeFile, chmod } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve, relative } from 'node:path';
import JSZip from '@excel.js/jszip';
import { buildGuides } from './build-guide.mjs';

const root = resolve(import.meta.dirname, '..');
const config = JSON.parse(await readFile(join(root, 'scripts/release-config.json'), 'utf8'));
const target = config.targets[`${process.platform}-${process.arch}`];
if (!target) throw new Error(`Unsupported build platform: ${process.platform}-${process.arch}`);
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
if (process.env.GITHUB_REF_TYPE === 'tag' && process.env.GITHUB_REF_NAME !== `v${pkg.version}`) throw new Error('Tag and package version differ');
const run = (command, args, options = {}) => execFileSync(command, args, { stdio: 'inherit', ...options });
run(process.execPath, [join(root, 'scripts/migrations-manifest.mjs'), '--check']);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const migrationManifest = await readFile(join(root, 'schema/migrations/manifest.json'));
const targetDatabaseVersion = String(JSON.parse(migrationManifest.toString('utf8')).targetVersion);
const dist = join(root, 'dist');
await mkdir(join(dist, 'cache'), { recursive: true });
const staging = await mkdtemp(join(dist, 'build-'));
const top = join(staging, 'Glorycourse');
const app = process.platform === 'darwin' ? join(top, 'Glorycourse.app/Contents/Resources/app') : top;
await mkdir(app, { recursive: true });
const documents = ['README.md', 'docs/usage.md', 'docs/troubleshooting.md', 'docs/development.md', 'docs/releasing.md', 'docs/contract-decisions.md', 'docs/dependencies.md'];
// Explicit contents keep local data, credentials, work documents, and tests out of the product.
for (const name of ['backend/src', 'frontend', 'schema', 'package.json', 'package-lock.json', ...documents]) {
  await cp(join(root, name), join(app, name), { recursive: true });
}
await mkdir(join(app, 'scripts'), { recursive: true });
for (const name of ['launcher.mjs', 'runtime-paths.mjs']) await cp(join(root, 'scripts', name), join(app, 'scripts', name));
if (!process.env.npm_execpath) throw new Error('Run with npm run package');
run(process.execPath, [process.env.npm_execpath, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: app });

const nodeArchive = join(dist, 'cache', target.nodeArchive);
let nodeBytes;
try { nodeBytes = await readFile(nodeArchive); } catch (error) { if (error.code !== 'ENOENT') throw error; }
if (!nodeBytes || sha256(nodeBytes) !== target.sha256) {
  const response = await fetch(`https://nodejs.org/dist/v${config.nodeVersion}/${target.nodeArchive}`);
  if (!response.ok) throw new Error(`Node download failed: ${response.status}`);
  nodeBytes = Buffer.from(await response.arrayBuffer());
  if (sha256(nodeBytes) !== target.sha256) throw new Error('Node archive checksum mismatch');
  await writeFile(nodeArchive, nodeBytes);
}
const unpack = join(staging, 'node');
await mkdir(unpack);
run('tar', ['-xf', nodeArchive, '-C', unpack]);
const [nodeFolder] = await readdir(unpack);
await mkdir(join(app, 'runtime'));
await cp(join(unpack, nodeFolder, process.platform === 'win32' ? 'node.exe' : 'bin/node'), join(app, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node'));
await cp(join(unpack, nodeFolder, 'LICENSE'), join(app, 'runtime', 'LICENSE'));
if (process.platform !== 'win32') await chmod(join(app, 'runtime/node'), 0o755);

if (process.platform === 'win32' || process.platform === 'linux') {
  const extension = process.platform === 'win32' ? 'cmd' : 'sh';
  const template = await readFile(join(root, `scripts/launchers/${process.platform === 'win32' ? 'windows.cmd' : 'linux.sh'}`), 'utf8');
  for (const [name, action] of [['시작', 'start'], ['종료', 'stop'], ['자료 폴더', 'data']]) {
    const filename = join(top, `${name}.${extension}`);
    const text = template.replaceAll('ACTION', action);
    await writeFile(filename, process.platform === 'win32' ? text.replace(/\r?\n/g, '\r\n') : text.replaceAll('\r\n', '\n'));
    if (process.platform === 'linux') await chmod(filename, 0o755);
  }
} else {
  const contents = join(top, 'Glorycourse.app/Contents');
  await mkdir(join(contents, 'MacOS'));
  await cp(join(root, 'scripts/launchers/macos.sh'), join(contents, 'MacOS/Glorycourse'));
  await chmod(join(contents, 'MacOS/Glorycourse'), 0o755);
  await writeFile(join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>io.github.w00j00ng.glorycourse</string>
<key>CFBundleName</key><string>Glorycourse</string>
<key>CFBundleExecutable</key><string>Glorycourse</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>${pkg.version}</string>
<key>CFBundleVersion</key><string>${pkg.version}</string>
<key>LSUIElement</key><true/>
</dict></plist>\n`);
  for (const name of documents) await cp(join(root, name), join(top, name), { recursive: true });
}

await buildGuides(top);

const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const dirty = Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim());
if (process.env.GITHUB_ACTIONS === 'true' && dirty) throw new Error('Release must be built from a clean checkout');
const info = { version: pkg.version, databaseVersion: targetDatabaseVersion, migrationManifestSha256: sha256(migrationManifest), target: target.name, nodeVersion: config.nodeVersion, nodeSha256: target.sha256, commit, dirty };
await writeFile(join(app, 'release.json'), `${JSON.stringify(info, null, 2)}\n`);
await writeFile(join(app, 'THIRD_PARTY_NOTICES.txt'), 'Node.js: runtime/LICENSE\nProduction dependencies and their license notices: node_modules/<package>/\nThe included package-lock.json records exact dependency versions and integrity values.\n');
const files = {};
const inventory = async (directory) => {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = join(directory, entry.name);
    if (entry.isDirectory()) await inventory(filename);
    else if (entry.isFile()) files[relative(top, filename).replaceAll('\\', '/')] = sha256(await readFile(filename));
  }
};
await inventory(top);
await writeFile(join(top, 'MANIFEST.json'), `${JSON.stringify({ ...info, files }, null, 2)}\n`);
const archive = join(dist, target.archive);
if (process.platform === 'win32') {
  const zip = new JSZip();
  for (const name of [...Object.keys(files), 'MANIFEST.json']) zip.file(`Glorycourse/${name}`, await readFile(join(top, name)));
  await writeFile(archive, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', platform: 'DOS' }));
}
else if (process.platform === 'darwin') run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', top, archive]);
else run('tar', ['-czf', archive, '-C', staging, 'Glorycourse']);
await writeFile(`${archive}.sha256`, `${sha256(await readFile(archive))}  ${target.archive}\n`);
console.log(`Created ${archive}`);
