// The agentmonitor app for Windows, as a release has it, built from Electron's program as
// install-electron put it in node_modules: Electron's files, electron.exe named agentmonitor.exe,
// and beside them in resources/app the app (this folder's files but those that build it, and the
// monitor's src/). With RCEDIT, the path of rcedit-x64.exe, the program gets the app's icon and
// name too. Then the folder as a zip, and the zip's SHA-256. node build.js, or npm run build: all
// of it in dist/. The release workflow (.github/workflows/release.yml) runs it on GitHub's
// Windows machines.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, cpSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appIco } from './icons.js';
import { ZipWriter } from './zip.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(here);
/** This folder's files that build the app, and are not in it. */
const BUILD = new Set(['build.js', 'zip.js']);
/** What a Windows program is for, by the Machine field of its header. */
const MACHINES = new Map([[0x8664, 'x64'], [0xaa64, 'arm64'], [0x014c, 'ia32']]);

/** @param {string} line */
const log = (line) => process.stdout.write(`${line}\n`);

/**
 * @param {string} why
 * @returns {never}
 */
function fail(why) {
  process.stderr.write(`build: ${why}\n`);
  process.exit(1);
}

/**
 * What a Windows program is for: x64, arm64 or ia32.
 * @param {string} path
 */
function machineOf(path) {
  const head = Buffer.alloc(4096);
  const fd = openSync(path, 'r');
  try {
    readSync(fd, head, 0, head.length, 0);
  } finally {
    closeSync(fd);
  }
  // Where the PE header is; its signature; then the machine.
  const pe = head.readUInt32LE(0x3c);
  const machine = pe + 6 <= head.length && head.toString('latin1', pe, pe + 4) === 'PE\0\0' ? head.readUInt16LE(pe + 4) : -1;
  return MACHINES.get(machine) ?? fail(`${path} is not a Windows program for x64, arm64 or ia32`);
}

const pkg = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'));
const electron = join(here, 'node_modules', 'electron', 'dist');
if (!existsSync(join(electron, 'electron.exe'))) fail('no Electron for Windows in node_modules/electron/dist: npm install, then npx install-electron, here on Windows');
const arch = machineOf(join(electron, 'electron.exe'));
const name = `agentmonitor-${pkg.version}-win-${arch}`;
const dist = join(here, 'dist');
const out = join(dist, name);
const exe = join(out, 'agentmonitor.exe');
log(`agentmonitor ${pkg.version} for Windows (${arch}), with Electron ${readFileSync(join(electron, 'version'), 'utf8').trim()}`);

// Electron's files, its program renamed, and without the app it shows when it is given none.
rmSync(out, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
cpSync(electron, out, { recursive: true });
renameSync(join(out, 'electron.exe'), exe);
rmSync(join(out, 'resources', 'default_app.asar'), { force: true });

// The app, its files as they are here: desktop/ and src/ side by side, as main.js imports them.
const app = join(out, 'resources', 'app');
mkdirSync(join(app, 'desktop'), { recursive: true });
for (const f of readdirSync(here)) if (f.endsWith('.js') && !BUILD.has(f)) cpSync(join(here, f), join(app, 'desktop', f));
cpSync(join(root, 'src'), join(app, 'src'), { recursive: true });
const license = readFileSync(join(root, 'LICENSE'), 'utf8');
writeFileSync(join(app, 'LICENSE'), license);
const manifest = {
  name: pkg.name, productName: pkg.productName, version: pkg.version, description: pkg.description, license: pkg.license,
  type: 'module', main: 'desktop/main.js',
};
writeFileSync(join(app, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);

// The program's icon and name, where rcedit is at hand; else it keeps Electron's.
const rcedit = process.env.RCEDIT;
if (rcedit) {
  if (!existsSync(rcedit)) fail(`RCEDIT is ${rcedit}, where there is no file`);
  const icon = join(dist, 'agentmonitor.ico');
  writeFileSync(icon, appIco());
  // Windows' versions are numbers alone: 0.2.0 of 0.2.0-beta.1.
  const version = pkg.version.replace(/[-+].*$/, '');
  const copyright = /^Copyright .*$/m.exec(license)?.[0] ?? '';
  const holder = /^Copyright \(c\) \d{4}(?:-\d{4})? (.+)$/m.exec(license)?.[1] ?? '';
  /** @type {Record<string, string>} what Windows shows of the program: Task Manager its description */
  const strings = {
    FileDescription: pkg.productName, ProductName: pkg.productName, InternalName: pkg.productName,
    OriginalFilename: 'agentmonitor.exe', CompanyName: holder, LegalCopyright: copyright,
  };
  execFileSync(rcedit, [
    exe, '--set-icon', icon, '--set-file-version', version, '--set-product-version', version,
    ...Object.entries(strings).flatMap(([k, v]) => ['--set-version-string', k, v]),
  ], { stdio: 'inherit' });
  rmSync(icon);
  log('  agentmonitor.exe: the app\'s icon and name, set with rcedit');
} else {
  log('  agentmonitor.exe keeps Electron\'s icon and name: RCEDIT, the path of rcedit-x64.exe, gives it the app\'s');
}

// The folder as a zip, its files at the top, written as it goes; and its SHA-256.
const zipPath = join(dist, `${name}.zip`);
const sum = createHash('sha256');
const fd = openSync(zipPath, 'w');
try {
  const zip = new ZipWriter((chunk) => {
    for (let at = 0; at < chunk.length;) at += writeSync(fd, chunk, at);
    sum.update(chunk);
  });
  const time = new Date();
  const files = readdirSync(out, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name)).sort();
  for (const f of files) zip.add(relative(out, f).split(sep).join('/'), readFileSync(f), time);
  zip.end();
} finally {
  closeSync(fd);
}
const hash = sum.digest('hex');
writeFileSync(`${zipPath}.sha256`, `${hash}  ${name}.zip\n`);
const mb = (/** @type {string} */ p) => `${(statSync(p).size / 1e6).toFixed(1)} MB`;
log(`  ${relative(here, exe)}`);
log(`  ${relative(here, zipPath)}: ${mb(zipPath)}, SHA-256 ${hash}`);
