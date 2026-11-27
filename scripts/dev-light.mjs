// Start the dev server without inline sourcemaps (GEV_DEV_LIGHT=1), for
// low-memory machines. Works on any shell; extra arguments go to Vite.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const vite = fileURLToPath(
  new URL('../node_modules/vite/bin/vite.js', import.meta.url),
);
const child = spawn(process.execPath, [vite, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, GEV_DEV_LIGHT: '1' },
});
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => child.kill(signal));
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
