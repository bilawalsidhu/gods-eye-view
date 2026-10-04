// Child-process entry for the desktop shell: runs the same Vite dev server
// the repository's `npm run dev` runs (provider middleware, in-app key setup,
// live reload of provider settings), bound to loopback only.
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(
  process.env.GEV_PAYLOAD_ROOT ||
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..'),
);
const stateDir = process.env.GEV_STATE_DIR
  ? path.resolve(process.env.GEV_STATE_DIR)
  : root;
const cacheDir = process.env.GEV_CACHE_DIR
  ? path.resolve(process.env.GEV_CACHE_DIR)
  : undefined;
const port = Number.parseInt(process.env.PORT ?? '', 10);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('[GEV] Start refused: no valid PORT supplied.');
  process.exit(2);
}

process.chdir(root);
mkdirSync(stateDir, { recursive: true });

const viteEntry = path.join(
  root,
  'node_modules',
  'vite',
  'dist',
  'node',
  'index.js',
);
if (!existsSync(viteEntry)) {
  console.error(`[GEV] Start refused: Vite is missing at ${viteEntry}`);
  process.exit(2);
}

// The shell owns this process: leave when it goes away.
process.on('disconnect', () => process.exit(0));

const { createServer } = await import(pathToFileURL(viteEntry).href);
const server = await createServer({
  root,
  envDir: stateDir,
  cacheDir,
  clearScreen: false,
  server: { host: '127.0.0.1', port, strictPort: true, open: false },
});
await server.listen();
console.log(`[GEV] Ready at http://127.0.0.1:${port}/`);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    await server.close();
    process.exit(0);
  });
}
