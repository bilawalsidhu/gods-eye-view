import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const [major, minor] = process.versions.node.split('.').map(Number);
if (!((major === 24 && minor >= 14) || major === 26)) {
  console.error(
    'Install Node.js 24.14+ (24.x) or 26.x from https://nodejs.org/, then retry.',
  );
  process.exitCode = 1;
} else if (!existsSync(path.join(root, 'node_modules/vite/bin/vite.js'))) {
  console.error(
    'Dependencies are missing. Run npm ci in this repository, then retry.',
  );
  process.exitCode = 1;
} else {
  const child = spawn(
    process.execPath,
    ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1'],
    { cwd: root, stdio: 'inherit', env: process.env },
  );
  child.on('error', () => {
    console.error('The local app could not start.');
    process.exitCode = 1;
  });
  child.on('exit', (code) => {
    process.exitCode = code ?? 1;
  });
  process.on('SIGINT', () => child.kill('SIGINT'));
  process.on('SIGTERM', () => child.kill('SIGTERM'));
}
