#!/usr/bin/env node
/**
 * `gods-eye-view` — the same desktop window as `npm start`, from any folder.
 *
 * `npm run shortcut` (npm link) puts this file on PATH as a symlink to the
 * checkout, so the command always opens the checkout it was linked from.
 */
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(
  path.dirname(realpathSync(fileURLToPath(import.meta.url))),
  '..',
);
const require = createRequire(path.join(ROOT, 'package.json'));

let electron;
try {
  // The electron package's main export is the path to its binary.
  electron = require('electron');
} catch {
  console.error(
    `[gods-eye-view] Electron is not installed in ${ROOT}. Run \`npm ci\` there first.`,
  );
  process.exit(1);
}

const child = spawn(electron, [ROOT, ...process.argv.slice(2)], {
  cwd: ROOT,
  stdio: 'inherit',
  // electron/main.js runs the dev server under this Node, as under npm.
  env: { ...process.env, npm_node_execpath: process.execPath },
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
child.once('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
