// Assemble everything the packaged app ships besides Electron itself:
//   .stage/payload   the application source plus Windows production dependencies
//   .stage/runtime   a pinned Node runtime that executes the local server
// Run from desktop/ (npm run stage). Cross-platform: dependencies are installed
// for win32-x64 regardless of the host.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  createWriteStream,
} from 'node:fs';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(here, '..');
const repo = path.resolve(desktop, '..');
const stage = path.join(desktop, '.stage');
const payload = path.join(stage, 'payload');
const runtime = path.join(stage, 'runtime');
const cache = path.join(desktop, '.cache');

// Must satisfy package.json "engines" (>=24.14.0 <25 || >=26 <27).
const NODE_VERSION = '24.19.0';
const TARGET = { os: 'win32', cpu: 'x64', nodeArch: 'win-x64' };

const APP_FILES = [
  'index.html',
  'style.css',
  'vite.config.js',
  'package.json',
  'LICENSE',
  'THIRD_PARTY_NOTICES.md',
  'SECURITY.md',
];
// scripts/ is imported by the server (key setup, Google server key), so it ships.
const APP_DIRS = ['src', 'server', 'build', 'config', 'public', 'scripts'];
// Runtime dependencies the dev server needs that package.json lists as dev.
const EXTRA_RUNTIME_DEPENDENCIES = ['vite', 'vite-plugin-cesium'];

const log = (message) => console.log(`[stage] ${message}`);

function copyTree(from, to) {
  cpSync(from, to, {
    recursive: true,
    filter: (source) => !/\.test\.(m?js|cjs)$/.test(source),
  });
}

function stagePayload() {
  rmSync(payload, { recursive: true, force: true });
  mkdirSync(payload, { recursive: true });
  for (const file of APP_FILES)
    cpSync(path.join(repo, file), path.join(payload, file));
  for (const dir of APP_DIRS)
    copyTree(path.join(repo, dir), path.join(payload, dir));

  const manifest = JSON.parse(
    readFileSync(path.join(repo, 'package.json'), 'utf8'),
  );
  const devDependencies = manifest.devDependencies ?? {};
  const dependencies = { ...manifest.dependencies };
  for (const name of EXTRA_RUNTIME_DEPENDENCIES) {
    if (!devDependencies[name])
      throw new Error(`Expected devDependency ${name}`);
    dependencies[name] = devDependencies[name];
  }
  delete manifest.devDependencies;
  delete manifest.scripts;
  manifest.dependencies = dependencies;
  writeFileSync(
    path.join(payload, 'package.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  cpSync(
    path.join(repo, 'package-lock.json'),
    path.join(payload, 'package-lock.json'),
  );
  cpSync(
    path.join(desktop, 'runtime', 'serve.mjs'),
    path.join(payload, 'desktop-serve.mjs'),
  );
  log(
    `payload files staged (${Object.keys(dependencies).length} dependencies)`,
  );
}

function installDependencies() {
  log(`installing production dependencies for ${TARGET.os}-${TARGET.cpu}`);
  execFileSync(
    'npm',
    [
      'install',
      '--omit=dev',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      `--os=${TARGET.os}`,
      `--cpu=${TARGET.cpu}`,
    ],
    { cwd: payload, stdio: 'inherit', shell: process.platform === 'win32' },
  );
  for (const required of [
    'node_modules/vite/dist/node/index.js',
    'node_modules/@esbuild/win32-x64',
    'node_modules/@rollup/rollup-win32-x64-msvc',
    'node_modules/cesium',
  ]) {
    if (!existsSync(path.join(payload, required))) {
      throw new Error(`Staged payload is missing ${required}`);
    }
  }
}

async function download(url, file) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  await pipeline(response.body, createWriteStream(file));
}

async function stageRuntime() {
  rmSync(runtime, { recursive: true, force: true });
  mkdirSync(runtime, { recursive: true });
  mkdirSync(cache, { recursive: true });
  const base = `https://nodejs.org/dist/v${NODE_VERSION}`;
  const archive = `node-v${NODE_VERSION}-${TARGET.nodeArch}.zip`;
  const archivePath = path.join(cache, archive);
  const sums = await (await fetch(`${base}/SHASUMS256.txt`)).text();
  const expected = sums
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .find(([, name]) => name === archive)?.[0];
  if (!expected) throw new Error(`No checksum published for ${archive}`);
  const sha = (file) =>
    createHash('sha256').update(readFileSync(file)).digest('hex');
  if (!existsSync(archivePath) || sha(archivePath) !== expected) {
    log(`downloading ${archive}`);
    await download(`${base}/${archive}`, archivePath);
  }
  if (sha(archivePath) !== expected)
    throw new Error(`Checksum mismatch: ${archive}`);
  // bsdtar (Windows, macOS) reads zip archives natively; Linux hosts use unzip.
  const member = `node-v${NODE_VERSION}-${TARGET.nodeArch}/node.exe`;
  if (process.platform === 'linux') {
    execFileSync('unzip', ['-j', '-o', archivePath, member, '-d', runtime]);
  } else {
    execFileSync('tar', [
      '-xf',
      archivePath,
      '-C',
      runtime,
      '--strip-components=1',
      member,
    ]);
  }
  if (!existsSync(path.join(runtime, 'node.exe'))) {
    throw new Error('node.exe was not extracted');
  }
  log(`Node ${NODE_VERSION} runtime staged (sha256 verified)`);
}

stagePayload();
installDependencies();
await stageRuntime();
log('done');
